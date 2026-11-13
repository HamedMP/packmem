//! Python bindings for packmem: a list-of-dicts replacement backed by packed, mutable columns.
use packmem::csv::{ColType, CsvLoader, CsvOptions};
use packmem::dynamic::{from_text, to_text, RowVisitor};
use packmem::{Cell, DynTable, Hint, Num, Pred};
use pyo3::exceptions::{PyIndexError, PyKeyError, PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyBytes, PyDict, PyFloat, PyInt, PyList, PyString, PyTuple};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;
use serde_json::Value;
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
        Some(b'[' | b'{') => Cell::Json(
            serde_json::from_str::<Value>(t)
                .map_err(|e| e.to_string())?
                .to_string(),
        ),
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

struct KeySeed<'a>(&'a mut DynTable);
impl<'de, 'a> DeserializeSeed<'de> for KeySeed<'a> {
    type Value = usize;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<usize, D::Error> {
        d.deserialize_str(self)
    }
}
impl<'de, 'a> Visitor<'de> for KeySeed<'a> {
    type Value = usize;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a key")
    }
    fn visit_str<E: serde::de::Error>(self, k: &str) -> Result<usize, E> {
        Ok(self.0.col_for(k))
    }
}

/// Fills the cells of one record. The caller finishes with `end_row`, or `abort_row` on error.
struct RowSeed<'a, R>(&'a mut DynTable, PhantomData<R>);
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

fn push_line(t: &mut DynTable, line: &str) -> Result<(), String> {
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

struct ArraySink<'a>(&'a mut DynTable);
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

fn hint_of(h: &str) -> PyResult<Hint> {
    match h {
        "memory" => Ok(Hint::Memory),
        "balanced" => Ok(Hint::Balanced),
        "speed" => Ok(Hint::Speed),
        _ => Err(PyValueError::new_err(
            "hint must be 'memory', 'balanced' or 'speed'",
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
        }
    }
    #[inline]
    fn put(&mut self, col: usize, v: PyResult<Bound<'py, PyAny>>) {
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
        self.seen += 1;
        self.mark[col] = self.stamp
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
                    self.t.put_at(c, to_cell(&v)?)
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
        let Err(e) = push_line(&mut self.t, line) else {
            return Ok(());
        };
        let err = || PyValueError::new_err(format!("line {lineno}: {e}"));
        let v = py
            .import("json")?
            .getattr("loads")?
            .call1((line,))
            .map_err(|_| err())?;
        self.push(v.downcast::<PyDict>().map_err(|_| err())?)
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
    /// Run a bulk load: rows are packed a chunk at a time, and whatever was loaded before an error stays consistent.
    fn bulk<T>(&mut self, py: Python<'_>, f: impl FnOnce(&mut Self) -> PyResult<T>) -> PyResult<T> {
        self.t.set_bulk(true);
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
        })
    }
    fn __len__(&self) -> usize {
        self.t.len()
    }
    fn append(&mut self, py: Python<'_>, row: &Bound<'_, PyAny>) -> PyResult<()> {
        let r = self.push_any(py, row);
        self.sync_keys(py)?;
        r
    }
    fn extend(&mut self, py: Python<'_>, rows: &Bound<'_, PyAny>) -> PyResult<usize> {
        self.bulk(py, |s| {
            let mut n = 0;
            for r in rows.try_iter()? {
                s.push_any(py, &r?)?;
                n += 1
            }
            Ok(n)
        })
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
        let f = std::fs::File::open(path)?;
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
        let r = self.push_text(py, line, 1);
        self.sync_keys(py)?;
        r
    }
    /// Parse many JSON lines from any iterable of str or bytes.
    fn extend_json(&mut self, py: Python<'_>, lines: &Bound<'_, PyAny>) -> PyResult<usize> {
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
        let f = std::fs::File::open(path)?;
        self.bulk(py, |s| {
            let mut de =
                serde_json::Deserializer::from_reader(BufReader::with_capacity(1 << 20, f));
            let n = ArraySink(&mut s.t)
                .deserialize(&mut de)
                .map_err(|e| PyValueError::new_err(e.to_string()))?;
            de.end().map_err(|e| PyValueError::new_err(e.to_string()))?;
            Ok(n)
        })
    }
    /// Same, reading from any Python file object.
    fn load_json_array_file(&mut self, py: Python<'_>, f: &Bound<'_, PyAny>) -> PyResult<usize> {
        self.bulk(py, |s| {
            let mut de = serde_json::Deserializer::from_reader(PyReader {
                f: f.clone(),
                buf: vec![],
                pos: 0,
            });
            let n = ArraySink(&mut s.t)
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
        self.check(i)?;
        self.t.set_by_name(i, name, to_cell(v)?);
        self.sync_keys(py)
    }
    /// Replace a whole record: keys not present in `row` become absent.
    fn set_row(&mut self, py: Python<'_>, i: usize, row: &Bound<'_, PyDict>) -> PyResult<()> {
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
        };
        t.sync_keys(py)?;
        Ok(t)
    }
    /// Append every row of another table natively.
    fn extend_table(&mut self, py: Python<'_>, other: &Bound<'_, PyTable>) -> PyResult<()> {
        let o = other
            .try_borrow()
            .map_err(|_| PyValueError::new_err("cannot extend a table with itself"))?;
        self.t.extend_from(&o.t);
        drop(o);
        self.sync_keys(py)
    }
    /// The packed columns as bytes, without re-encoding. Packs any rows still held uncompressed first.
    fn to_bytes<'py>(&mut self, py: Python<'py>) -> Bound<'py, PyBytes> {
        PyBytes::new(py, &self.t.to_bytes())
    }
    #[staticmethod]
    fn from_bytes(py: Python<'_>, data: &[u8]) -> PyResult<PyTable> {
        let mut t = PyTable {
            t: DynTable::from_bytes(data).map_err(PyValueError::new_err)?,
            keys: vec![],
            template: None,
            seen_keys: vec![],
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
        }
    }
    /// Rebuild the table from the given row numbers, in that order.
    fn reorder(&mut self, order: Vec<u32>) -> PyResult<()> {
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
