//! JSON straight into columns, with no object per record. Same approach as the Python binding's loader.
use packmem::{Cell, DynTable};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;
use serde_json::Value;
use std::marker::PhantomData;

pub trait Raw<'de>: serde::Deserialize<'de> {
    fn text(&self) -> &str;
}
impl<'de> Raw<'de> for &'de RawValue {
    fn text(&self) -> &str {
        self.get()
    }
}
impl<'de> Raw<'de> for Box<RawValue> {
    fn text(&self) -> &str {
        self.get()
    }
}

/// One JSON value from its source text. Integers beyond 64 bits stay exact as JSON text.
pub fn raw_cell(t: &str) -> Result<Cell, String> {
    let b = t.as_bytes();
    Ok(match b.first() {
        None => Cell::Missing,
        Some(b'"') if b.len() < 2 || b[b.len() - 1] != b'"' => return Err(format!("not a JSON value: {t}")),
        Some(b'"') => {
            if !b.contains(&b'\\') {
                Cell::Str(t[1..t.len() - 1].to_string())
            } else {
                Cell::Str(serde_json::from_str(t).map_err(|e| e.to_string())?)
            }
        }
        Some(b'n') => Cell::Null,
        Some(b't') => Cell::Bool(true),
        Some(b'f') => Cell::Bool(false),
        Some(b'[' | b'{') => Cell::Json(
            serde_json::from_str::<Value>(t)
                .map_err(|e| e.to_string())?
                .to_string(),
        ),
        _ => {
            if !b.iter().any(|c| matches!(c, b'.' | b'e' | b'E')) {
                match t.parse::<i64>() {
                    Ok(i) => Cell::Int(i),
                    Err(_) => Cell::Json(t.to_string()),
                }
            } else {
                Cell::Float(t.parse::<f64>().unwrap_or(f64::NAN))
            }
        }
    })
}

struct KeySeed<'a>(&'a mut DynTable);
impl<'de> DeserializeSeed<'de> for KeySeed<'_> {
    type Value = usize;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<usize, D::Error> {
        d.deserialize_str(self)
    }
}
impl<'de> Visitor<'de> for KeySeed<'_> {
    type Value = usize;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a key")
    }
    fn visit_str<E: serde::de::Error>(self, k: &str) -> Result<usize, E> {
        Ok(self.0.col_for(k))
    }
}

struct RowSeed<'a, R>(&'a mut DynTable, PhantomData<R>);
impl<'de, R: Raw<'de>> DeserializeSeed<'de> for RowSeed<'_, R> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de, R: Raw<'de>> Visitor<'de> for RowSeed<'_, R> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON object for each record")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<(), A::Error> {
        let t = self.0;
        while let Some(c) = m.next_key_seed(KeySeed(&mut *t))? {
            let r: R = m.next_value()?;
            let x = r.text();
            let b = x.as_bytes();
            if b[0] == b'"' && !b.contains(&b'\\') {
                t.put_str_at(c, &x[1..x.len() - 1])
            } else {
                t.put_at(c, raw_cell(x).map_err(serde::de::Error::custom)?)
            }
        }
        Ok(())
    }
}

pub fn push_line(t: &mut DynTable, line: &str) -> Result<(), String> {
    let mut de = serde_json::Deserializer::from_str(line);
    match RowSeed::<&RawValue>(&mut *t, PhantomData)
        .deserialize(&mut de)
        .and_then(|_| de.end())
    {
        Ok(()) => {
            t.end_row();
            Ok(())
        }
        Err(e) => {
            t.abort_row();
            Err(e.to_string())
        }
    }
}

/// JSON lines from text; blank lines are skipped. Returns rows added.
pub fn push_lines(t: &mut DynTable, text: &str) -> Result<usize, String> {
    let mut n = 0;
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        push_line(t, line).map_err(|e| format!("line {}: {e}", i + 1))?;
        n += 1
    }
    Ok(n)
}

struct ArraySink<'a>(&'a mut DynTable);
impl<'de> DeserializeSeed<'de> for ArraySink<'_> {
    type Value = usize;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<usize, D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for ArraySink<'_> {
    type Value = usize;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON array of objects")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<usize, A::Error> {
        let t = self.0;
        let mut n = 0;
        loop {
            match seq.next_element_seed(RowSeed::<Box<RawValue>>(&mut *t, PhantomData)) {
                Ok(Some(())) => {
                    t.end_row();
                    n += 1
                }
                Ok(None) => return Ok(n),
                Err(e) => {
                    t.abort_row();
                    return Err(e);
                }
            }
        }
    }
}

/// A JSON array of records, streamed from a reader.
pub fn push_array<R: std::io::Read>(t: &mut DynTable, r: R) -> Result<usize, String> {
    let mut de = serde_json::Deserializer::from_reader(r);
    let n = ArraySink(t).deserialize(&mut de).map_err(|e| e.to_string())?;
    de.end().map_err(|e| e.to_string())?;
    Ok(n)
}

/// A filter value from JSON, typed the way the loader types record values.
pub fn value_cell(v: &Value) -> Cell {
    match v {
        Value::Null => Cell::Null,
        Value::Bool(b) => Cell::Bool(*b),
        Value::Number(n) => raw_cell(&n.to_string()).unwrap_or(Cell::Null),
        Value::String(s) => Cell::Str(s.clone()),
        other => Cell::Json(other.to_string()),
    }
}

/// Rows as JSON arrays, one per line, in the order of `names` (a database driver's array row mode).
pub fn push_array_lines(t: &mut DynTable, names: &[String], text: &str) -> Result<usize, String> {
    let mut n = 0;
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let vals: Vec<&RawValue> = serde_json::from_str(line).map_err(|e| format!("row {}: {e}", i + 1))?;
        if vals.len() != names.len() {
            return Err(format!("row {}: {} values for {} columns", i + 1, vals.len(), names.len()));
        }
        let mut row = || -> Result<(), String> {
            for (name, v) in names.iter().zip(&vals) {
                let c = t.col_for(name);
                let x = v.get();
                let b = x.as_bytes();
                if b[0] == b'"' && !b.contains(&b'\\') {
                    t.put_str_at(c, &x[1..x.len() - 1])
                } else {
                    t.put_at(c, raw_cell(x)?)
                }
            }
            Ok(())
        };
        match row() {
            Ok(()) => t.end_row(),
            Err(e) => {
                t.abort_row();
                return Err(format!("row {}: {e}", i + 1));
            }
        }
        n += 1
    }
    Ok(n)
}
