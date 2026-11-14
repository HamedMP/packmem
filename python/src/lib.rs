//! Python bindings for packmem: a list-of-dicts replacement backed by packed, mutable columns.
use packmem::csv::{ColType, CsvLoader, CsvOptions};
use packmem::dynamic::{from_text, to_text, RowVisitor};
use packmem::{Cell, DynTable, Hint, Num, Pred, StrMeasure};
use pyo3::exceptions::{PyIndexError, PyKeyError, PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyBytes, PyDict, PyFloat, PyInt, PyList, PyString, PyTuple};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;
use std::io::{BufRead, BufReader};
use std::marker::PhantomData;

fn dumps(v: &Bound<'_, PyAny>) -> PyResult<String> {
    let py = v.py();
    let kw = PyDict::new(py);
    kw.set_item("separators", (",", ":"))?;
    py.import("json")?
        .getattr("dumps")?
        .call((v,), Some(&kw))?
        .extract()
}

/// A value `to_cell` refused, converted as `json.dumps(v, default=f)` would: `f` is called for each part JSON has no
/// form for, wherever it sits inside nested lists and dicts.
fn to_cell_with(v: &Bound<'_, PyAny>, f: &Bound<'_, PyAny>) -> PyResult<Cell> {
    let py = v.py();
    let kw = PyDict::new(py);
    kw.set_item("separators", (",", ":"))?;
    kw.set_item("default", f)?;
    let s: String = py
        .import("json")?
        .getattr("dumps")?
        .call((v,), Some(&kw))?
        .extract()?;
    Ok(match from_text(s.as_bytes()) {
        Cell::Missing => Cell::Null,
        c => c,
    })
}

fn to_cell(v: &Bound<'_, PyAny>) -> PyResult<Cell> {
    if v.is_none() {
        Ok(Cell::Null)
    } else if v.is_exact_instance_of::<PyBool>() {
        Ok(Cell::Bool(v.extract()?))
    } else if v.is_exact_instance_of::<PyInt>() {
        match v.extract::<i64>() {
            Ok(i) => Ok(Cell::Int(i)),
            Err(_) => Ok(Cell::Json(v.str()?.to_string())),
        }
    } else if v.is_exact_instance_of::<PyFloat>() {
        Ok(Cell::Float(v.extract()?))
    } else if v.is_exact_instance_of::<PyString>() {
        // a str holding a lone surrogate has no UTF-8 form: keep it as escaped JSON text, which reads back identically
        match v.extract::<String>() {
            Ok(s) => Ok(Cell::Str(s)),
            Err(_) => Ok(Cell::Json(dumps(v)?)),
        }
    } else {
        let s = dumps(v)?;
        Ok(match from_text(s.as_bytes()) {
            Cell::Missing => Cell::Null,
            _ => Cell::Json(s),
        })
    }
}

/// Writes a Python str cell, falling back to escaped JSON text when it has no UTF-8 form (lone surrogates).
trait PutStr {
    fn put_str_cell(&mut self, c: usize, v: &Bound<'_, PyString>) -> PyResult<()>;
}
impl PutStr for DynTable {
    fn put_str_cell(&mut self, c: usize, v: &Bound<'_, PyString>) -> PyResult<()> {
        match v.to_cow() {
            Ok(s) => self.put_str_at(c, &s),
            Err(_) => self.put_at(c, Cell::Json(dumps(v.as_any())?)),
        }
        Ok(())
    }
}

fn from_cell(py: Python<'_>, c: Cell) -> PyResult<PyObject> {
    Ok(match c {
        Cell::Missing | Cell::Null => py.None(),
        Cell::Bool(b) => PyBool::new(py, b).to_owned().into_any().unbind(),
        Cell::Int(i) => i.into_pyobject(py)?.into_any().unbind(),
        Cell::Float(f) => f.into_pyobject(py)?.into_any().unbind(),
        Cell::Str(s) => PyString::new(py, &s).into_any().unbind(),
        Cell::Json(s) => py.import("json")?.getattr("loads")?.call1((s,))?.unbind(),
    })
}

/// One JSON value as source text: borrowed when parsing from a string, boxed when streaming from a reader.
trait Raw<'de>: serde::Deserialize<'de> {
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

/// Nested JSON text with the whitespace between tokens removed. The parser has already validated it, so it is kept
/// as written (escapes, number text and key order included) instead of being parsed into a tree and written back.
fn compact_json(t: &str) -> String {
    let mut out = Vec::with_capacity(t.len());
    let (mut in_string, mut escaped) = (false, false);
    for &c in t.as_bytes() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false
            } else if c == b'\\' {
                escaped = true
            } else if c == b'"' {
                in_string = false
            }
        } else if c == b'"' {
            in_string = true;
            out.push(c)
        } else if !matches!(c, b' ' | b'\n' | b'\r' | b'\t') {
            out.push(c)
        }
    }
    // only ASCII whitespace outside strings was dropped, so the bytes are still valid UTF-8
    String::from_utf8(out).expect("compacting JSON keeps it valid UTF-8")
}

fn raw_cell(t: &str) -> Result<Cell, String> {
    let b = t.as_bytes();
    Ok(match b.first() {
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
        Some(b'[' | b'{') => Cell::Json(compact_json(t)),
        // numbers keep their source text: integers beyond 64 bits stay exact, floats parse exactly
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

/// Keys to keep when loading; `None` keeps every key.
type Only<'a> = Option<&'a std::collections::HashSet<String>>;

/// Resolves a record key to its column, or `None` when the key is filtered out.
struct KeySeed<'a>(&'a mut DynTable, Only<'a>);
impl<'de, 'a> DeserializeSeed<'de> for KeySeed<'a> {
    type Value = Option<usize>;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<Option<usize>, D::Error> {
        d.deserialize_str(self)
    }
}
impl<'de, 'a> Visitor<'de> for KeySeed<'a> {
    type Value = Option<usize>;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a key")
    }
    fn visit_str<E: serde::de::Error>(self, k: &str) -> Result<Option<usize>, E> {
        Ok(match self.1 {
            Some(only) if !only.contains(k) => None,
            _ => Some(self.0.col_for(k)),
        })
    }
}

/// Fills the cells of one record. The caller finishes with `end_row`, or `abort_row` on error.
struct RowSeed<'a, R>(&'a mut DynTable, Only<'a>, PhantomData<R>);
impl<'de, 'a, R: Raw<'de>> DeserializeSeed<'de> for RowSeed<'a, R> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de, 'a, R: Raw<'de>> Visitor<'de> for RowSeed<'a, R> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON object for each record")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<(), A::Error> {
        let (t, only) = (self.0, self.1);
        while let Some(c) = m.next_key_seed(KeySeed(&mut *t, only))? {
            let Some(c) = c else {
                // a field that was not asked for: skipped without being stored
                m.next_value::<serde::de::IgnoredAny>()?;
                continue;
            };
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

/// macOS goes on counting memory against a process after it is freed, so the buffers a load needs only while it runs
/// would stay in the process's footprint for good. Blocks of `BIG` bytes or more therefore get a mapping of their own,
/// which goes back to the system the moment it is freed.
#[cfg(target_os = "macos")]
mod big_alloc {
    use std::alloc::{GlobalAlloc, Layout, System};
    const BIG: usize = 96 << 10;
    pub struct Alloc;
    fn big(l: Layout) -> bool {
        l.size() >= BIG && l.align() <= 4096
    }
    // SAFETY: each block is served either by the system allocator or by its own anonymous mapping, decided by its
    // layout alone, so `dealloc` and `realloc` always return a block to where it came from.
    unsafe impl GlobalAlloc for Alloc {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            if !big(l) {
                return unsafe { System.alloc(l) };
            }
            let p = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    l.size(),
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_PRIVATE | libc::MAP_ANON,
                    -1,
                    0,
                )
            };
            if p == libc::MAP_FAILED {
                std::ptr::null_mut()
            } else {
                p.cast()
            }
        }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            if big(l) {
                unsafe { self.alloc(l) }
            } else {
                unsafe { System.alloc_zeroed(l) }
            }
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            if big(l) {
                unsafe { libc::munmap(p.cast(), l.size()) };
            } else {
                unsafe { System.dealloc(p, l) }
            }
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
            // SAFETY: the caller guarantees `size` is valid for this alignment.
            let new = unsafe { Layout::from_size_align_unchecked(size, l.align()) };
            if !big(l) && !big(new) {
                return unsafe { System.realloc(p, l, size) };
            }
            let q = unsafe { self.alloc(new) };
            if !q.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(p, q, l.size().min(size));
                    self.dealloc(p, l)
                }
            }
            q
        }
    }
}
#[cfg(target_os = "macos")]
#[global_allocator]
static ALLOC: big_alloc::Alloc = big_alloc::Alloc;

/// The threaded load cannot take this input; load it on one thread instead.
struct Redo;

/// A run of records cut from a mapped file for one worker.
enum Piece<'a> {
    /// JSON lines, one record a line, blank lines allowed.
    Lines(&'a [u8]),
    /// Elements of a JSON array: the file and where each element starts and ends.
    Items(&'a [u8], Vec<(usize, usize)>),
}
impl Piece<'_> {
    /// Call `f` with each record until it returns false; true when every record was accepted.
    fn records(&self, mut f: impl FnMut(&[u8]) -> bool) -> bool {
        match self {
            Piece::Lines(text) => text.split(|&b| b == b'\n').filter(|l| !blank(l)).all(f),
            Piece::Items(data, items) => items.iter().all(|&(a, b)| f(&data[a..b])),
        }
    }
}
fn blank(l: &[u8]) -> bool {
    l.iter().all(u8::is_ascii_whitespace)
}
/// Where the JSON object starting at `data[at] == b'{'` ends (one past its closing brace), without checking that
/// what is inside is valid.
fn object_end(data: &[u8], at: usize) -> Option<usize> {
    let (mut depth, mut i) = (0usize, at);
    while i < data.len() {
        match data[i] {
            b'"' => loop {
                i += 1;
                match data.get(i)? {
                    b'"' => break,
                    b'\\' => i += 1,
                    _ => {}
                }
            },
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1
    }
    None
}

/// Files smaller than this load on one thread.
const PARALLEL_LOAD_BYTES: u64 = 8 << 20;

fn push_line(t: &mut DynTable, line: &str, only: Only<'_>) -> Result<(), String> {
    let mut de = serde_json::Deserializer::from_str(line);
    match RowSeed::<&RawValue>(&mut *t, only, PhantomData)
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

/// Adapts a Python file object (text or binary) to `std::io::Read`.
struct PyReader<'py> {
    f: Bound<'py, PyAny>,
    buf: Vec<u8>,
    pos: usize,
}
impl<'py> std::io::Read for PyReader<'py> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos == self.buf.len() {
            let e = |e: PyErr| std::io::Error::other(e.to_string());
            let chunk = self.f.call_method1("read", (1usize << 18,)).map_err(e)?;
            self.buf = if let Ok(s) = chunk.downcast::<PyString>() {
                s.extract::<String>().map_err(e)?.into_bytes()
            } else {
                chunk.extract::<Vec<u8>>().map_err(e)?
            };
            self.pos = 0;
            if self.buf.is_empty() {
                return Ok(0);
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

struct ArraySink<'a>(&'a mut DynTable, Only<'a>);
impl<'de, 'a> DeserializeSeed<'de> for ArraySink<'a> {
    type Value = usize;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<usize, D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de, 'a> Visitor<'de> for ArraySink<'a> {
    type Value = usize;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON array of objects")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<usize, A::Error> {
        let (t, only) = (self.0, self.1);
        let mut n = 0;
        loop {
            match seq.next_element_seed(RowSeed::<Box<RawValue>>(&mut *t, only, PhantomData)) {
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

fn hint_of(h: &str) -> PyResult<Hint> {
    match h {
        "memory" => Ok(Hint::Memory),
        "balanced" => Ok(Hint::Balanced),
        "speed" => Ok(Hint::Speed),
        "compact" => Ok(Hint::Compact),
        _ => Err(PyValueError::new_err(
            "hint must be 'memory', 'balanced', 'speed' or 'compact'",
        )),
    }
}
fn num(v: &Bound<'_, PyAny>) -> PyResult<f64> {
    if v.is_instance_of::<PyBool>() {
        return Err(PyTypeError::new_err("range filters need a number"));
    }
    v.extract::<f64>()
        .map_err(|_| PyTypeError::new_err("range filters need a number"))
}

/// A set of matching row numbers, kept in native memory.
#[pyclass(module = "packmem")]
struct Selection {
    ids: Vec<u32>,
}
#[pymethods]
impl Selection {
    fn __len__(&self) -> usize {
        self.ids.len()
    }
    fn intersect(&self, other: PyRef<'_, Selection>) -> Selection {
        let (a, b) = (&self.ids, &other.ids);
        let (mut i, mut j, mut o) = (0, 0, vec![]);
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
        Selection { ids: o }
    }
    fn ids(&self) -> Vec<u32> {
        self.ids.clone()
    }
}

#[pyclass(module = "packmem", name = "_Table")]
struct PyTable {
    t: DynTable,
    keys: Vec<Py<PyString>>,
    template: Option<Py<PyDict>>,
    /// Key objects seen at each position of the last appended dicts, with their column. Readers such as csv.DictReader reuse the same key objects for every row.
    seen_keys: Vec<(Py<PyAny>, usize)>,
    /// Set on tables that are shared with other processes: every change is refused, so the copies cannot diverge.
    frozen: bool,
    /// Set by the Python loaders while a load with `fields=` runs: only these keys are stored.
    only: Option<std::collections::HashSet<String>>,
    /// Set while `append` or `extend` runs with `default=`: called for values JSON has no form for.
    conv: Option<PyObject>,
}

/// Builds one dict per visited row by copying a template that already holds every key, then replacing values.
struct DictSink<'a, 'py> {
    py: Python<'py>,
    keys: &'a [Py<PyString>],
    template: &'a Bound<'py, PyDict>,
    out: &'a Bound<'py, PyList>,
    cur: Option<Bound<'py, PyDict>>,
    seen: usize,
    stamp: u32,
    mark: Vec<u32>,
    use_cache: bool,
    cache: Vec<(usize, Vec<Option<Py<PyString>>>)>,
    err: Option<PyErr>,
    /// The nested value being built, when a column stored as sub-columns is being read.
    nest: Option<Nest<'py>>,
    /// Key strings for nested fields, by (column, field index); checked against the name, since field numbering
    /// can differ from chunk to chunk.
    nkeys: Vec<Vec<Option<(String, Py<PyString>)>>>,
}
struct Nest<'py> {
    is_record: bool,
    list: Bound<'py, PyList>,
    cur: Option<Bound<'py, PyDict>>,
    key: Option<Py<PyString>>,
    col: usize,
}
impl<'a, 'py> DictSink<'a, 'py> {
    fn new(
        py: Python<'py>,
        keys: &'a [Py<PyString>],
        template: &'a Bound<'py, PyDict>,
        out: &'a Bound<'py, PyList>,
        use_cache: bool,
    ) -> Self {
        DictSink {
            py,
            keys,
            template,
            out,
            cur: None,
            seen: 0,
            stamp: 0,
            mark: vec![0; keys.len()],
            use_cache,
            cache: vec![],
            err: None,
            nest: None,
            nkeys: vec![],
        }
    }
    #[inline]
    fn put(&mut self, col: usize, v: PyResult<Bound<'py, PyAny>>) {
        if let Some(n) = &self.nest {
            // inside a nested record: the value belongs to the field named by the last `nested_key`
            if let (Some(d), Some(k)) = (&n.cur, &n.key) {
                if let Err(e) = v.and_then(|v| d.set_item(k.bind(self.py), v)) {
                    self.err.get_or_insert(e);
                }
            }
            return;
        }
        self.seen += 1;
        self.mark[col] = self.stamp;
        if let Some(d) = &self.cur {
            if let Err(e) = v.and_then(|v| d.set_item(self.keys[col].bind(self.py), v)) {
                self.err.get_or_insert(e);
            }
        }
    }
    fn finish(self) -> PyResult<()> {
        match self.err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}
impl<'a, 'py> RowVisitor for DictSink<'a, 'py> {
    fn begin(&mut self) {
        self.seen = 0;
        self.stamp += 1;
        self.cur = match self.template.copy() {
            Ok(d) => Some(d),
            Err(e) => {
                self.err.get_or_insert(e);
                None
            }
        }
    }
    fn end(&mut self) {
        let Some(d) = self.cur.take() else { return };
        if self.seen < self.keys.len() {
            for c in 0..self.keys.len() {
                if self.mark[c] != self.stamp {
                    if let Err(e) = d.del_item(self.keys[c].bind(self.py)) {
                        self.err.get_or_insert(e);
                    }
                }
            }
        }
        if let Err(e) = self.out.append(d) {
            self.err.get_or_insert(e);
        }
    }
    #[inline]
    fn null(&mut self, col: usize) {
        if self.nest.is_some() {
            let none = self.py.None().into_bound(self.py);
            return self.put(col, Ok(none));
        }
        self.seen += 1;
        self.mark[col] = self.stamp
    }
    fn nested_begin(&mut self, col: usize, is_record: bool, len: usize) -> bool {
        if self.nest.is_some() {
            return false; // a list inside a list arrives as JSON text
        }
        let _ = len;
        self.nest = Some(Nest {
            is_record,
            list: PyList::empty(self.py),
            cur: None,
            key: None,
            col,
        });
        true
    }
    fn nested_elem_begin(&mut self) {
        if let Some(n) = &mut self.nest {
            n.cur = Some(PyDict::new(self.py))
        }
    }
    fn nested_key(&mut self, field: usize, name: &str) {
        let Some(n) = &mut self.nest else { return };
        if self.nkeys.len() <= n.col {
            self.nkeys.resize_with(n.col + 1, Vec::new)
        }
        let slots = &mut self.nkeys[n.col];
        if slots.len() <= field {
            slots.resize_with(field + 1, || None)
        }
        let py = self.py;
        match &slots[field] {
            Some((cached, key)) if cached == name => n.key = Some(key.clone_ref(py)),
            _ => {
                let key = PyString::intern(py, name).unbind();
                n.key = Some(key.clone_ref(py));
                slots[field] = Some((name.to_string(), key))
            }
        }
    }
    fn nested_elem_end(&mut self) {
        if let Some(n) = &mut self.nest {
            if !n.is_record {
                if let Some(d) = n.cur.take() {
                    if let Err(e) = n.list.append(d) {
                        self.err.get_or_insert(e);
                    }
                }
            }
        }
    }
    fn nested_end(&mut self, col: usize) {
        if let Some(n) = self.nest.take() {
            let value = match (n.is_record, n.cur) {
                (true, Some(d)) => d.into_any(),
                (true, None) => PyDict::new(self.py).into_any(),
                (false, _) => n.list.into_any(),
            };
            self.put(col, Ok(value))
        }
    }
    #[inline]
    fn boolean(&mut self, col: usize, v: bool) {
        let o = PyBool::new(self.py, v).to_owned().into_any();
        self.put(col, Ok(o))
    }
    #[inline]
    fn int(&mut self, col: usize, v: i64) {
        let o = v
            .into_pyobject(self.py)
            .map(|o| o.into_any())
            .map_err(Into::into);
        self.put(col, o)
    }
    #[inline]
    fn float(&mut self, col: usize, v: f64) {
        let o = PyFloat::new(self.py, v).into_any();
        self.put(col, Ok(o))
    }
    #[inline]
    fn str(&mut self, col: usize, s: &str) {
        let o = PyString::new(self.py, s).into_any();
        self.put(col, Ok(o))
    }
    fn dict_str(
        &mut self,
        col: usize,
        seg: usize,
        code: u32,
        dict_len: usize,
        value: &mut dyn FnMut() -> String,
    ) {
        if self.nest.is_some() {
            // a dictionary-coded field of a nested record: few distinct values, so intern them
            let o = PyString::intern(self.py, &value()).into_any();
            return self.put(col, Ok(o));
        }
        if !self.use_cache {
            let o = PyString::new(self.py, &value()).into_any();
            return self.put(col, Ok(o));
        }
        if self.cache.is_empty() {
            self.cache = (0..self.keys.len()).map(|_| (usize::MAX, vec![])).collect()
        }
        let slot = &mut self.cache[col];
        if slot.0 != seg {
            *slot = (seg, (0..dict_len).map(|_| None).collect())
        }
        let py = self.py;
        let o = slot.1[code as usize]
            .get_or_insert_with(|| PyString::new(py, &value()).unbind())
            .bind(py)
            .clone()
            .into_any();
        self.put(col, Ok(o))
    }
    fn other(&mut self, col: usize, c: &Cell) {
        let o = from_cell(self.py, c.clone()).map(|o| o.into_bound(self.py));
        self.put(col, o)
    }
}

impl PyTable {
    fn sync_keys(&mut self, py: Python<'_>) -> PyResult<()> {
        if self.keys.len() == self.t.names().len() && self.template.is_some() {
            return Ok(());
        }
        while self.keys.len() < self.t.names().len() {
            let k = PyString::intern(py, &self.t.names()[self.keys.len()]).unbind();
            self.keys.push(k)
        }
        let d = PyDict::new(py);
        for k in &self.keys {
            d.set_item(k.bind(py), py.None())?
        }
        self.template = Some(d.unbind());
        Ok(())
    }
    fn push(&mut self, row: &Bound<'_, PyDict>) -> PyResult<()> {
        for (j, (k, v)) in row.iter().enumerate() {
            let c = match self.seen_keys.get(j) {
                Some((seen, c)) if seen.as_ptr() == k.as_ptr() => Ok(*c),
                _ => k
                    .downcast::<PyString>()
                    .map_err(|_| PyTypeError::new_err("record keys must be str"))
                    .and_then(|ks| {
                        let c = self.t.col_for(&ks.to_cow()?);
                        if j < 4096 {
                            if j < self.seen_keys.len() {
                                self.seen_keys[j] = (k.clone().unbind(), c)
                            } else if j == self.seen_keys.len() {
                                self.seen_keys.push((k.clone().unbind(), c))
                            }
                        }
                        Ok(c)
                    }),
            };
            let r = c.and_then(|c| {
                if v.is_exact_instance_of::<PyString>() {
                    self.t.put_str_cell(c, v.downcast::<PyString>()?)?
                } else {
                    let cell = match (to_cell(&v), &self.conv) {
                        (Err(_), Some(f)) => to_cell_with(&v, f.bind(v.py()))?,
                        (r, _) => r?,
                    };
                    self.t.put_at(c, cell)
                }
                Ok(())
            });
            if let Err(e) = r {
                self.t.abort_row();
                return Err(e);
            }
        }
        self.t.end_row();
        Ok(())
    }
    /// One JSON record from text. Text the native parser rejects gets a second chance with Python's `json.loads`,
    /// which also accepts `NaN` and `Infinity`; if that fails too, the native error is reported.
    fn push_text(&mut self, py: Python<'_>, line: &str, lineno: usize) -> PyResult<()> {
        let Err(e) = push_line(&mut self.t, line, self.only.as_ref()) else {
            return Ok(());
        };
        let err = || PyValueError::new_err(format!("line {lineno}: {e}"));
        let v = py
            .import("json")?
            .getattr("loads")?
            .call1((line,))
            .map_err(|_| err())?;
        let d = v.downcast::<PyDict>().map_err(|_| err())?;
        let Some(only) = &self.only else {
            return self.push(d);
        };
        let kept = PyDict::new(py);
        for (k, v) in d.iter() {
            if k.downcast::<PyString>()
                .is_ok_and(|k| k.to_cow().is_ok_and(|k| only.contains(&*k)))
            {
                kept.set_item(k, v)?
            }
        }
        self.push(&kept)
    }
    fn push_any(&mut self, py: Python<'_>, row: &Bound<'_, PyAny>) -> PyResult<()> {
        match row.downcast::<PyDict>() {
            Ok(d) => self.push(d),
            Err(_) => {
                let d = py.get_type::<PyDict>().call1((row,))?;
                self.push(d.downcast::<PyDict>()?)
            }
        }
    }
    /// Load records with the parsing and packing spread over threads. `next_piece(rows)` cuts the next piece of that
    /// many records from the mapped file; each piece becomes a small table on a worker, and the pieces are joined
    /// here in file order. A piece of lines that the fast parser rejects is redone on this thread, so results and
    /// errors match a one-thread load; a piece of array elements that fails ends the load with `Redo`.
    fn load_pieces<'a>(
        &mut self,
        py: Python<'_>,
        threads: usize,
        mut next_piece: impl FnMut(usize) -> Result<Option<Piece<'a>>, Redo>,
    ) -> PyResult<Result<usize, Redo>> {
        use std::sync::mpsc;
        const ROWS: usize = packmem::dynamic::CHUNK;
        let hint = self.t.hint;
        let only = self.only.clone();
        let (work_tx, work_rx) = mpsc::sync_channel::<(usize, Piece<'a>)>(1);
        let work_rx = std::sync::Mutex::new(work_rx);
        let (done_tx, done_rx) = mpsc::channel::<(usize, Piece<'a>, Option<DynTable>)>();
        std::thread::scope(|sc| {
            for _ in 0..threads {
                let (work_rx, done_tx, only) = (&work_rx, done_tx.clone(), &only);
                sc.spawn(move || {
                    let mut spare = packmem::dynamic::Buffers::default();
                    loop {
                        let Ok((i, piece)) = work_rx.lock().unwrap().recv() else {
                            packmem::dynamic::release_thread_buffers();
                            return;
                        };
                        let mut t = DynTable::new(hint);
                        t.reuse_buffers(std::mem::take(&mut spare));
                        t.set_bulk(true);
                        let ok = piece.records(|r| {
                            std::str::from_utf8(r)
                                .is_ok_and(|r| push_line(&mut t, r, only.as_ref()).is_ok())
                        });
                        spare = t.take_buffers();
                        if done_tx.send((i, piece, ok.then_some(t))).is_err() {
                            return;
                        }
                    }
                });
            }
            drop(done_tx);
            let mut pending = std::collections::BTreeMap::new();
            let (mut more, mut sent, mut joined, mut n) = (true, 0usize, 0usize, 0usize);
            let r = (|| -> PyResult<Result<usize, Redo>> {
                while more || joined < sent {
                    if more {
                        // the first piece brings the table to a chunk boundary, so later pieces can be moved in whole
                        let want = if sent == 0 {
                            ROWS - self.t.len() % ROWS
                        } else {
                            ROWS
                        };
                        match next_piece(want) {
                            Ok(Some(piece)) => {
                                work_tx.send((sent, piece)).expect("load threads stopped");
                                sent += 1
                            }
                            Ok(None) => more = false,
                            Err(Redo) => return Ok(Err(Redo)),
                        }
                    }
                    let mut next = if !more && joined < sent && pending.is_empty() {
                        Some(done_rx.recv().map_err(|_| {
                            pyo3::exceptions::PyRuntimeError::new_err("a load thread stopped early")
                        })?)
                    } else {
                        done_rx.try_recv().ok()
                    };
                    while let Some((i, piece, t)) = next {
                        pending.insert(i, (piece, t));
                        next = done_rx.try_recv().ok()
                    }
                    while let Some((piece, t)) = pending.remove(&joined) {
                        joined += 1;
                        if let Some(t) = t {
                            n += t.len();
                            self.t.append_table(t);
                            continue;
                        }
                        let Piece::Lines(text) = piece else {
                            return Ok(Err(Redo));
                        };
                        let text = std::str::from_utf8(text)
                            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
                        for l in text.lines().filter(|l| !blank(l.as_bytes())) {
                            self.push_text(py, l, n + 1)?;
                            n += 1
                        }
                    }
                }
                Ok(Ok(n))
            })();
            drop(work_tx);
            r
        })
    }
    fn load_jsonl_threads(
        &mut self,
        py: Python<'_>,
        f: &std::fs::File,
        threads: usize,
    ) -> PyResult<usize> {
        // SAFETY: the mapping is read-only and private to this call; as with any reader, the file must not be
        // truncated while it is being loaded.
        let map = unsafe { memmap2::Mmap::map(f)? };
        let (data, mut pos): (&[u8], usize) = (&map, 0);
        let r = self.load_pieces(py, threads, |want| {
            let (start, mut rows) = (pos, 0);
            while rows < want && pos < data.len() {
                let end = data[pos..]
                    .iter()
                    .position(|&b| b == b'\n')
                    .map_or(data.len(), |k| pos + k + 1);
                rows += !blank(&data[pos..end]) as usize;
                pos = end
            }
            Ok((rows > 0).then(|| Piece::Lines(&data[start..pos])))
        })?;
        Ok(r.unwrap_or_else(|Redo| unreachable!("pieces of lines are redone in place")))
    }
    /// The threaded load of a file holding one JSON array of objects, into an empty table. `Redo` means the file is
    /// not laid out as this expects or holds something the fast parser rejects: the caller loads it on one thread
    /// instead, which also produces the error message if the file is wrong.
    fn load_json_array_threads(
        &mut self,
        py: Python<'_>,
        f: &std::fs::File,
        threads: usize,
    ) -> PyResult<Result<usize, Redo>> {
        // SAFETY: as in `load_jsonl_threads`.
        let map = unsafe { memmap2::Mmap::map(f)? };
        let data: &[u8] = &map;
        let skip = |mut p: usize| {
            while data.get(p).is_some_and(u8::is_ascii_whitespace) {
                p += 1
            }
            p
        };
        let mut pos = skip(0);
        if data.get(pos) != Some(&b'[') {
            return Ok(Err(Redo));
        }
        pos = skip(pos + 1);
        let mut closed = false;
        self.load_pieces(py, threads, |want| {
            let mut items = Vec::with_capacity(want);
            while items.len() < want && !closed {
                match data.get(pos) {
                    Some(b']') => {
                        closed = true;
                        if skip(pos + 1) != data.len() {
                            return Err(Redo);
                        }
                        break;
                    }
                    Some(b'{') => {}
                    _ => return Err(Redo),
                }
                let end = object_end(data, pos).ok_or(Redo)?;
                items.push((pos, end));
                pos = skip(end);
                match data.get(pos) {
                    Some(b',') => {
                        pos = skip(pos + 1);
                        if data.get(pos) != Some(&b'{') {
                            return Err(Redo);
                        }
                    }
                    Some(b']') => {}
                    _ => return Err(Redo),
                }
            }
            Ok((!items.is_empty()).then(|| Piece::Items(data, items)))
        })
    }
    /// Run a bulk load: rows are packed a chunk at a time, and whatever was loaded before an error stays consistent.
    fn bulk<T>(&mut self, py: Python<'_>, f: impl FnOnce(&mut Self) -> PyResult<T>) -> PyResult<T> {
        // Packing text-heavy chunks on a background thread makes such loads about twice as fast, but on macOS the
        // extra buffers stay counted against the process after they are freed. Memory is the point of this library,
        // so the thread is opt-in: PACKMEM_LOAD_THREADS=1 (or more). The table is not readable until the load ends.
        let spare = std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .saturating_sub(1);
        let threads = std::env::var("PACKMEM_LOAD_THREADS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        self.t.set_bulk_parallel(threads.min(spare));
        let r = f(self);
        self.t.set_bulk(false);
        self.sync_keys(py)?;
        r
    }
    fn visit<'py>(
        &self,
        py: Python<'py>,
        out: &Bound<'py, PyList>,
        use_cache: bool,
        ranges: impl Iterator<Item = (usize, usize)>,
    ) -> PyResult<()> {
        let empty;
        let template = match &self.template {
            Some(t) => t.bind(py),
            None => {
                empty = PyDict::new(py);
                &empty
            }
        };
        let mut sink = DictSink::new(py, &self.keys, template, out, use_cache);
        for (a, b) in ranges {
            self.t.visit_rows(a, b, &mut sink)
        }
        sink.finish()
    }
    fn guard(&self) -> PyResult<()> {
        if self.frozen {
            return Err(PyTypeError::new_err("this table is shared read-only; call unshare() on the original, or copy() it, to change it"));
        }
        Ok(())
    }
    fn check(&self, i: usize) -> PyResult<()> {
        if i >= self.t.len() {
            Err(PyIndexError::new_err("row index out of range"))
        } else {
            Ok(())
        }
    }
}

#[pymethods]
impl PyTable {
    #[new]
    #[pyo3(signature = (hint = "balanced"))]
    fn new(hint: &str) -> PyResult<Self> {
        Ok(PyTable {
            t: DynTable::new(hint_of(hint)?),
            keys: vec![],
            template: None,
            seen_keys: vec![],
            frozen: false,
            only: None,
            conv: None,
        })
    }
    fn __len__(&self) -> usize {
        self.t.len()
    }
    #[pyo3(signature = (row, default = None))]
    fn append(
        &mut self,
        py: Python<'_>,
        row: &Bound<'_, PyAny>,
        default: Option<PyObject>,
    ) -> PyResult<()> {
        self.guard()?;
        self.conv = default;
        let r = self.push_any(py, row);
        self.conv = None;
        self.sync_keys(py)?;
        r
    }
    #[pyo3(signature = (rows, default = None))]
    fn extend(
        &mut self,
        py: Python<'_>,
        rows: &Bound<'_, PyAny>,
        default: Option<PyObject>,
    ) -> PyResult<usize> {
        self.guard()?;
        self.conv = default;
        let r = self.bulk(py, |s| {
            let mut n = 0;
            for r in rows.try_iter()? {
                s.push_any(py, &r?)?;
                n += 1
            }
            Ok(n)
        });
        self.conv = None;
        r
    }
    /// Rows given as sequences of values aligned with `names` (what a DB-API cursor yields): no dict is built per row.
    #[pyo3(signature = (names, rows, default = None))]
    fn extend_rows(
        &mut self,
        py: Python<'_>,
        names: Vec<String>,
        rows: &Bound<'_, PyAny>,
        default: Option<Bound<'_, PyAny>>,
    ) -> PyResult<usize> {
        self.guard()?;
        // resolve the columns once; every row then writes by position
        let cols: Vec<usize> = names.iter().map(|n| self.t.col_for(n)).collect();
        self.t.abort_row();
        self.bulk(py, |s| {
            let mut n = 0;
            for row in rows.try_iter()? {
                let row = row?;
                let mut i = 0;
                let mut put = |s: &mut Self, v: &Bound<'_, PyAny>| -> PyResult<()> {
                    let c = *cols.get(i).ok_or_else(|| {
                        PyValueError::new_err("row has more values than there are column names")
                    })?;
                    if v.is_exact_instance_of::<PyString>() {
                        s.t.put_str_cell(c, v.downcast::<PyString>()?)?
                    } else {
                        let cell = match (to_cell(v), &default) {
                            (Err(_), Some(f)) => to_cell(&f.call1((v,))?)?,
                            (r, _) => r?,
                        };
                        s.t.put_at(c, cell)
                    }
                    i += 1;
                    Ok(())
                };
                let r = (|| -> PyResult<()> {
                    if let Ok(t) = row.downcast_exact::<PyTuple>() {
                        for v in t.iter_borrowed() {
                            put(s, &v)?
                        }
                    } else {
                        for v in row.try_iter()? {
                            put(s, &v?)?
                        }
                    }
                    Ok(())
                })();
                let r = r.and_then(|_| {
                    if i == cols.len() {
                        Ok(())
                    } else {
                        Err(PyValueError::new_err(
                            "row has fewer values than there are column names",
                        ))
                    }
                });
                if let Err(e) = r {
                    s.t.abort_row();
                    return Err(e);
                }
                s.t.end_row();
                n += 1
            }
            Ok(n)
        })
    }
    /// Parse a CSV file in native code. Without `infer` every value is a string, as csv.DictReader gives.
    fn load_csv_path(
        &mut self,
        py: Python<'_>,
        path: &str,
        delimiter: &str,
        infer: bool,
    ) -> PyResult<usize> {
        self.guard()?;
        let &[delimiter] = delimiter.as_bytes() else {
            return Err(PyValueError::new_err(
                "delimiter must be one ASCII character",
            ));
        };
        let mut f = std::fs::File::open(path)?;
        self.bulk(py, |s| {
            let opts = CsvOptions {
                delimiter,
                default_type: if infer { ColType::Infer } else { ColType::Text },
                ..Default::default()
            };
            let mut loader = CsvLoader::new(opts).map_err(PyValueError::new_err)?;
            let mut buf = vec![0u8; 1 << 20];
            loop {
                let n = std::io::Read::read(&mut f, &mut buf)?;
                if n == 0 {
                    break;
                }
                loader
                    .feed(&mut s.t, &buf[..n])
                    .map_err(PyValueError::new_err)?;
            }
            loader.finish(&mut s.t).map_err(PyValueError::new_err)
        })
    }
    /// Parse a JSON-lines file in native code; no Python objects are created per record.
    fn load_jsonl_path(&mut self, py: Python<'_>, path: &str) -> PyResult<usize> {
        self.guard()?;
        let f = std::fs::File::open(path)?;
        // each load thread keeps its own row buffers, and macOS goes on counting them after they are freed, so loading
        // uses at most four threads however many cores there are
        let threads = packmem::dynamic::query_threads().min(4);
        if threads > 1 && f.metadata()?.len() >= PARALLEL_LOAD_BYTES {
            return self.bulk(py, |s| s.load_jsonl_threads(py, &f, threads));
        }
        self.bulk(py, |s| {
            let mut rd = BufReader::with_capacity(1 << 20, f);
            let (mut line, mut n) = (String::new(), 0);
            loop {
                line.clear();
                if rd.read_line(&mut line)? == 0 {
                    return Ok(n);
                }
                if line.trim().is_empty() {
                    continue;
                }
                s.push_text(py, &line, n + 1)?;
                n += 1
            }
        })
    }
    fn append_json(&mut self, py: Python<'_>, line: &str) -> PyResult<()> {
        self.guard()?;
        let r = self.push_text(py, line, 1);
        self.sync_keys(py)?;
        r
    }
    /// Parse many JSON lines from any iterable of str or bytes.
    fn extend_json(&mut self, py: Python<'_>, lines: &Bound<'_, PyAny>) -> PyResult<usize> {
        self.guard()?;
        self.bulk(py, |s| {
            let mut n = 0;
            for l in lines.try_iter()? {
                let l = l?;
                let text = match l.downcast::<PyString>() {
                    Ok(t) => t.to_cow()?.into_owned(),
                    Err(_) => String::from_utf8(l.extract::<Vec<u8>>()?)
                        .map_err(|e| PyValueError::new_err(e.to_string()))?,
                };
                if text.trim().is_empty() {
                    continue;
                }
                s.push_text(py, &text, n + 1)?;
                n += 1
            }
            Ok(n)
        })
    }
    /// Parse a file holding one JSON array of objects, streaming element by element.
    fn load_json_array_path(&mut self, py: Python<'_>, path: &str) -> PyResult<usize> {
        self.guard()?;
        let f = std::fs::File::open(path)?;
        let threads = packmem::dynamic::query_threads().min(4);
        if threads > 1 && self.t.len() == 0 && f.metadata()?.len() >= PARALLEL_LOAD_BYTES {
            if let Ok(n) = self.bulk(py, |s| s.load_json_array_threads(py, &f, threads))? {
                return Ok(n);
            }
            self.t = DynTable::new(self.t.hint);
            self.keys.clear();
            self.template = None;
            self.seen_keys.clear();
        }
        self.bulk(py, |s| {
            let mut de =
                serde_json::Deserializer::from_reader(BufReader::with_capacity(1 << 20, f));
            let n = ArraySink(&mut s.t, s.only.as_ref())
                .deserialize(&mut de)
                .map_err(|e| PyValueError::new_err(e.to_string()))?;
            de.end().map_err(|e| PyValueError::new_err(e.to_string()))?;
            Ok(n)
        })
    }
    /// Same, reading from any Python file object.
    fn load_json_array_file(&mut self, py: Python<'_>, f: &Bound<'_, PyAny>) -> PyResult<usize> {
        self.guard()?;
        self.bulk(py, |s| {
            let mut de = serde_json::Deserializer::from_reader(PyReader {
                f: f.clone(),
                buf: vec![],
                pos: 0,
            });
            let n = ArraySink(&mut s.t, s.only.as_ref())
                .deserialize(&mut de)
                .map_err(|e| PyValueError::new_err(e.to_string()))?;
            de.end().map_err(|e| PyValueError::new_err(e.to_string()))?;
            Ok(n)
        })
    }
    fn row<'py>(&self, py: Python<'py>, i: usize) -> PyResult<Bound<'py, PyAny>> {
        self.check(i)?;
        let l = PyList::empty(py);
        self.visit(py, &l, false, std::iter::once((i, i + 1)))?;
        l.get_item(0)
    }
    /// Rows a..b as dicts. Dictionary-encoded strings are turned into Python strings once per chunk and shared.
    fn rows_range<'py>(&self, py: Python<'py>, a: usize, b: usize) -> PyResult<Bound<'py, PyList>> {
        let l = PyList::empty(py);
        self.visit(py, &l, b.saturating_sub(a) >= 64, std::iter::once((a, b)))?;
        Ok(l)
    }
    /// Rows `a..b` as JSON objects separated by commas (no surrounding brackets), as bytes.
    fn json_range<'py>(&self, py: Python<'py>, a: usize, b: usize) -> Bound<'py, PyBytes> {
        let mut sink = JsonSink::new(self.t.names(), b.saturating_sub(a) >= 64);
        self.t.visit_rows(a, b, &mut sink);
        PyBytes::new(py, &sink.out)
    }
    /// Selected rows `start..stop` (positions within the selection) as comma-separated JSON objects.
    fn json_sel<'py>(
        &self,
        py: Python<'py>,
        sel: PyRef<'_, Selection>,
        start: usize,
        stop: usize,
    ) -> Bound<'py, PyBytes> {
        let ids = &sel.ids[start.min(sel.ids.len())..stop.min(sel.ids.len())];
        let mut sink = JsonSink::new(self.t.names(), ids.len() >= 64);
        for &i in ids {
            self.t.visit_rows(i as usize, i as usize + 1, &mut sink)
        }
        PyBytes::new(py, &sink.out)
    }
    #[pyo3(signature = (sel, limit = None, offset = 0))]
    fn rows<'py>(
        &self,
        py: Python<'py>,
        sel: PyRef<'_, Selection>,
        limit: Option<usize>,
        offset: usize,
    ) -> PyResult<Bound<'py, PyList>> {
        let l = PyList::empty(py);
        self.visit(
            py,
            &l,
            sel.ids.len() >= 64,
            sel.ids
                .iter()
                .skip(offset)
                .take(limit.unwrap_or(usize::MAX))
                .map(|&i| (i as usize, i as usize + 1)),
        )?;
        Ok(l)
    }
    fn cell(&self, py: Python<'_>, i: usize, name: &str) -> PyResult<PyObject> {
        self.check(i)?;
        match self.t.col_index(name) {
            Some(c) => from_cell(py, self.t.get(i, c)),
            None => Ok(py.None()),
        }
    }
    fn set_cell(
        &mut self,
        py: Python<'_>,
        i: usize,
        name: &str,
        v: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        self.guard()?;
        self.check(i)?;
        self.t.set_by_name(i, name, to_cell(v)?);
        self.sync_keys(py)
    }
    /// Replace a whole record: keys not present in `row` become absent.
    fn set_row(&mut self, py: Python<'_>, i: usize, row: &Bound<'_, PyDict>) -> PyResult<()> {
        self.guard()?;
        self.check(i)?;
        let mut cells: Vec<(String, Cell)> = vec![];
        for (k, v) in row.iter() {
            cells.push((k.extract()?, to_cell(&v)?))
        }
        for c in 0..self.t.names().len() {
            let name = self.t.names()[c].clone();
            if !cells.iter().any(|(k, _)| *k == name) && self.t.get(i, c) != Cell::Missing {
                self.t.set(i, c, Cell::Missing)
            }
        }
        for (k, v) in cells {
            self.t.set_by_name(i, &k, v)
        }
        self.sync_keys(py)
    }
    fn names(&self) -> Vec<String> {
        self.t.names().to_vec()
    }
    fn all(&self) -> Selection {
        Selection {
            ids: (0..self.t.len() as u32).collect(),
        }
    }
    /// Row numbers where `name <op> value` holds. Runs on the packed data where the encoding allows.
    fn select(&self, name: &str, op: &str, value: &Bound<'_, PyAny>) -> PyResult<Selection> {
        let inf = f64::INFINITY;
        let pred = match op {
            "eq" => Pred::Eq(to_cell(value)?),
            "prefix" => Pred::Prefix(value.extract()?),
            "contains" => Pred::Contains(value.extract()?),
            "gte" => Pred::Range {
                lo: num(value)?,
                hi: inf,
                lo_incl: true,
                hi_incl: true,
            },
            "gt" => Pred::Range {
                lo: num(value)?,
                hi: inf,
                lo_incl: false,
                hi_incl: true,
            },
            "lte" => Pred::Range {
                lo: -inf,
                hi: num(value)?,
                lo_incl: true,
                hi_incl: true,
            },
            "lt" => Pred::Range {
                lo: -inf,
                hi: num(value)?,
                lo_incl: true,
                hi_incl: false,
            },
            "between" => {
                let t = value
                    .downcast::<PyTuple>()
                    .map_err(|_| PyTypeError::new_err("between needs a (low, high) tuple"))?;
                if t.len() != 2 {
                    return Err(PyTypeError::new_err("between needs a (low, high) tuple"));
                }
                Pred::Range {
                    lo: num(&t.get_item(0)?)?,
                    hi: num(&t.get_item(1)?)?,
                    lo_incl: true,
                    hi_incl: true,
                }
            }
            _ => return Err(PyValueError::new_err(format!("unknown filter '{op}'"))),
        };
        Ok(Selection {
            ids: match self.t.col_index(name) {
                Some(c) => self.t.select(c, &pred),
                None => vec![],
            },
        })
    }
    #[pyo3(signature = (name, sel = None))]
    fn sum(
        &self,
        py: Python<'_>,
        name: &str,
        sel: Option<PyRef<'_, Selection>>,
    ) -> PyResult<PyObject> {
        let Some(c) = self.t.col_index(name) else {
            return Ok(0i64.into_pyobject(py)?.into_any().unbind());
        };
        Ok(match self.t.sum(c, sel.as_ref().map(|s| &s.ids[..])) {
            Num::Int(i) => match i64::try_from(i) {
                Ok(v) => v.into_pyobject(py)?.into_any().unbind(),
                Err(_) => py.get_type::<PyInt>().call1((i.to_string(),))?.unbind(),
            },
            Num::Float(f) => f.into_pyobject(py)?.into_any().unbind(),
        })
    }
    #[pyo3(signature = (name, sel = None))]
    fn group_count<'py>(
        &self,
        py: Python<'py>,
        name: &str,
        sel: Option<PyRef<'_, Selection>>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let d = PyDict::new(py);
        if let Some(c) = self.t.col_index(name) {
            for (k, n) in self.t.group_count(c, sel.as_ref().map(|s| &s.ids[..])) {
                // nested values are keyed by their JSON text; keys that compare equal in Python (1, 1.0, True) share a count, as in a dict
                let key = match k {
                    Cell::Json(s) if s.starts_with('[') || s.starts_with('{') => {
                        PyString::new(py, &s).into_any().unbind()
                    }
                    Cell::Missing => continue,
                    other => from_cell(py, other)?,
                };
                let prev: usize = match d.get_item(&key)? {
                    Some(v) => v.extract()?,
                    None => 0,
                };
                d.set_item(key, prev + n)?
            }
        }
        Ok(d)
    }
    #[pyo3(signature = (name, sel = None))]
    fn column<'py>(
        &self,
        py: Python<'py>,
        name: &str,
        sel: Option<PyRef<'_, Selection>>,
    ) -> PyResult<Bound<'py, PyList>> {
        let l = PyList::empty(py);
        let Some(c) = self.t.col_index(name) else {
            return Ok(l);
        };
        match sel {
            Some(s) => {
                for &i in &s.ids {
                    l.append(from_cell(py, self.t.get(i as usize, c))?)?
                }
            }
            None => {
                for i in 0..self.t.len() {
                    l.append(from_cell(py, self.t.get(i, c))?)?
                }
            }
        }
        Ok(l)
    }
    /// The column as Arrow buffers, built without a Python object per value: (kind, nulls, validity, buffers...)
    /// with kind "null", "bool", "int", "float" or "str". None when the column holds anything else (nested values,
    /// text mixed with numbers, integers beyond 64 bits), which the caller converts value by value.
    fn arrow_buffers<'py>(
        &self,
        py: Python<'py>,
        name: &str,
    ) -> PyResult<Option<Bound<'py, PyTuple>>> {
        enum B {
            Null,
            Bool(Vec<u8>),
            Int(Vec<i64>),
            Float(Vec<f64>),
            Str(Vec<i32>, Vec<u8>),
        }
        let Some(c) = self.t.col_index(name) else {
            return Ok(None);
        };
        let n = self.t.len();
        let (mut b, mut valid, mut nulls) = (B::Null, vec![0u8; n.div_ceil(8)], 0usize);
        for i in 0..n {
            let cell = self.t.get(i, c);
            if matches!(cell, Cell::Missing | Cell::Null) {
                nulls += 1;
                match &mut b {
                    B::Int(v) => v.push(0),
                    B::Float(v) => v.push(0.0),
                    B::Str(o, d) => o.push(d.len() as i32),
                    B::Null | B::Bool(_) => {}
                }
                continue;
            }
            valid[i / 8] |= 1 << (i % 8);
            match (&mut b, cell) {
                (B::Null, Cell::Bool(x)) => {
                    let mut v = vec![0u8; n.div_ceil(8)];
                    v[i / 8] |= (x as u8) << (i % 8);
                    b = B::Bool(v)
                }
                (B::Null, Cell::Int(x)) => {
                    let mut v = vec![0; i];
                    v.reserve(n - i);
                    v.push(x);
                    b = B::Int(v)
                }
                (B::Null, Cell::Float(x)) => {
                    let mut v = vec![0.0; i];
                    v.reserve(n - i);
                    v.push(x);
                    b = B::Float(v)
                }
                (B::Null, Cell::Str(x)) => {
                    let mut o = vec![0i32; i + 1];
                    o.reserve(n - i);
                    o.push(x.len() as i32);
                    b = B::Str(o, x.into_bytes())
                }
                (B::Bool(v), Cell::Bool(x)) => v[i / 8] |= (x as u8) << (i % 8),
                (B::Int(v), Cell::Int(x)) => v.push(x),
                (B::Float(v), Cell::Float(x)) => v.push(x),
                (B::Float(v), Cell::Int(x)) => v.push(x as f64),
                (B::Int(v), Cell::Float(x)) => {
                    let mut f: Vec<f64> = v.iter().map(|&x| x as f64).collect();
                    f.reserve(n - i);
                    f.push(x);
                    b = B::Float(f)
                }
                (B::Str(o, d), Cell::Str(x)) if d.len() + x.len() <= i32::MAX as usize => {
                    d.extend_from_slice(x.as_bytes());
                    o.push(d.len() as i32)
                }
                _ => return Ok(None),
            }
        }
        fn raw<'py, T>(py: Python<'py>, v: &[T]) -> Bound<'py, PyAny> {
            // SAFETY: plain numbers viewed as their bytes, in the machine's byte order, which Arrow shares on the
            // little-endian platforms packmem builds for.
            let bytes = unsafe {
                std::slice::from_raw_parts(v.as_ptr().cast::<u8>(), std::mem::size_of_val(v))
            };
            PyBytes::new(py, bytes).into_any()
        }
        let validity = if nulls == 0 {
            py.None().into_bound(py)
        } else {
            raw(py, &valid)
        };
        let (kind, bufs) = match &b {
            B::Null => ("null", vec![]),
            B::Bool(v) => ("bool", vec![raw(py, v)]),
            B::Int(v) => ("int", vec![raw(py, v)]),
            B::Float(v) => ("float", vec![raw(py, v)]),
            B::Str(o, d) => ("str", vec![raw(py, o), raw(py, d)]),
        };
        let mut items = vec![
            kind.into_pyobject(py)?.into_any(),
            nulls.into_pyobject(py)?.into_any(),
            validity,
        ];
        items.extend(bufs);
        Ok(Some(PyTuple::new(py, items)?))
    }
    /// Per row: is the key present and not null? A column that does not exist gives all False.
    fn notna(&self, name: &str) -> Vec<bool> {
        match self.t.col_index(name) {
            Some(c) => self.t.notna(c),
            None => vec![false; self.t.len()],
        }
    }
    /// Per row: the length of its list value, or None when it is not a list.
    fn list_len(&self, name: &str) -> Vec<Option<u32>> {
        match self.t.col_index(name) {
            Some(c) => self.t.list_len(c),
            None => vec![None; self.t.len()],
        }
    }
    /// Per row: the sum over the records of its list value of a measure ("words", "chars" or "bytes") of a string field.
    fn list_str_sum(&self, name: &str, field: &str, measure: &str) -> PyResult<Vec<Option<i64>>> {
        let m = match measure {
            "words" => StrMeasure::Words,
            "chars" => StrMeasure::Chars,
            "bytes" => StrMeasure::Bytes,
            _ => {
                return Err(PyValueError::new_err(
                    "measure must be 'words', 'chars' or 'bytes'",
                ))
            }
        };
        Ok(match self.t.col_index(name) {
            Some(c) => self.t.list_str_sum(c, field, m),
            None => vec![None; self.t.len()],
        })
    }
    /// The rows at the given positions, in that order, as dicts: one call for a whole batch.
    fn rows_at<'py>(&self, py: Python<'py>, ids: Vec<usize>) -> PyResult<Bound<'py, PyList>> {
        let n = self.t.len();
        if let Some(&bad) = ids.iter().find(|&&i| i >= n) {
            return Err(PyIndexError::new_err(format!(
                "row index {bad} out of range"
            )));
        }
        let l = PyList::empty(py);
        // random positions jump between chunks, where a per-chunk string cache would be rebuilt at every step
        self.visit(py, &l, false, ids.iter().map(|&i| (i, i + 1)))?;
        Ok(l)
    }
    /// Rows a..b as lazy `Row` objects.
    fn rows_lazy<'py>(slf: &Bound<'py, Self>, a: usize, b: usize) -> PyResult<Bound<'py, PyList>> {
        let py = slf.py();
        let n = slf.borrow().t.len();
        let l = PyList::empty(py);
        for i in a..b.min(n) {
            l.append(Py::new(
                py,
                Row {
                    t: slf.clone().unbind(),
                    i,
                },
            )?)?
        }
        Ok(l)
    }
    /// Set a whole column to one value.
    fn fill_column(
        &mut self,
        py: Python<'_>,
        name: &str,
        value: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        self.guard()?;
        let cell = to_cell(value)?;
        self.t.set_column(name, |_| cell.clone());
        self.sync_keys(py)
    }
    /// Set a whole column from one value per row.
    fn set_column(
        &mut self,
        py: Python<'_>,
        name: &str,
        values: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        self.guard()?;
        let mut cells = Vec::with_capacity(self.t.len());
        for v in values.try_iter()? {
            cells.push(to_cell(&v?)?)
        }
        if cells.len() != self.t.len() {
            return Err(PyValueError::new_err(format!(
                "{} values for {} rows",
                cells.len(),
                self.t.len()
            )));
        }
        self.t
            .set_column(name, |i| std::mem::replace(&mut cells[i], Cell::Missing));
        self.sync_keys(py)
    }
    /// A new table holding the given rows, in the given order.
    fn take(&self, py: Python<'_>, order: Vec<u32>) -> PyResult<PyTable> {
        let n = self.t.len();
        if order.iter().any(|&r| r as usize >= n) {
            return Err(PyIndexError::new_err("row index out of range"));
        }
        let mut t = PyTable {
            t: self.t.take(&order),
            keys: vec![],
            template: None,
            seen_keys: vec![],
            frozen: false,
            only: None,
            conv: None,
        };
        t.sync_keys(py)?;
        Ok(t)
    }
    /// Append every row of another table natively.
    fn extend_table(&mut self, py: Python<'_>, other: &Bound<'_, PyTable>) -> PyResult<()> {
        self.guard()?;
        let o = other
            .try_borrow()
            .map_err(|_| PyValueError::new_err("cannot extend a table with itself"))?;
        self.t.extend_from(&o.t);
        drop(o);
        self.sync_keys(py)
    }
    /// The packed columns as bytes, without re-encoding. Packs any rows still held uncompressed first.
    fn to_bytes<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        // written straight into the bytes object: one copy of the packed size, nothing left behind
        let n = self.t.byte_len();
        PyBytes::new_with(py, n, |out| {
            self.t.write_bytes(out);
            Ok(())
        })
    }
    /// Write the packed columns to a file other processes can attach to. Returns the file's size.
    #[pyo3(signature = (path, private = true))]
    fn write_file(&mut self, path: &str, private: bool) -> PyResult<usize> {
        use std::io::Write;
        let n = self.t.byte_len();
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        // owner-only for shared tables: the file holds the data and sits in a directory other users can list
        #[cfg(unix)]
        if private {
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        }
        #[cfg(not(unix))]
        let _ = private;
        let file = options.open(path)?;
        let mut out = std::io::BufWriter::with_capacity(1 << 20, file);
        // written through a small window, so the parent never holds a second copy of the table
        self.t
            .write_to(&mut |b: &[u8]| out.write_all(b))
            .map_err(|e| PyValueError::new_err(e.to_string()))?;
        out.flush()?;
        Ok(n)
    }
    /// Open a table from a file written by `write_file`, read-only. The file is mapped and the packed columns are read
    /// in place, so the table costs this process no memory of its own beyond bookkeeping, and every process that opens
    /// the same file shares the same pages.
    #[staticmethod]
    fn attach(py: Python<'_>, path: &str, size: usize) -> PyResult<PyTable> {
        let file = std::fs::File::open(path)?;
        // SAFETY: the mapping is read-only and lives as long as the table (the columns hold it through an `Arc`).
        // The file must not be truncated or rewritten in place while it is open; packmem itself only ever creates
        // these files whole (shared files are private to their owner, saved files are moved into place).
        let map = unsafe { memmap2::Mmap::map(&file)? };
        if map.len() != size {
            return Err(PyValueError::new_err(
                "packed table file has the wrong size; it was replaced or truncated",
            ));
        }
        let owner: std::sync::Arc<dyn packmem::buf::Backing> = std::sync::Arc::new(Mapped(map));
        let mut t = PyTable {
            t: DynTable::from_backing(owner).map_err(PyValueError::new_err)?,
            keys: vec![],
            template: None,
            seen_keys: vec![],
            frozen: true,
            only: None,
            conv: None,
        };
        t.sync_keys(py)?;
        Ok(t)
    }
    /// Keys to keep in the JSON loads that follow; `None` keeps every key again.
    #[pyo3(signature = (fields = None))]
    fn set_fields(&mut self, fields: Option<Vec<String>>) {
        self.only = fields.map(|f| f.into_iter().collect())
    }
    /// Hand memory that was freed back to the operating system, where the allocator supports being asked (glibc).
    /// Used after a table drops its own copy of the data in favour of a shared file: without it the freed copy stays
    /// counted against the process, and forked workers inherit it.
    #[staticmethod]
    fn release_freed_memory() {
        #[cfg(all(target_os = "linux", target_env = "gnu"))]
        {
            unsafe extern "C" {
                fn malloc_trim(pad: usize) -> i32;
            }
            // SAFETY: malloc_trim takes no pointers and only returns free heap pages to the system.
            unsafe {
                malloc_trim(0);
            }
        }
    }
    fn set_frozen(&mut self, on: bool) {
        self.frozen = on
    }
    #[getter]
    fn frozen(&self) -> bool {
        self.frozen
    }
    #[staticmethod]
    fn from_bytes(py: Python<'_>, data: &[u8]) -> PyResult<PyTable> {
        let mut t = PyTable {
            t: DynTable::from_bytes(data).map_err(PyValueError::new_err)?,
            keys: vec![],
            template: None,
            seen_keys: vec![],
            frozen: false,
            only: None,
            conv: None,
        };
        t.sync_keys(py)?;
        Ok(t)
    }
    #[getter]
    fn hint(&self) -> &'static str {
        match self.t.hint {
            Hint::Memory => "memory",
            Hint::Balanced => "balanced",
            Hint::Speed => "speed",
            Hint::Compact => "compact",
        }
    }
    /// Rebuild the table from the given row numbers, in that order.
    fn reorder(&mut self, order: Vec<u32>) -> PyResult<()> {
        self.guard()?;
        let n = self.t.len();
        if order.iter().any(|&r| r as usize >= n) {
            return Err(PyIndexError::new_err("row index out of range"));
        }
        self.t = self.t.take(&order);
        Ok(())
    }
    fn compact(&mut self) {
        self.t.compact()
    }
    fn nbytes(&self) -> usize {
        self.t.bytes()
    }
    fn describe(&self) -> Vec<(String, String, usize)> {
        self.t.describe()
    }
    fn tail_rows(&self) -> usize {
        self.t.tail_rows()
    }
}

/// A float as Python's `repr` writes it, which is what `json.dumps` emits.
fn py_float(out: &mut Vec<u8>, f: f64) {
    use std::io::Write;
    if f.is_nan() {
        return out.extend_from_slice(b"NaN");
    }
    if f.is_infinite() {
        return out.extend_from_slice(if f > 0.0 { b"Infinity" } else { b"-Infinity" });
    }
    let sci = format!("{f:e}");
    let (mant, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    if (-4..16).contains(&exp) {
        let start = out.len();
        write!(out, "{f}").unwrap();
        if !out[start..].contains(&b'.') {
            out.extend_from_slice(b".0")
        }
    } else {
        write!(
            out,
            "{mant}e{}{:02}",
            if exp < 0 { '-' } else { '+' },
            exp.abs()
        )
        .unwrap()
    }
}

/// Writes visited rows as comma-separated JSON objects straight from the columns, without building Python objects.
/// The text follows `json.dumps(rows, separators=(",", ":"), ensure_ascii=False)`; values always read back equal, and the
/// bytes are identical for flat records except for rare floats that have two equally short decimal forms.
struct JsonSink {
    out: Vec<u8>,
    keys: Vec<Vec<u8>>,
    rows: usize,
    first: bool,
    use_cache: bool,
    cache: Vec<(usize, Vec<Option<Box<[u8]>>>)>,
}
impl JsonSink {
    fn new(names: &[String], use_cache: bool) -> Self {
        let keys = names
            .iter()
            .map(|n| {
                let mut k = serde_json::to_vec(n).unwrap();
                k.push(b':');
                k
            })
            .collect();
        JsonSink {
            out: Vec::new(),
            keys,
            rows: 0,
            first: true,
            use_cache,
            cache: vec![],
        }
    }
    #[inline]
    fn key(&mut self, col: usize) {
        if !self.first {
            self.out.push(b',')
        }
        self.first = false;
        self.out.extend_from_slice(&self.keys[col])
    }
}
impl RowVisitor for JsonSink {
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
            .extend_from_slice(if v { b"true" } else { b"false" })
    }
    fn int(&mut self, col: usize, v: i64) {
        use std::io::Write;
        self.key(col);
        write!(self.out, "{v}").unwrap()
    }
    fn float(&mut self, col: usize, v: f64) {
        self.key(col);
        py_float(&mut self.out, v)
    }
    fn str(&mut self, col: usize, s: &str) {
        self.key(col);
        serde_json::to_writer(&mut self.out, s).unwrap()
    }
    fn dict_str(
        &mut self,
        col: usize,
        seg: usize,
        code: u32,
        dict_len: usize,
        value: &mut dyn FnMut() -> String,
    ) {
        self.key(col);
        if !self.use_cache {
            return serde_json::to_writer(&mut self.out, &value()).unwrap();
        }
        if self.cache.is_empty() {
            self.cache = (0..self.keys.len()).map(|_| (usize::MAX, vec![])).collect()
        }
        let slot = &mut self.cache[col];
        if slot.0 != seg {
            *slot = (seg, (0..dict_len).map(|_| None).collect())
        }
        let text = slot.1[code as usize]
            .get_or_insert_with(|| serde_json::to_vec(&value()).unwrap().into_boxed_slice());
        self.out.extend_from_slice(text)
    }
    fn other(&mut self, col: usize, c: &Cell) {
        self.key(col);
        match c {
            Cell::Json(s) => self.out.extend_from_slice(s.as_bytes()),
            other => self.out.extend_from_slice(to_text(other).as_bytes()),
        }
    }
}

/// A memory-mapped file that packed columns borrow from.
struct Mapped(memmap2::Mmap);
impl packmem::buf::Backing for Mapped {
    fn bytes(&self) -> &[u8] {
        &self.0
    }
}

/// One record read on demand: a field is decoded only when it is asked for. Behaves like a mapping; assignments write to the table.
/// It refers to a row number, so it shows the table's current contents.
#[pyclass(module = "packmem", frozen)]
struct Row {
    t: Py<PyTable>,
    i: usize,
}
impl Row {
    fn col(t: &PyTable, name: &Bound<'_, PyAny>) -> PyResult<Option<usize>> {
        // keys are interned, and so are string literals in Python source, so identity usually settles it
        if let Some(c) = t.keys.iter().position(|k| k.as_ptr() == name.as_ptr()) {
            return Ok(Some(c));
        }
        match name.downcast::<PyString>() {
            Ok(n) => Ok(t.t.col_index(&n.to_cow()?)),
            Err(_) => Ok(None),
        }
    }
    fn value(&self, py: Python<'_>, name: &Bound<'_, PyAny>) -> PyResult<Option<PyObject>> {
        let t = self.t.borrow(py);
        if self.i >= t.t.len() {
            return Err(PyIndexError::new_err("row no longer exists"));
        }
        match Row::col(&t, name)? {
            Some(c) => match t.t.get(self.i, c) {
                Cell::Missing => Ok(None),
                cell => from_cell(py, cell).map(Some),
            },
            None => Ok(None),
        }
    }
}
#[pymethods]
impl Row {
    fn __getitem__(&self, py: Python<'_>, name: &Bound<'_, PyAny>) -> PyResult<PyObject> {
        self.value(py, name)?
            .ok_or_else(|| PyKeyError::new_err(name.clone().unbind()))
    }
    #[pyo3(signature = (name, default = None))]
    fn get(
        &self,
        py: Python<'_>,
        name: &Bound<'_, PyAny>,
        default: Option<PyObject>,
    ) -> PyResult<PyObject> {
        Ok(self
            .value(py, name)?
            .or(default)
            .unwrap_or_else(|| py.None()))
    }
    fn __contains__(&self, py: Python<'_>, name: &Bound<'_, PyAny>) -> PyResult<bool> {
        Ok(self.value(py, name)?.is_some())
    }
    fn to_dict<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        self.t.borrow(py).row(py, self.i)
    }
    fn keys<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        self.to_dict(py)?.call_method0("keys")
    }
    fn values<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        self.to_dict(py)?.call_method0("values")
    }
    fn items<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        self.to_dict(py)?.call_method0("items")
    }
    fn __iter__<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        self.to_dict(py)?.call_method0("__iter__")
    }
    fn __len__(&self, py: Python<'_>) -> PyResult<usize> {
        self.to_dict(py)?.len()
    }
    fn __eq__(&self, py: Python<'_>, other: &Bound<'_, PyAny>) -> PyResult<bool> {
        match other.downcast::<Row>() {
            Ok(r) => self.to_dict(py)?.eq(r.get().to_dict(py)?),
            Err(_) => self.to_dict(py)?.eq(other),
        }
    }
    fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
        Ok(self.to_dict(py)?.repr()?.to_string())
    }
    /// Assigning a field writes through to the table.
    fn __setitem__(&self, py: Python<'_>, name: &str, v: &Bound<'_, PyAny>) -> PyResult<()> {
        let mut t = self.t.borrow_mut(py);
        if self.i >= t.t.len() {
            return Err(PyIndexError::new_err("row no longer exists"));
        }
        t.set_cell(py, self.i, name, v)
    }
    #[getter]
    fn index(&self) -> usize {
        self.i
    }
}

#[pymodule]
fn _packmem(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyTable>()?;
    m.add_class::<Selection>()?;
    m.add_class::<Row>()?;
    let _ = to_text;
    Ok(())
}
