//! The table operations behind the JavaScript API, independent of how they are exposed. The Node addon (napi) and the
//! WebAssembly build (wasm-bindgen) are thin wrappers over this, so the two cannot drift apart.
use crate::{json, load};
use packmem::csv::{ColType, CsvLoader, CsvOptions};
use packmem::{Cell, DynTable, Hint, Num, Pred};
use serde_json::Value;
use std::ops::Deref;
use std::sync::Arc;

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

/// The table behind an `Engine`: owned and writable, or shared read-only with other threads by `share()`.
pub enum Store {
    Own(DynTable),
    Shared(Arc<DynTable>),
}
impl Deref for Store {
    type Target = DynTable;
    fn deref(&self) -> &DynTable {
        match self {
            Store::Own(t) => t,
            Store::Shared(t) => t,
        }
    }
}

const READ_ONLY: &str = "the table is shared and read-only; call unshare() first";

/// A private copy of a table, from its byte form: the packed columns are copied, not re-encoded.
fn copy_of(t: &DynTable) -> Res<DynTable> {
    let mut buf = Vec::new();
    t.write_to(&mut |b| {
        buf.extend_from_slice(b);
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    DynTable::from_bytes(&buf).map_err(|e| e.to_string())
}

pub struct Engine {
    pub t: Store,
    /// Reused output buffer for JSON; callers copy out of it into memory the JavaScript engine owns.
    pub scratch: Vec<u8>,
    /// Nesting depth of bulk loads; rows are packed only when the outermost one ends.
    pub bulk_depth: u32,
    /// An open CSV stream, between csv_begin and csv_finish.
    pub csv: Option<CsvLoader>,
}

impl Engine {
    pub fn new(hint: Hint) -> Self {
        Self::from_table(DynTable::new(hint))
    }
    fn from_table(t: DynTable) -> Self {
        Engine { t: Store::Own(t), scratch: Vec::new(), bulk_depth: 0, csv: None }
    }
    /// A read-only engine over a table another thread shared.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pub fn from_shared(t: Arc<DynTable>) -> Self {
        Engine { t: Store::Shared(t), scratch: Vec::new(), bulk_depth: 0, csv: None }
    }
    /// The table, for a change; fails while it is shared.
    fn w(&mut self) -> Res<&mut DynTable> {
        match &mut self.t {
            Store::Own(t) => Ok(t),
            Store::Shared(_) => Err(READ_ONLY.into()),
        }
    }
    fn writable(&self) -> Res<()> {
        if self.is_shared() { Err(READ_ONLY.into()) } else { Ok(()) }
    }
    pub fn is_shared(&self) -> bool {
        matches!(self.t, Store::Shared(_))
    }

    // ---------- sharing ----------

    /// Make the table read-only and return a reference other threads can read through, without copying it. Sharing an
    /// already shared table returns the same reference.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pub fn share(&mut self) -> Res<Arc<DynTable>> {
        if let Store::Shared(a) = &self.t {
            return Ok(a.clone());
        }
        if self.bulk_depth > 0 || self.csv.is_some() {
            return Err("finish loading before sharing the table".into());
        }
        let Store::Own(mut t) = std::mem::replace(&mut self.t, Store::Own(DynTable::new(Hint::Balanced))) else {
            unreachable!()
        };
        // pack the open rows now: readers on other threads need nothing changed after this point
        t.compact();
        let a = Arc::new(t);
        self.t = Store::Shared(a.clone());
        Ok(a)
    }
    /// Writable again. Takes the table back without copying when no other thread still holds it; otherwise this engine
    /// gets a private copy and the readers keep theirs.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pub fn unshare(&mut self) -> Res<()> {
        if !self.is_shared() {
            return Ok(());
        }
        let Store::Shared(a) = std::mem::replace(&mut self.t, Store::Own(DynTable::new(Hint::Balanced))) else {
            unreachable!()
        };
        self.t = Store::Own(match Arc::try_unwrap(a) {
            Ok(t) => t,
            Err(a) => match copy_of(&a) {
                Ok(t) => t,
                Err(e) => {
                    self.t = Store::Shared(a);
                    return Err(e);
                }
            },
        });
        Ok(())
    }

    pub fn len(&self) -> u32 {
        self.t.len() as u32
    }
    pub fn names(&self) -> Vec<String> {
        self.t.names().to_vec()
    }

    // ---------- loading ----------

    pub fn bulk<T>(&mut self, f: impl FnOnce(&mut DynTable) -> Res<T>) -> Res<T> {
        self.begin_bulk()?;
        let r = self.w().and_then(f);
        self.end_bulk();
        r
    }
    /// `bulk`, with text-heavy chunks packed on `threads` background threads while `f` keeps appending. Only for a load
    /// that finishes inside this call: in a bulk session opened from JavaScript the table can be read between calls,
    /// so there this is plain `bulk`. WebAssembly has no threads, so the wasm build does not have it.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn bulk_parallel<T>(&mut self, threads: usize, f: impl FnOnce(&mut DynTable) -> Res<T>) -> Res<T> {
        if self.bulk_depth > 0 || threads == 0 {
            return self.bulk(f);
        }
        self.w()?.set_bulk_parallel(threads);
        self.bulk_depth = 1;
        let r = self.w().and_then(f);
        // ending bulk mode waits for the background threads
        self.end_bulk();
        r
    }
    /// `csv_begin`, packing text-heavy chunks on `threads` background threads, for a CSV stream fed and finished
    /// without returning to JavaScript in between.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn csv_begin_parallel(&mut self, options: &str, threads: usize) -> Res<()> {
        let outer = self.bulk_depth > 0;
        self.csv_begin(options)?;
        if !outer && threads > 0 {
            self.w()?.set_bulk_parallel(threads)
        }
        Ok(())
    }
    pub fn begin_bulk(&mut self) -> Res<()> {
        if self.bulk_depth == 0 {
            self.w()?.set_bulk(true)
        }
        self.bulk_depth += 1;
        Ok(())
    }
    pub fn end_bulk(&mut self) {
        if self.bulk_depth == 0 {
            return;
        }
        self.bulk_depth -= 1;
        // a table in a bulk load is never shared: share() refuses while one is open
        if let (0, Store::Own(t)) = (self.bulk_depth, &mut self.t) {
            t.set_bulk(false)
        }
    }
    pub fn push_jsonl(&mut self, text: &str) -> Res<u32> {
        self.bulk(|t| load::push_lines(t, text)).map(|n| n as u32)
    }
    // the Node build parses arrays through `bulk_parallel`; the wasm build uses this
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub fn push_json_array(&mut self, bytes: &[u8]) -> Res<u32> {
        self.bulk(|t| load::push_array(t, bytes)).map(|n| n as u32)
    }
    pub fn push_arrays_jsonl(&mut self, names: &[String], text: &str) -> Res<u32> {
        self.bulk(|t| load::push_array_lines(t, names, text)).map(|n| n as u32)
    }
    pub fn push_json(&mut self, text: &str) -> Res<()> {
        load::push_line(self.w()?, text)
    }
    pub fn csv_begin(&mut self, options: &str) -> Res<()> {
        if self.csv.is_some() {
            return Err("a CSV stream is already open on this table".into());
        }
        self.writable()?;
        self.csv = Some(CsvLoader::new(csv_options(options)?)?);
        self.begin_bulk()
    }
    pub fn csv_feed(&mut self, chunk: &[u8]) -> Res<u32> {
        let loader = self.csv.as_mut().ok_or("no CSV stream is open")?;
        let Store::Own(t) = &mut self.t else { return Err(READ_ONLY.into()) };
        if let Err(e) = loader.feed(t, chunk) {
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
        let r = self.w().and_then(|t| loader.finish(t));
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
        self.w()?.set_by_name(row as usize, name, cell);
        Ok(())
    }
    /// Replace a whole row: keys not given become missing.
    pub fn set_row_json(&mut self, row: u32, text: &str) -> Res<()> {
        self.check(row)?;
        let cells = load::field_cells(text)?;
        let t = self.w()?;
        for c in 0..t.names().len() {
            let name = t.names()[c].clone();
            if !cells.iter().any(|(k, _)| *k == name) {
                t.set(row as usize, c, Cell::Missing)
            }
        }
        for (k, cell) in cells {
            t.set_by_name(row as usize, &k, cell)
        }
        Ok(())
    }
    /// Set and remove fields of one row as a unit: everything is parsed before anything is written.
    pub fn update_json(&mut self, row: u32, set: &str, remove: &[String]) -> Res<()> {
        self.check(row)?;
        let cells = load::field_cells(set)?;
        let t = self.w()?;
        for (k, c) in cells {
            t.set_by_name(row as usize, &k, c)
        }
        for k in remove {
            if let Some(c) = t.col_index(k) {
                t.set(row as usize, c, Cell::Missing)
            }
        }
        Ok(())
    }
    /// Drop every row from `len` on. Used to undo an append that failed part-way; rebuilds the table.
    pub fn truncate(&mut self, len: u32) -> Res<()> {
        let len = (len as usize).min(self.t.len());
        if len == self.t.len() {
            return Ok(());
        }
        self.writable()?;
        let keep: Vec<u32> = (0..len as u32).collect();
        let t = self.t.take(&keep);
        self.replace(t);
        Ok(())
    }
    /// Swap in a rebuilt table, keeping bulk mode on if a bulk load is open.
    fn replace(&mut self, mut t: DynTable) {
        if self.bulk_depth > 0 {
            t.set_bulk(true)
        }
        self.t = Store::Own(t)
    }
    /// Rebuild from these row ids, in this order. Every list operation that moves rows is one call to this.
    pub fn reorder(&mut self, ids: &[u32]) -> Res<()> {
        self.check_ids(ids)?;
        self.writable()?;
        let t = self.t.take(ids);
        self.replace(t);
        Ok(())
    }
    pub fn take(&self, ids: &[u32]) -> Res<Engine> {
        self.check_ids(ids)?;
        Ok(Engine::from_table(self.t.take(ids)))
    }
    pub fn clear(&mut self) -> Res<()> {
        self.writable()?;
        self.t = Store::Own(DynTable::new(self.t.hint));
        Ok(())
    }
    pub fn compact(&mut self) {
        // a shared table was packed when it was shared
        if let Store::Own(t) = &mut self.t {
            t.compact()
        }
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
