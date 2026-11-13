//! WebAssembly bindings for packmem (Cloudflare Workers, Deno, browsers): the same engine as the Node addon, compiled
//! from the same source files, exposed under the same method names so one JavaScript layer (api.js) serves both.
#[path = "../../src/engine.rs"]
mod engine;
#[path = "../../src/json.rs"]
mod json;
#[path = "../../src/load.rs"]
mod load;

use engine::{hint_of, Engine};
use js_sys::{Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen(js_name = NativeTable)]
pub struct WasmTable {
    e: Engine,
}

#[wasm_bindgen(js_class = NativeTable)]
impl WasmTable {
    #[wasm_bindgen(constructor)]
    pub fn new(hint: Option<String>) -> Result<WasmTable, JsError> {
        Ok(WasmTable { e: Engine::new(hint_of(hint.as_deref()).map_err(err)?) })
    }
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> u32 {
        self.e.len()
    }
    pub fn names(&self) -> Vec<String> {
        self.e.names()
    }

    #[wasm_bindgen(js_name = beginBulk)]
    pub fn begin_bulk(&mut self) {
        self.e.begin_bulk()
    }
    #[wasm_bindgen(js_name = endBulk)]
    pub fn end_bulk(&mut self) {
        self.e.end_bulk()
    }
    #[wasm_bindgen(js_name = pushJsonl)]
    pub fn push_jsonl(&mut self, text: &str) -> Result<u32, JsError> {
        self.e.push_jsonl(text).map_err(err)
    }
    #[wasm_bindgen(js_name = pushJsonlBuffer)]
    pub fn push_jsonl_buffer(&mut self, buf: &[u8]) -> Result<u32, JsError> {
        self.e.push_jsonl(std::str::from_utf8(buf).map_err(err)?).map_err(err)
    }
    #[wasm_bindgen(js_name = pushJsonArrayBuffer)]
    pub fn push_json_array_buffer(&mut self, buf: &[u8]) -> Result<u32, JsError> {
        self.e.push_json_array(buf).map_err(err)
    }
    #[wasm_bindgen(js_name = pushArraysJsonl)]
    pub fn push_arrays_jsonl(&mut self, names: Vec<String>, text: &str) -> Result<u32, JsError> {
        self.e.push_arrays_jsonl(&names, text).map_err(err)
    }
    #[wasm_bindgen(js_name = pushJson)]
    pub fn push_json(&mut self, text: &str) -> Result<(), JsError> {
        self.e.push_json(text).map_err(err)
    }
    #[wasm_bindgen(js_name = csvBegin)]
    pub fn csv_begin(&mut self, options: &str) -> Result<(), JsError> {
        self.e.csv_begin(options).map_err(err)
    }
    #[wasm_bindgen(js_name = csvFeed)]
    pub fn csv_feed(&mut self, chunk: &[u8]) -> Result<u32, JsError> {
        self.e.csv_feed(chunk).map_err(err)
    }
    #[wasm_bindgen(js_name = csvFinish)]
    pub fn csv_finish(&mut self) -> Result<u32, JsError> {
        self.e.csv_finish().map_err(err)
    }

    #[wasm_bindgen(js_name = setJson)]
    pub fn set_json(&mut self, row: u32, name: &str, json: Option<String>) -> Result<(), JsError> {
        self.e.set_json(row, name, json.as_deref()).map_err(err)
    }
    #[wasm_bindgen(js_name = setRowJson)]
    pub fn set_row_json(&mut self, row: u32, text: &str) -> Result<(), JsError> {
        self.e.set_row_json(row, text).map_err(err)
    }
    #[wasm_bindgen(js_name = updateJson)]
    pub fn update_json(&mut self, row: u32, set: &str, remove: Vec<String>) -> Result<(), JsError> {
        self.e.update_json(row, set, &remove).map_err(err)
    }
    pub fn truncate(&mut self, len: u32) {
        self.e.truncate(len)
    }
    pub fn reorder(&mut self, ids: &[u32]) -> Result<(), JsError> {
        self.e.reorder(ids).map_err(err)
    }
    pub fn take(&self, ids: &[u32]) -> Result<WasmTable, JsError> {
        Ok(WasmTable { e: self.e.take(ids).map_err(err)? })
    }
    pub fn clear(&mut self) {
        self.e.clear()
    }
    pub fn compact(&mut self) {
        self.e.compact()
    }

    #[wasm_bindgen(js_name = jsonRange)]
    pub fn json_range(&mut self, a: u32, b: u32) -> Result<String, JsError> {
        let s = std::str::from_utf8(self.e.json_range(a, b)).map(str::to_owned).map_err(err);
        self.e.trim_scratch();
        s
    }
    #[wasm_bindgen(js_name = jsonAt)]
    pub fn json_at(&mut self, ids: &[u32]) -> Result<String, JsError> {
        let s = std::str::from_utf8(self.e.json_at(ids).map_err(err)?).map(str::to_owned).map_err(err);
        self.e.trim_scratch();
        s
    }
    #[wasm_bindgen(js_name = jsonRangeBuffer)]
    pub fn json_range_buffer(&mut self, a: u32, b: u32) -> Vec<u8> {
        let v = self.e.json_range(a, b).to_vec();
        self.e.trim_scratch();
        v
    }
    #[wasm_bindgen(js_name = jsonAtBuffer)]
    pub fn json_at_buffer(&mut self, ids: &[u32]) -> Result<Vec<u8>, JsError> {
        let v = self.e.json_at(ids).map_err(err)?.to_vec();
        self.e.trim_scratch();
        Ok(v)
    }
    pub fn select(&self, spec: &str, within: Option<Vec<u32>>) -> Result<Vec<u32>, JsError> {
        self.e.select(spec, within.as_deref()).map_err(err)
    }
    pub fn sum(&self, name: &str, ids: Option<Vec<u32>>) -> Result<f64, JsError> {
        self.e.sum(name, ids.as_deref()).map_err(err)
    }
    #[wasm_bindgen(js_name = groupCount)]
    pub fn group_count(&self, name: &str, ids: Option<Vec<u32>>) -> Result<String, JsError> {
        self.e.group_count(name, ids.as_deref()).map_err(err)
    }
    #[wasm_bindgen(js_name = columnJson)]
    pub fn column_json(&self, name: &str, ids: Option<Vec<u32>>) -> Result<String, JsError> {
        self.e.column_json(name, ids.as_deref()).map_err(err)
    }
    #[wasm_bindgen(js_name = columnRange)]
    pub fn column_range(&self, name: &str, a: u32, b: u32) -> Result<Object, JsError> {
        let (json, missing) = self.e.column_range(name, a, b);
        let o = Object::new();
        Reflect::set(&o, &"json".into(), &json.into()).map_err(|_| err("columnRange"))?;
        Reflect::set(&o, &"missing".into(), &Uint8Array::from(missing.as_slice()).into()).map_err(|_| err("columnRange"))?;
        Ok(o)
    }
    pub fn nbytes(&self) -> f64 {
        self.e.nbytes()
    }
    pub fn describe(&self) -> String {
        self.e.describe()
    }
}
