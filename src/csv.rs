//! CSV and TSV straight into a DynTable, fed in chunks so a stream (a file, Postgres `COPY ... TO STDOUT`) never has to
//! be held whole. RFC 4180 quoting: fields in double quotes may contain the delimiter, line breaks and `""` for a quote.
use crate::{Cell, DynTable};

/// How a field's text becomes a value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ColType {
    /// Integers, then decimals, else text. Integers with a leading zero ("007") stay text, so codes keep their zeros.
    Infer,
    Text,
    Int,
    Float,
    /// `t`, `true`, `1` and `f`, `false`, `0` (any case).
    Bool,
    /// JSON text, stored as a nested value.
    Json,
}

#[derive(Clone, Debug)]
pub struct CsvOptions {
    pub delimiter: u8,
    /// Take column names from the first row; otherwise `names` must be given.
    pub header: bool,
    pub names: Vec<String>,
    /// Per column, by position; columns beyond the list use `Infer`.
    pub types: Vec<ColType>,
    /// An unquoted empty field is null (Postgres `COPY` CSV, where a quoted `""` is the empty string); otherwise it is
    /// the empty string, as Python's csv module reads it.
    pub empty_is_null: bool,
}

impl Default for CsvOptions {
    fn default() -> Self {
        CsvOptions {
            delimiter: b',',
            header: true,
            names: vec![],
            types: vec![],
            empty_is_null: false,
        }
    }
}

/// Parser state carried between chunks.
pub struct CsvLoader {
    opts: CsvOptions,
    names: Option<Vec<String>>,
    field: Vec<u8>,
    fields: Vec<(Vec<u8>, bool)>,
    in_quotes: bool,
    quote_seen: bool,
    was_quoted: bool,
    line: usize,
    rows: usize,
    pending_cr: bool,
}

fn infer(text: &str) -> Cell {
    let b = text.as_bytes();
    let digits = |s: &[u8]| !s.is_empty() && s.iter().all(|c| c.is_ascii_digit());
    let (sign, rest) = match b.first() {
        Some(b'-' | b'+') => (true, &b[1..]),
        _ => (false, b),
    };
    if digits(rest) && !(rest.len() > 1 && rest[0] == b'0') && !(sign && rest.is_empty()) {
        if let Ok(i) = text.parse::<i64>() {
            return Cell::Int(i);
        }
    }
    let looks_decimal = !rest.is_empty()
        && rest
            .iter()
            .all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'-' | b'+'))
        && rest.iter().any(|c| c.is_ascii_digit())
        && !(rest.len() > 1 && rest[0] == b'0' && rest[1].is_ascii_digit());
    if looks_decimal {
        if let Ok(f) = text.parse::<f64>() {
            return Cell::Float(f);
        }
    }
    Cell::Str(text.to_string())
}

fn convert(text: &str, ty: ColType) -> Result<Cell, String> {
    Ok(match ty {
        ColType::Infer => infer(text),
        ColType::Text => Cell::Str(text.to_string()),
        ColType::Int => match text.parse::<i64>() {
            Ok(i) => Cell::Int(i),
            Err(_) => {
                let digits = text.strip_prefix('-').unwrap_or(text);
                if !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit()) {
                    Cell::Json(text.to_string()) // beyond 64 bits: kept exact as number text
                } else {
                    return Err(format!("not an integer: {text:?}"));
                }
            }
        },
        ColType::Float => match text {
            "NaN" => Cell::Float(f64::NAN),
            "Infinity" => Cell::Float(f64::INFINITY),
            "-Infinity" => Cell::Float(f64::NEG_INFINITY),
            _ => Cell::Float(
                text.parse::<f64>()
                    .map_err(|_| format!("not a number: {text:?}"))?,
            ),
        },
        ColType::Bool => match text.to_ascii_lowercase().as_str() {
            "t" | "true" | "1" => Cell::Bool(true),
            "f" | "false" | "0" => Cell::Bool(false),
            _ => return Err(format!("not a boolean: {text:?}")),
        },
        ColType::Json => {
            let v: serde_json::Value =
                serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
            Cell::Json(v.to_string())
        }
    })
}

impl CsvLoader {
    pub fn new(opts: CsvOptions) -> Result<Self, String> {
        let names = if opts.header {
            None
        } else if opts.names.is_empty() {
            return Err("CSV without a header row needs column names".into());
        } else {
            Some(opts.names.clone())
        };
        Ok(CsvLoader {
            opts,
            names,
            field: Vec::new(),
            fields: Vec::new(),
            in_quotes: false,
            quote_seen: false,
            was_quoted: false,
            line: 1,
            rows: 0,
            pending_cr: false,
        })
    }

    /// Rows added so far.
    pub fn rows(&self) -> usize {
        self.rows
    }

    fn end_field(&mut self) {
        let f = std::mem::take(&mut self.field);
        self.fields.push((f, self.was_quoted));
        self.was_quoted = false;
        self.quote_seen = false;
    }

    fn end_row(&mut self, t: &mut DynTable) -> Result<(), String> {
        self.end_field();
        let fields = std::mem::take(&mut self.fields);
        // a blank line between rows is skipped
        if fields.len() == 1 && fields[0].0.is_empty() && !fields[0].1 {
            return Ok(());
        }
        let line = self.line;
        let Some(names) = &self.names else {
            let names = fields
                .into_iter()
                .map(|(f, _)| {
                    String::from_utf8(f).map_err(|_| format!("line {line}: header is not UTF-8"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            self.names = Some(names);
            return Ok(());
        };
        if fields.len() != names.len() {
            return Err(format!(
                "line {line}: {} fields for {} columns",
                fields.len(),
                names.len()
            ));
        }
        let names = names.clone();
        let add = || -> Result<(), String> {
            for (i, ((raw, quoted), name)) in fields.into_iter().zip(&names).enumerate() {
                let c = t.col_for(name);
                let ty = self.opts.types.get(i).copied().unwrap_or(ColType::Infer);
                // an empty field is null where nulls are unquoted-empty (Postgres), and in any typed non-text column,
                // where it cannot be a number, a boolean or JSON
                let typed = matches!(
                    ty,
                    ColType::Int | ColType::Float | ColType::Bool | ColType::Json
                );
                if raw.is_empty() && ((!quoted && self.opts.empty_is_null) || typed) {
                    t.put_at(c, Cell::Null);
                    continue;
                }
                let text = std::str::from_utf8(&raw)
                    .map_err(|_| format!("line {line}, column {name}: not UTF-8"))?;
                match ty {
                    ColType::Text => t.put_str_at(c, text),
                    ty => match convert(text, ty)
                        .map_err(|e| format!("line {line}, column {name}: {e}"))?
                    {
                        Cell::Str(s) => t.put_str_at(c, &s),
                        cell => t.put_at(c, cell),
                    },
                }
            }
            Ok(())
        };
        match add() {
            Ok(()) => {
                t.end_row();
                self.rows += 1;
                Ok(())
            }
            Err(e) => {
                t.abort_row();
                Err(e)
            }
        }
    }

    /// Parse the next chunk; rows completed in it are appended to `t`.
    pub fn feed(&mut self, t: &mut DynTable, chunk: &[u8]) -> Result<(), String> {
        let d = self.opts.delimiter;
        for &b in chunk {
            if self.pending_cr {
                self.pending_cr = false;
                if b == b'\n' {
                    continue; // CRLF already ended the row
                }
            }
            if self.in_quotes {
                if b == b'"' {
                    self.in_quotes = false;
                    self.quote_seen = true;
                } else {
                    if b == b'\n' {
                        self.line += 1
                    }
                    self.field.push(b)
                }
                continue;
            }
            match b {
                b'"' if self.quote_seen => {
                    // "" inside a quoted field: a literal quote, and the field continues quoted
                    self.field.push(b'"');
                    self.in_quotes = true;
                    self.quote_seen = false;
                }
                b'"' if self.field.is_empty() && !self.was_quoted => {
                    self.in_quotes = true;
                    self.was_quoted = true;
                }
                _ if b == d => self.end_field(),
                b'\n' | b'\r' => {
                    self.end_row(t)?;
                    self.line += 1;
                    self.pending_cr = b == b'\r';
                }
                _ => {
                    self.quote_seen = false;
                    self.field.push(b)
                }
            }
        }
        Ok(())
    }

    /// End of input: a last row without a trailing newline is added.
    pub fn finish(&mut self, t: &mut DynTable) -> Result<usize, String> {
        if self.in_quotes {
            return Err(format!("line {}: unterminated quoted field", self.line));
        }
        if !self.field.is_empty() || !self.fields.is_empty() || self.was_quoted {
            self.end_row(t)?;
        }
        Ok(self.rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Hint;

    fn load(text: &str, opts: CsvOptions, chunk: usize) -> Result<DynTable, String> {
        let mut t = DynTable::new(Hint::Balanced);
        let mut l = CsvLoader::new(opts)?;
        for c in text.as_bytes().chunks(chunk) {
            l.feed(&mut t, c)?;
        }
        l.finish(&mut t)?;
        Ok(t)
    }

    #[test]
    fn quoting_types_and_chunk_boundaries() {
        let text = "id,name,score,zip,note\r\n1,\"Smith, J\",9.5,007,\"said \"\"hi\"\"\nthen left\"\r\n2,Lee,,10115,\n-3,\"\",1e3,0,x";
        for chunk in [1, 2, 3, 7, 64, 4096] {
            let t = load(text, CsvOptions::default(), chunk).unwrap();
            assert_eq!(t.len(), 3, "chunk {chunk}");
            let c = |n: &str| t.col_index(n).unwrap();
            assert_eq!(t.get(0, c("name")), Cell::Str("Smith, J".into()));
            assert_eq!(
                t.get(0, c("note")),
                Cell::Str("said \"hi\"\nthen left".into())
            );
            assert_eq!(t.get(0, c("zip")), Cell::Str("007".into()));
            assert_eq!(t.get(0, c("score")), Cell::Float(9.5));
            assert_eq!(t.get(1, c("score")), Cell::Str(String::new()));
            assert_eq!(t.get(2, c("id")), Cell::Int(-3));
            assert_eq!(t.get(2, c("score")), Cell::Float(1000.0));
            assert_eq!(t.get(2, c("zip")), Cell::Int(0));
        }
    }

    #[test]
    fn postgres_nulls_and_types() {
        let opts = CsvOptions {
            empty_is_null: true,
            types: vec![
                ColType::Int,
                ColType::Text,
                ColType::Bool,
                ColType::Json,
                ColType::Int,
            ],
            ..Default::default()
        };
        let t = load(
            "a,b,c,d,e\n1,,t,\"{\"\"k\"\": [1, 2]}\",99999999999999999999\n2,\"\",f,null,3\n",
            opts,
            5,
        )
        .unwrap();
        let c = |n: &str| t.col_index(n).unwrap();
        assert_eq!(t.get(0, c("b")), Cell::Null);
        assert_eq!(t.get(1, c("b")), Cell::Str(String::new()));
        assert_eq!(t.get(0, c("c")), Cell::Bool(true));
        assert_eq!(t.get(0, c("d")), Cell::Json("{\"k\":[1,2]}".into()));
        assert_eq!(t.get(0, c("e")), Cell::Json("99999999999999999999".into()));
        // an empty field in a typed column is null even when empty fields are otherwise strings
        let typed = CsvOptions {
            types: vec![ColType::Float, ColType::Text],
            ..Default::default()
        };
        let t = load("x,y\n,\n1.5,a\n", typed, 4).unwrap();
        assert_eq!(t.get(0, 0), Cell::Null);
        assert_eq!(t.get(0, 1), Cell::Str(String::new()));
    }

    #[test]
    fn errors_name_the_line_and_leave_no_partial_row() {
        let mut t = DynTable::new(Hint::Balanced);
        let mut l = CsvLoader::new(CsvOptions::default()).unwrap();
        let e = l.feed(&mut t, b"a,b\n1,2\n3\n").unwrap_err();
        assert!(e.contains("line 3"), "{e}");
        assert_eq!(t.len(), 1);
        let mut l = CsvLoader::new(CsvOptions::default()).unwrap();
        let mut t = DynTable::new(Hint::Balanced);
        l.feed(&mut t, b"a\n\"open").unwrap();
        assert!(l.finish(&mut t).unwrap_err().contains("unterminated"));
        let tsv = CsvOptions {
            delimiter: b'\t',
            header: false,
            names: vec!["x".into(), "y".into()],
            ..Default::default()
        };
        let t = load("1\ta b\n2\tc", tsv, 3).unwrap();
        assert_eq!(t.len(), 2);
        assert_eq!(t.get(1, 1), Cell::Str("c".into()));
    }
}
