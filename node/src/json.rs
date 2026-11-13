//! Rows written as JSON text straight from the packed columns: no per-row object on either side of the boundary.
use packmem::dynamic::RowVisitor;
use packmem::{Cell, DynTable};
use std::collections::HashMap;

pub struct JsonWriter<'a> {
    out: &'a mut Vec<u8>,
    keys: Vec<Vec<u8>>,
    first: bool,
    rows: usize,
    /// Escaped dictionary strings, keyed by (column, segment, code); valid for one writer.
    dict: HashMap<(usize, usize, u32), Box<[u8]>>,
}

fn esc(out: &mut Vec<u8>, s: &str) {
    serde_json::to_writer(out, s).expect("writing to a Vec cannot fail")
}

impl<'a> JsonWriter<'a> {
    pub fn new(t: &DynTable, out: &'a mut Vec<u8>) -> Self {
        let keys = t
            .names()
            .iter()
            .map(|n| {
                let mut k = Vec::with_capacity(n.len() + 3);
                esc(&mut k, n);
                k.push(b':');
                k
            })
            .collect();
        JsonWriter {
            out,
            keys,
            first: true,
            rows: 0,
            dict: HashMap::new(),
        }
    }
    fn key(&mut self, col: usize) {
        if !self.first {
            self.out.push(b',')
        }
        self.first = false;
        self.out.extend_from_slice(&self.keys[col])
    }
    /// Writes `[`, then rows as visited, then `]` on `finish`.
    pub fn open_array(&mut self) {
        self.out.push(b'[')
    }
    pub fn close_array(&mut self) {
        self.out.push(b']')
    }
}

impl RowVisitor for JsonWriter<'_> {
    fn begin(&mut self) {
        if self.rows > 0 {
            self.out.push(b',')
        }
        self.out.push(b'{');
        self.first = true
    }
    fn end(&mut self) {
        self.out.push(b'}');
        self.rows += 1
    }
    fn null(&mut self, col: usize) {
        self.key(col);
        self.out.extend_from_slice(b"null")
    }
    fn boolean(&mut self, col: usize, v: bool) {
        self.key(col);
        self.out
            .extend_from_slice(if v { b"true" as &[u8] } else { b"false" })
    }
    fn int(&mut self, col: usize, v: i64) {
        self.key(col);
        self.out.extend_from_slice(itoa::Buffer::new().format(v).as_bytes())
    }
    fn float(&mut self, col: usize, v: f64) {
        self.key(col);
        // match JSON.stringify: whole numbers without ".0" (and -0 as 0), shortest round-trip form otherwise, null for NaN and infinities
        if v.fract() == 0.0 && v.abs() < 1e15 {
            self.out.extend_from_slice(itoa::Buffer::new().format(v as i64).as_bytes())
        } else {
            serde_json::to_writer(&mut self.out, &v).expect("writing to a Vec cannot fail")
        }
    }
    fn str(&mut self, col: usize, s: &str) {
        self.key(col);
        esc(&mut self.out, s)
    }
    fn dict_str(
        &mut self,
        col: usize,
        seg: usize,
        code: u32,
        _dict_len: usize,
        value: &mut dyn FnMut() -> String,
    ) {
        self.key(col);
        let e = self.dict.entry((col, seg, code)).or_insert_with(|| {
            let mut b = Vec::new();
            esc(&mut b, &value());
            b.into_boxed_slice()
        });
        self.out.extend_from_slice(e)
    }
    fn other(&mut self, col: usize, c: &Cell) {
        self.key(col);
        match c {
            Cell::Json(s) => self.out.extend_from_slice(s.as_bytes()),
            _ => self.out.extend_from_slice(b"null"),
        }
    }
}

/// Rows `a..b` as a JSON array, written to `out` (cleared first).
pub fn range(t: &DynTable, a: usize, b: usize, out: &mut Vec<u8>) {
    out.clear();
    let mut w = JsonWriter::new(t, out);
    w.open_array();
    t.visit_rows(a, b, &mut w);
    w.close_array();
}

/// Rows with the given ids, in order, as a JSON array, written to `out` (cleared first).
pub fn at(t: &DynTable, ids: &[u32], out: &mut Vec<u8>) {
    out.clear();
    let mut w = JsonWriter::new(t, out);
    w.open_array();
    let n = t.len();
    let mut i = 0;
    while i < ids.len() {
        // consecutive ids are visited as one range
        let a = ids[i] as usize;
        let mut b = a + 1;
        while i + 1 < ids.len() && ids[i + 1] as usize == b {
            b += 1;
            i += 1
        }
        if a < n {
            t.visit_rows(a, b.min(n), &mut w)
        }
        i += 1
    }
    w.close_array();
}
