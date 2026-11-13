//! Node bindings for packmem. Calls into native code are made per batch, never per field:
//! rows leave as JSON text (parsed by V8 in one call) and filters return row-id arrays.
mod json;
mod load;

use napi::bindgen_prelude::{Buffer, BufferSlice, Uint32Array};
use napi::Env;
use napi::{Error, Result};
use napi_derive::napi;
use packmem::{Cell, DynTable, Hint, Num, Pred};
use serde_json::Value;
use std::cell::RefCell;
use std::fs::File;
use std::io::{BufRead, BufReader};

fn err(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

fn hint_of(h: Option<String>) -> Result<Hint> {
    match h.as_deref().unwrap_or("balanced") {
        "memory" => Ok(Hint::Memory),
        "balanced" => Ok(Hint::Balanced),
        "speed" => Ok(Hint::Speed),
        _ => Err(err("hint must be 'memory', 'balanced' or 'speed'")),
    }
}

fn num(v: &Value) -> Result<f64> {
    match v.as_str() {
        Some("Infinity") => Ok(f64::INFINITY),
        Some("-Infinity") => Ok(f64::NEG_INFINITY),
        _ => v
            .as_f64()
            .filter(|f| !f.is_nan())
            .ok_or_else(|| err(format!("expected a number, got {v}"))),
    }
}

fn pred(op: &str, v: &Value) -> Result<Pred> {
    let inf = f64::INFINITY;
    let range = |lo, hi, lo_incl, hi_incl| Pred::Range {
        lo,
        hi,
        lo_incl,
        hi_incl,
    };
    Ok(match op {
        "eq" => Pred::Eq(load::value_cell(v)),
        "prefix" => Pred::Prefix(v.as_str().ok_or_else(|| err("prefix needs a string"))?.into()),
        "contains" => {
            Pred::Contains(v.as_str().ok_or_else(|| err("contains needs a string"))?.into())
        }
        "gt" => range(num(v)?, inf, false, true),
        "gte" => range(num(v)?, inf, true, true),
        "lt" => range(-inf, num(v)?, true, false),
        "lte" => range(-inf, num(v)?, true, true),
        "between" => match v.as_array().map(|a| a.as_slice()) {
            Some([lo, hi]) => range(num(lo)?, num(hi)?, true, true),
            _ => return Err(err("between needs [low, high]")),
        },
        _ => return Err(err(format!("unknown filter '{op}'"))),
    })
}

fn intersect(a: &[u32], b: &[u32]) -> Vec<u32> {
    let (mut i, mut j, mut o) = (0, 0, Vec::with_capacity(a.len().min(b.len())));
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            o.push(a[i]);
            i += 1;
            j += 1
        } else if a[i] < b[j] {
            i += 1
        } else {
            j += 1
        }
    }
    o
}

fn num_out(n: Num) -> f64 {
    match n {
        Num::Int(i) => i as f64,
        Num::Float(f) => f,
    }
}

#[napi(js_name = "NativeTable")]
pub struct NativeTable {
    t: DynTable,
    /// Reused output buffer for JSON. Results are copied into memory V8 owns, so the GC sees their size and native memory stays flat.
    scratch: RefCell<Vec<u8>>,
    /// Nesting depth of bulk loads; rows are packed only when the outermost one ends.
    bulk_depth: u32,
}

#[napi]
impl NativeTable {
    #[napi(constructor)]
    pub fn new(hint: Option<String>) -> Result<Self> {
        Ok(NativeTable {
            t: DynTable::new(hint_of(hint)?),
            scratch: RefCell::new(Vec::new()),
            bulk_depth: 0,
        })
    }

    #[napi(getter)]
    pub fn length(&self) -> u32 {
        self.t.len() as u32
    }

    #[napi]
    pub fn names(&self) -> Vec<String> {
        self.t.names().to_vec()
    }

    fn bulk<T>(&mut self, f: impl FnOnce(&mut DynTable) -> std::result::Result<T, String>) -> Result<T> {
        self.begin_bulk();
        let r = f(&mut self.t);
        self.end_bulk();
        r.map_err(err)
    }

    /// Start a load made of several calls: open chunks are not re-packed between them. Pair with `endBulk`.
    #[napi]
    pub fn begin_bulk(&mut self) {
        if self.bulk_depth == 0 {
            self.t.set_bulk(true)
        }
        self.bulk_depth += 1
    }

    #[napi]
    pub fn end_bulk(&mut self) {
        if self.bulk_depth == 0 {
            return;
        }
        self.bulk_depth -= 1;
        if self.bulk_depth == 0 {
            self.t.set_bulk(false)
        }
    }

    /// Load a JSON-lines file without holding it in memory.
    #[napi]
    pub fn load_jsonl_path(&mut self, path: String) -> Result<u32> {
        let f = File::open(&path).map_err(|e| err(format!("{path}: {e}")))?;
        self.bulk(|t| {
            let mut n = 0;
            for (i, line) in BufReader::with_capacity(1 << 20, f).lines().enumerate() {
                let line = line.map_err(|e| e.to_string())?;
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                load::push_line(t, line).map_err(|e| format!("{path}:{}: {e}", i + 1))?;
                n += 1
            }
            Ok(n)
        })
    }

    /// Load a file holding one JSON array of records, streamed.
    #[napi]
    pub fn load_json_array_path(&mut self, path: String) -> Result<u32> {
        let f = File::open(&path).map_err(|e| err(format!("{path}: {e}")))?;
        self.bulk(|t| load::push_array(t, BufReader::with_capacity(1 << 20, f)))
            .map(|n| n as u32)
    }

    /// Append JSON-lines text (one record per line).
    #[napi]
    pub fn push_jsonl(&mut self, text: String) -> Result<u32> {
        self.bulk(|t| load::push_lines(t, &text)).map(|n| n as u32)
    }

    /// Append records from a buffer of JSON lines.
    #[napi]
    pub fn push_jsonl_buffer(&mut self, buf: Buffer) -> Result<u32> {
        let text = std::str::from_utf8(&buf).map_err(err)?;
        self.bulk(|t| load::push_lines(t, text)).map(|n| n as u32)
    }

    /// Append records from a buffer holding one JSON array.
    #[napi]
    pub fn push_json_array_buffer(&mut self, buf: Buffer) -> Result<u32> {
        self.bulk(|t| load::push_array(t, &buf[..])).map(|n| n as u32)
    }

    /// Append rows given as JSON arrays (one per line) whose values follow `names`.
    #[napi]
    pub fn push_arrays_jsonl(&mut self, names: Vec<String>, text: String) -> Result<u32> {
        self.bulk(|t| load::push_array_lines(t, &names, &text)).map(|n| n as u32)
    }

    /// Append one record given as JSON text.
    #[napi]
    pub fn push_json(&mut self, text: String) -> Result<()> {
        load::push_line(&mut self.t, &text).map_err(err)
    }

    /// Set one field of a row. `json` is the value as JSON text; `undefined` removes the key.
    #[napi]
    pub fn set_json(&mut self, row: u32, name: String, json: Option<String>) -> Result<()> {
        self.check(row)?;
        let cell = match json {
            None => Cell::Missing,
            Some(s) => load::raw_cell(&s).map_err(err)?,
        };
        self.t.set_by_name(row as usize, &name, cell);
        Ok(())
    }

    /// Replace a whole row: keys not given become missing.
    #[napi]
    pub fn set_row_json(&mut self, row: u32, text: String) -> Result<()> {
        self.check(row)?;
        let cells = load::field_cells(&text).map_err(err)?;
        for c in 0..self.t.names().len() {
            let name = self.t.names()[c].clone();
            if !cells.iter().any(|(k, _)| *k == name) {
                self.t.set(row as usize, c, Cell::Missing)
            }
        }
        for (k, cell) in cells {
            self.t.set_by_name(row as usize, &k, cell)
        }
        Ok(())
    }

    /// Row ids from JavaScript must be in range before they reach the core, which indexes without checks.
    fn check_ids(&self, ids: &[u32]) -> Result<()> {
        let n = self.t.len();
        match ids.iter().find(|&&i| i as usize >= n) {
            Some(i) => Err(err(format!("row id {i} out of range (length {n})"))),
            None => Ok(()),
        }
    }

    /// Drop every row from `len` on. Used to undo an append that failed part-way; rebuilds the table.
    #[napi]
    pub fn truncate(&mut self, len: u32) {
        let len = (len as usize).min(self.t.len());
        if len == self.t.len() {
            return;
        }
        let keep: Vec<u32> = (0..len as u32).collect();
        self.t = self.t.take(&keep);
        if self.bulk_depth > 0 {
            self.t.set_bulk(true)
        }
    }

    /// Set and remove fields of one row as a unit: everything is parsed before anything is written.
    #[napi]
    pub fn update_json(&mut self, row: u32, set: String, remove: Vec<String>) -> Result<()> {
        self.check(row)?;
        // fields kept as raw JSON, so a string the loader can store (a lone surrogate, for one) is not rejected here
        let cells = load::field_cells(&set).map_err(err)?;
        for (k, c) in cells {
            self.t.set_by_name(row as usize, &k, c)
        }
        for k in remove {
            if let Some(c) = self.t.col_index(&k) {
                self.t.set(row as usize, c, Cell::Missing)
            }
        }
        Ok(())
    }

    fn check(&self, row: u32) -> Result<()> {
        if (row as usize) < self.t.len() {
            Ok(())
        } else {
            Err(err(format!("row {row} out of range (length {})", self.t.len())))
        }
    }

    fn with_json<T>(&self, fill: impl FnOnce(&DynTable, &mut Vec<u8>), take: impl FnOnce(&[u8]) -> Result<T>) -> Result<T> {
        let mut buf = self.scratch.borrow_mut();
        fill(&self.t, &mut buf);
        let r = take(&buf);
        if buf.capacity() > 8 << 20 {
            *buf = Vec::new()
        }
        r
    }

    /// Rows `a..b` as JSON text of an array.
    #[napi]
    pub fn json_range(&self, a: u32, b: u32) -> Result<String> {
        self.with_json(
            |t, o| json::range(t, a as usize, b as usize, o),
            |b| std::str::from_utf8(b).map(str::to_owned).map_err(err),
        )
    }

    /// Rows with these ids as JSON text of an array.
    #[napi]
    pub fn json_at(&self, ids: Uint32Array) -> Result<String> {
        self.check_ids(&ids)?;
        self.with_json(|t, o| json::at(t, &ids, o), |b| std::str::from_utf8(b).map(str::to_owned).map_err(err))
    }

    /// Rows `a..b` as UTF-8 JSON bytes, for writing to a response without a JS string.
    #[napi]
    pub fn json_range_buffer<'e>(&self, env: &'e Env, a: u32, b: u32) -> Result<BufferSlice<'e>> {
        self.with_json(|t, o| json::range(t, a as usize, b as usize, o), |b| BufferSlice::copy_from(env, b))
    }

    #[napi]
    pub fn json_at_buffer<'e>(&self, env: &'e Env, ids: Uint32Array) -> Result<BufferSlice<'e>> {
        self.check_ids(&ids)?;
        self.with_json(|t, o| json::at(t, &ids, o), |b| BufferSlice::copy_from(env, b))
    }

    /// Row ids matching every filter. `spec` is JSON: `[[column, op, value], ...]`. With `within`, only those rows are kept.
    #[napi]
    pub fn select(&self, spec: String, within: Option<Uint32Array>) -> Result<Uint32Array> {
        let spec: Vec<(String, String, Value)> = serde_json::from_str(&spec).map_err(err)?;
        if let Some(w) = within.as_deref() {
            self.check_ids(w)?;
            if w.windows(2).any(|p| p[0] >= p[1]) {
                return Err(err("row ids must be strictly increasing"));
            }
        }
        let mut ids: Option<Vec<u32>> = within.map(|w| w.to_vec());
        for (col, op, v) in &spec {
            let p = pred(op, v)?;
            let hit = match self.t.col_index(col) {
                Some(c) => self.t.select(c, &p),
                None => vec![],
            };
            ids = Some(match ids {
                None => hit,
                Some(prev) => intersect(&prev, &hit),
            });
            if ids.as_ref().is_some_and(|i| i.is_empty()) {
                break;
            }
        }
        Ok(Uint32Array::new(
            ids.unwrap_or_else(|| (0..self.t.len() as u32).collect()),
        ))
    }

    #[napi]
    pub fn sum(&self, name: String, ids: Option<Uint32Array>) -> Result<f64> {
        if let Some(ids) = ids.as_deref() {
            self.check_ids(ids)?
        }
        Ok(match self.t.col_index(&name) {
            Some(c) => num_out(self.t.sum(c, ids.as_deref())),
            None => 0.0,
        })
    }

    /// GROUP BY value, count. JSON text of `[[value, count], ...]`; rows without the key are left out.
    #[napi]
    pub fn group_count(&self, name: String, ids: Option<Uint32Array>) -> Result<String> {
        if let Some(ids) = ids.as_deref() {
            self.check_ids(ids)?
        }
        let Some(c) = self.t.col_index(&name) else {
            return Ok("[]".into());
        };
        let groups = self.t.group_count(c, ids.as_deref());
        let mut out = String::from("[");
        let mut first = true;
        for (k, n) in groups {
            let v = match k {
                Cell::Missing => continue,
                Cell::Null => "null".to_string(),
                Cell::Bool(b) => b.to_string(),
                Cell::Int(i) => i.to_string(),
                Cell::Float(f) => json::js_number(f),
                Cell::Str(s) => serde_json::to_string(&s).unwrap(),
                Cell::Json(s) => s,
            };
            if !first {
                out.push(',')
            }
            first = false;
            out.push('[');
            out.push_str(&v);
            out.push(',');
            out.push_str(&n.to_string());
            out.push(']')
        }
        out.push(']');
        Ok(out)
    }

    /// One column as JSON text of an array (`undefined` for missing keys becomes null).
    #[napi]
    pub fn column_json(&self, name: String, ids: Option<Uint32Array>) -> Result<String> {
        if let Some(ids) = ids.as_deref() {
            self.check_ids(ids)?
        }
        let Some(c) = self.t.col_index(&name) else {
            return Ok("[]".into());
        };
        let cell = |i: usize| match self.t.get(i, c) {
            Cell::Missing | Cell::Null => "null".to_string(),
            Cell::Bool(b) => b.to_string(),
            Cell::Int(i) => i.to_string(),
            Cell::Float(f) => json::js_number(f),
            Cell::Str(s) => serde_json::to_string(&s).unwrap(),
            Cell::Json(s) => s,
        };
        let parts: Vec<String> = match ids.as_deref() {
            Some(ids) => ids.iter().map(|&i| cell(i as usize)).collect(),
            None => (0..self.t.len()).map(cell).collect(),
        };
        Ok(format!("[{}]", parts.join(",")))
    }

    #[napi]
    pub fn compact(&mut self) {
        self.t.compact()
    }

    /// Approximate bytes held by the packed columns and the uncompressed tail.
    #[napi]
    pub fn nbytes(&self) -> f64 {
        self.t.bytes() as f64
    }

    /// Per column: name, encodings used, packed bytes. JSON text.
    #[napi]
    pub fn describe(&self) -> String {
        serde_json::to_string(&self.t.describe()).unwrap()
    }
}
