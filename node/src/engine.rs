//! The table operations behind the JavaScript API, independent of how they are exposed. The Node addon (napi) and the
//! WebAssembly build (wasm-bindgen) are thin wrappers over this, so the two cannot drift apart.
use crate::{json, load};
use packmem::csv::{ColType, CsvLoader, CsvOptions};
use packmem::{Cell, DynTable, Hint, Num, Pred};
use serde_json::Value;

pub type Res<T> = Result<T, String>;

pub fn hint_of(h: Option<&str>) -> Res<Hint> {
    match h.unwrap_or("balanced") {
        "memory" => Ok(Hint::Memory),
        "balanced" => Ok(Hint::Balanced),
        "speed" => Ok(Hint::Speed),
        _ => Err("hint must be 'memory', 'balanced' or 'speed'".into()),
    }
}

fn num(v: &Value) -> Res<f64> {
    match v.as_str() {
        Some("Infinity") => Ok(f64::INFINITY),
        Some("-Infinity") => Ok(f64::NEG_INFINITY),
        _ => v.as_f64().filter(|f| !f.is_nan()).ok_or_else(|| format!("expected a number, got {v}")),
    }
}

fn pred(op: &str, v: &Value) -> Res<Pred> {
    let inf = f64::INFINITY;
    let range = |lo, hi, lo_incl, hi_incl| Pred::Range { lo, hi, lo_incl, hi_incl };
    Ok(match op {
        "eq" => Pred::Eq(load::value_cell(v)),
        "prefix" => Pred::Prefix(v.as_str().ok_or("prefix needs a string")?.into()),
        "contains" => Pred::Contains(v.as_str().ok_or("contains needs a string")?.into()),
        "gt" => range(num(v)?, inf, false, true),
        "gte" => range(num(v)?, inf, true, true),
        "lt" => range(-inf, num(v)?, true, false),
        "lte" => range(-inf, num(v)?, true, true),
        "between" => match v.as_array().map(|a| a.as_slice()) {
            Some([lo, hi]) => range(num(lo)?, num(hi)?, true, true),
            _ => return Err("between needs [low, high]".into()),
        },
        _ => return Err(format!("unknown filter '{op}'")),
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

/// One value as JSON text, numbers as JavaScript writes them.
fn cell_json(c: Cell) -> Option<String> {
    Some(match c {
        Cell::Missing => return None,
        Cell::Null => "null".into(),
        Cell::Bool(b) => b.to_string(),
        Cell::Int(i) => i.to_string(),
        Cell::Float(f) => json::js_number(f),
        Cell::Str(s) => serde_json::to_string(&s).unwrap(),
        Cell::Json(s) => s,
    })
}

/// CSV options from JavaScript, as JSON: { delimiter, header, names, types, emptyIsNull }.
pub fn csv_options(text: &str) -> Res<CsvOptions> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut o = CsvOptions::default();
    if let Some(d) = v.get("delimiter").and_then(Value::as_str) {
        let b = d.as_bytes();
        if b.len() != 1 {
            return Err("delimiter must be one ASCII character".into());
        }
        o.delimiter = b[0];
    }
    if let Some(h) = v.get("header").and_then(Value::as_bool) {
        o.header = h;
    }
    if let Some(n) = v.get("names").and_then(Value::as_array) {
        o.names = n.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect();
    }
    if let Some(t) = v.get("types").and_then(Value::as_array) {
        o.types = t
            .iter()
            .map(|x| match x.as_str() {
                Some("text") => Ok(ColType::Text),
                Some("int") => Ok(ColType::Int),
                Some("float") => Ok(ColType::Float),
                Some("bool") => Ok(ColType::Bool),
                Some("json") => Ok(ColType::Json),
                Some("infer") | None => Ok(ColType::Infer),
                Some(other) => Err(format!("unknown column type '{other}'")),
            })
            .collect::<Res<_>>()?;
    }
    if let Some(e) = v.get("emptyIsNull").and_then(Value::as_bool) {
        o.empty_is_null = e;
    }
    Ok(o)
}

pub struct Engine {
    pub t: DynTable,
    /// Reused output buffer for JSON; callers copy out of it into memory the JavaScript engine owns.
    pub scratch: Vec<u8>,
    /// Nesting depth of bulk loads; rows are packed only when the outermost one ends.
    pub bulk_depth: u32,
    /// An open CSV stream, between csv_begin and csv_finish.
    pub csv: Option<CsvLoader>,
}

impl Engine {
    pub fn new(hint: Hint) -> Self {
        Engine { t: DynTable::new(hint), scratch: Vec::new(), bulk_depth: 0, csv: None }
    }
    fn from_table(t: DynTable) -> Self {
        Engine { t, scratch: Vec::new(), bulk_depth: 0, csv: None }
    }

    pub fn len(&self) -> u32 {
        self.t.len() as u32
    }
    pub fn names(&self) -> Vec<String> {
        self.t.names().to_vec()
    }

    // ---------- loading ----------

    pub fn bulk<T>(&mut self, f: impl FnOnce(&mut DynTable) -> Res<T>) -> Res<T> {
        self.begin_bulk();
        let r = f(&mut self.t);
        self.end_bulk();
        r
    }
    pub fn begin_bulk(&mut self) {
        if self.bulk_depth == 0 {
            self.t.set_bulk(true)
        }
        self.bulk_depth += 1
    }
    pub fn end_bulk(&mut self) {
        if self.bulk_depth == 0 {
            return;
        }
        self.bulk_depth -= 1;
        if self.bulk_depth == 0 {
            self.t.set_bulk(false)
        }
    }
    pub fn push_jsonl(&mut self, text: &str) -> Res<u32> {
        self.bulk(|t| load::push_lines(t, text)).map(|n| n as u32)
    }
    pub fn push_json_array(&mut self, bytes: &[u8]) -> Res<u32> {
        self.bulk(|t| load::push_array(t, bytes)).map(|n| n as u32)
    }
    pub fn push_arrays_jsonl(&mut self, names: &[String], text: &str) -> Res<u32> {
        self.bulk(|t| load::push_array_lines(t, names, text)).map(|n| n as u32)
    }
    pub fn push_json(&mut self, text: &str) -> Res<()> {
        load::push_line(&mut self.t, text)
    }
    pub fn csv_begin(&mut self, options: &str) -> Res<()> {
        if self.csv.is_some() {
            return Err("a CSV stream is already open on this table".into());
        }
        self.csv = Some(CsvLoader::new(csv_options(options)?)?);
        self.begin_bulk();
        Ok(())
    }
    pub fn csv_feed(&mut self, chunk: &[u8]) -> Res<u32> {
        let loader = self.csv.as_mut().ok_or("no CSV stream is open")?;
        if let Err(e) = loader.feed(&mut self.t, chunk) {
            self.csv_abort();
            return Err(e);
        }
        Ok(loader.rows() as u32)
    }
    pub fn csv_abort(&mut self) {
        if self.csv.take().is_some() {
            self.end_bulk()
        }
    }
    pub fn csv_finish(&mut self) -> Res<u32> {
        let mut loader = self.csv.take().ok_or("no CSV stream is open")?;
        let r = loader.finish(&mut self.t);
        self.end_bulk();
        r.map(|n| n as u32)
    }

    // ---------- writing ----------

    fn check(&self, row: u32) -> Res<()> {
        if (row as usize) < self.t.len() { Ok(()) } else { Err(format!("row {row} out of range (length {})", self.t.len())) }
    }
    /// Row ids from JavaScript must be in range before they reach the core, which indexes without checks.
    pub fn check_ids(&self, ids: &[u32]) -> Res<()> {
        let n = self.t.len();
        match ids.iter().find(|&&i| i as usize >= n) {
            Some(i) => Err(format!("row id {i} out of range (length {n})")),
            None => Ok(()),
        }
    }
    pub fn set_json(&mut self, row: u32, name: &str, json: Option<&str>) -> Res<()> {
        self.check(row)?;
        let cell = match json {
            None => Cell::Missing,
            Some(s) => load::raw_cell(s)?,
        };
        self.t.set_by_name(row as usize, name, cell);
        Ok(())
    }
    /// Replace a whole row: keys not given become missing.
    pub fn set_row_json(&mut self, row: u32, text: &str) -> Res<()> {
        self.check(row)?;
        let cells = load::field_cells(text)?;
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
    /// Set and remove fields of one row as a unit: everything is parsed before anything is written.
    pub fn update_json(&mut self, row: u32, set: &str, remove: &[String]) -> Res<()> {
        self.check(row)?;
        let cells = load::field_cells(set)?;
        for (k, c) in cells {
            self.t.set_by_name(row as usize, &k, c)
        }
        for k in remove {
            if let Some(c) = self.t.col_index(k) {
                self.t.set(row as usize, c, Cell::Missing)
            }
        }
        Ok(())
    }
    /// Drop every row from `len` on. Used to undo an append that failed part-way; rebuilds the table.
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
    /// Rebuild from these row ids, in this order. Every list operation that moves rows is one call to this.
    pub fn reorder(&mut self, ids: &[u32]) -> Res<()> {
        self.check_ids(ids)?;
        self.t = self.t.take(ids);
        if self.bulk_depth > 0 {
            self.t.set_bulk(true)
        }
        Ok(())
    }
    pub fn take(&self, ids: &[u32]) -> Res<Engine> {
        self.check_ids(ids)?;
        Ok(Engine::from_table(self.t.take(ids)))
    }
    pub fn clear(&mut self) {
        self.t = DynTable::new(self.t.hint)
    }
    pub fn compact(&mut self) {
        self.t.compact()
    }

    // ---------- reading ----------

    /// JSON array bytes for rows `a..b`, in the scratch buffer.
    pub fn json_range(&mut self, a: u32, b: u32) -> &[u8] {
        json::range(&self.t, a as usize, b as usize, &mut self.scratch);
        &self.scratch
    }
    pub fn json_at(&mut self, ids: &[u32]) -> Res<&[u8]> {
        self.check_ids(ids)?;
        json::at(&self.t, ids, &mut self.scratch);
        Ok(&self.scratch)
    }
    /// Let go of a scratch buffer that grew large for one big result.
    pub fn trim_scratch(&mut self) {
        if self.scratch.capacity() > 8 << 20 {
            self.scratch = Vec::new()
        }
    }
    /// Row ids matching every filter. `spec` is JSON: `[[column, op, value], ...]`. With `within`, only those rows.
    pub fn select(&self, spec: &str, within: Option<&[u32]>) -> Res<Vec<u32>> {
        let spec: Vec<(String, String, Value)> = serde_json::from_str(spec).map_err(|e| e.to_string())?;
        if let Some(w) = within {
            self.check_ids(w)?;
            if w.windows(2).any(|p| p[0] >= p[1]) {
                return Err("row ids must be strictly increasing".into());
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
        Ok(ids.unwrap_or_else(|| (0..self.t.len() as u32).collect()))
    }
    pub fn sum(&self, name: &str, ids: Option<&[u32]>) -> Res<f64> {
        if let Some(ids) = ids {
            self.check_ids(ids)?
        }
        Ok(match self.t.col_index(name) {
            Some(c) => match self.t.sum(c, ids) {
                Num::Int(i) => i as f64,
                Num::Float(f) => f,
            },
            None => 0.0,
        })
    }
    /// GROUP BY value, count: JSON text of `[[value, count], ...]`; rows without the key are left out.
    pub fn group_count(&self, name: &str, ids: Option<&[u32]>) -> Res<String> {
        if let Some(ids) = ids {
            self.check_ids(ids)?
        }
        let Some(c) = self.t.col_index(name) else {
            return Ok("[]".into());
        };
        let parts: Vec<String> = self
            .t
            .group_count(c, ids)
            .into_iter()
            .filter_map(|(k, n)| cell_json(k).map(|v| format!("[{v},{n}]")))
            .collect();
        Ok(format!("[{}]", parts.join(",")))
    }
    /// One column as JSON text of an array; missing keys become null.
    pub fn column_json(&self, name: &str, ids: Option<&[u32]>) -> Res<String> {
        if let Some(ids) = ids {
            self.check_ids(ids)?
        }
        let Some(c) = self.t.col_index(name) else {
            return Ok("[]".into());
        };
        let cell = |i: usize| cell_json(self.t.get(i, c)).unwrap_or_else(|| "null".into());
        let parts: Vec<String> = match ids {
            Some(ids) => ids.iter().map(|&i| cell(i as usize)).collect(),
            None => (0..self.t.len()).map(cell).collect(),
        };
        Ok(format!("[{}]", parts.join(",")))
    }
    /// One column for rows `a..b`: JSON text (missing keys as null) and a byte per row that is 1 where the key is missing.
    pub fn column_range(&self, name: &str, a: u32, b: u32) -> (String, Vec<u8>) {
        let (a, b) = (a as usize, (b as usize).min(self.t.len()));
        let n = b.saturating_sub(a);
        let mut missing = vec![0u8; n];
        let Some(c) = self.t.col_index(name) else {
            missing.fill(1);
            return (format!("[{}]", vec!["null"; n].join(",")), missing);
        };
        let mut out = String::with_capacity(n * 8 + 2);
        out.push('[');
        for (k, i) in (a..b).enumerate() {
            if k > 0 {
                out.push(',')
            }
            match cell_json(self.t.get(i, c)) {
                Some(v) => out.push_str(&v),
                None => {
                    missing[k] = 1;
                    out.push_str("null")
                }
            }
        }
        out.push(']');
        (out, missing)
    }
    pub fn nbytes(&self) -> f64 {
        self.t.bytes() as f64
    }
    pub fn describe(&self) -> String {
        serde_json::to_string(&self.t.describe()).unwrap()
    }
}
