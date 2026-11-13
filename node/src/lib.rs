//! Node bindings for packmem: a thin napi wrapper over `engine::Engine`. Calls into native code are made per batch,
//! never per field: rows leave as JSON text (parsed by V8 in one call) and filters return row-id arrays.
mod engine;
mod json;
mod load;

use engine::{Engine, hint_of};
use napi::bindgen_prelude::{Buffer, BufferSlice, Uint32Array};
use napi::{Env, Error, Result};
use napi_derive::napi;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};

fn err(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

#[napi(object)]
pub struct ColumnRange {
    pub json: String,
    pub missing: Buffer,
}

#[napi(js_name = "NativeTable")]
pub struct NativeTable {
    e: Engine,
}

#[napi]
impl NativeTable {
    #[napi(constructor)]
    pub fn new(hint: Option<String>) -> Result<Self> {
        Ok(NativeTable { e: Engine::new(hint_of(hint.as_deref()).map_err(err)?) })
    }

    #[napi(getter)]
    pub fn length(&self) -> u32 {
        self.e.len()
    }
    #[napi]
    pub fn names(&self) -> Vec<String> {
        self.e.names()
    }

    // ---------- loading ----------

    #[napi]
    pub fn begin_bulk(&mut self) {
        self.e.begin_bulk()
    }
    #[napi]
    pub fn end_bulk(&mut self) {
        self.e.end_bulk()
    }
    /// A JSON-lines file, streamed.
    #[napi]
    pub fn load_jsonl_path(&mut self, path: String) -> Result<u32> {
        let f = File::open(&path).map_err(|e| err(format!("{path}: {e}")))?;
        self.e
            .bulk(|t| {
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
            .map_err(err)
    }
    /// A file holding one JSON array of records, streamed.
    #[napi]
    pub fn load_json_array_path(&mut self, path: String) -> Result<u32> {
        let f = File::open(&path).map_err(|e| err(format!("{path}: {e}")))?;
        self.e.bulk(|t| load::push_array(t, BufReader::with_capacity(1 << 20, f))).map(|n| n as u32).map_err(err)
    }
    /// A CSV or TSV file, read in 1 MB chunks.
    #[napi]
    pub fn load_csv_path(&mut self, path: String, options: String) -> Result<u32> {
        let mut f = File::open(&path).map_err(|e| err(format!("{path}: {e}")))?;
        self.e.csv_begin(&options).map_err(err)?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = match f.read(&mut buf) {
                Ok(n) => n,
                Err(e) => {
                    self.e.csv_abort();
                    return Err(err(format!("{path}: {e}")));
                }
            };
            if n == 0 {
                break;
            }
            self.e.csv_feed(&buf[..n]).map_err(|e| err(format!("{path}: {e}")))?;
        }
        self.e.csv_finish().map_err(err)
    }
    #[napi]
    pub fn push_jsonl(&mut self, text: String) -> Result<u32> {
        self.e.push_jsonl(&text).map_err(err)
    }
    #[napi]
    pub fn push_jsonl_buffer(&mut self, buf: Buffer) -> Result<u32> {
        let text = std::str::from_utf8(&buf).map_err(err)?;
        self.e.push_jsonl(text).map_err(err)
    }
    #[napi]
    pub fn push_json_array_buffer(&mut self, buf: Buffer) -> Result<u32> {
        self.e.push_json_array(&buf).map_err(err)
    }
    #[napi]
    pub fn push_arrays_jsonl(&mut self, names: Vec<String>, text: String) -> Result<u32> {
        self.e.push_arrays_jsonl(&names, &text).map_err(err)
    }
    #[napi]
    pub fn push_json(&mut self, text: String) -> Result<()> {
        self.e.push_json(&text).map_err(err)
    }
    #[napi]
    pub fn csv_begin(&mut self, options: String) -> Result<()> {
        self.e.csv_begin(&options).map_err(err)
    }
    #[napi]
    pub fn csv_feed(&mut self, chunk: Buffer) -> Result<u32> {
        self.e.csv_feed(&chunk).map_err(err)
    }
    #[napi]
    pub fn csv_finish(&mut self) -> Result<u32> {
        self.e.csv_finish().map_err(err)
    }

    // ---------- writing ----------

    #[napi]
    pub fn set_json(&mut self, row: u32, name: String, json: Option<String>) -> Result<()> {
        self.e.set_json(row, &name, json.as_deref()).map_err(err)
    }
    #[napi]
    pub fn set_row_json(&mut self, row: u32, text: String) -> Result<()> {
        self.e.set_row_json(row, &text).map_err(err)
    }
    #[napi]
    pub fn update_json(&mut self, row: u32, set: String, remove: Vec<String>) -> Result<()> {
        self.e.update_json(row, &set, &remove).map_err(err)
    }
    #[napi]
    pub fn truncate(&mut self, len: u32) {
        self.e.truncate(len)
    }
    #[napi]
    pub fn reorder(&mut self, ids: Uint32Array) -> Result<()> {
        self.e.reorder(&ids).map_err(err)
    }
    #[napi]
    pub fn take(&self, ids: Uint32Array) -> Result<NativeTable> {
        Ok(NativeTable { e: self.e.take(&ids).map_err(err)? })
    }
    #[napi]
    pub fn clear(&mut self) {
        self.e.clear()
    }
    #[napi]
    pub fn compact(&mut self) {
        self.e.compact()
    }

    // ---------- reading ----------

    #[napi]
    pub fn json_range(&mut self, a: u32, b: u32) -> Result<String> {
        let s = std::str::from_utf8(self.e.json_range(a, b)).map(str::to_owned).map_err(err);
        self.e.trim_scratch();
        s
    }
    #[napi]
    pub fn json_at(&mut self, ids: Uint32Array) -> Result<String> {
        let s = std::str::from_utf8(self.e.json_at(&ids).map_err(err)?).map(str::to_owned).map_err(err);
        self.e.trim_scratch();
        s
    }
    /// Copied into a buffer V8 owns, so the garbage collector sees its size and native memory stays flat.
    #[napi]
    pub fn json_range_buffer<'e>(&mut self, env: &'e Env, a: u32, b: u32) -> Result<BufferSlice<'e>> {
        let r = BufferSlice::copy_from(env, self.e.json_range(a, b));
        self.e.trim_scratch();
        r
    }
    #[napi]
    pub fn json_at_buffer<'e>(&mut self, env: &'e Env, ids: Uint32Array) -> Result<BufferSlice<'e>> {
        let r = BufferSlice::copy_from(env, self.e.json_at(&ids).map_err(err)?);
        self.e.trim_scratch();
        r
    }
    #[napi]
    pub fn select(&self, spec: String, within: Option<Uint32Array>) -> Result<Uint32Array> {
        Ok(Uint32Array::new(self.e.select(&spec, within.as_deref()).map_err(err)?))
    }
    #[napi]
    pub fn sum(&self, name: String, ids: Option<Uint32Array>) -> Result<f64> {
        self.e.sum(&name, ids.as_deref()).map_err(err)
    }
    #[napi]
    pub fn group_count(&self, name: String, ids: Option<Uint32Array>) -> Result<String> {
        self.e.group_count(&name, ids.as_deref()).map_err(err)
    }
    #[napi]
    pub fn column_json(&self, name: String, ids: Option<Uint32Array>) -> Result<String> {
        self.e.column_json(&name, ids.as_deref()).map_err(err)
    }
    #[napi]
    pub fn column_range(&self, name: String, a: u32, b: u32) -> ColumnRange {
        let (json, missing) = self.e.column_range(&name, a, b);
        ColumnRange { json, missing: missing.into() }
    }
    #[napi]
    pub fn nbytes(&self) -> f64 {
        self.e.nbytes()
    }
    #[napi]
    pub fn describe(&self) -> String {
        self.e.describe()
    }
}
