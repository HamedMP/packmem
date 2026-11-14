//! Mutable, schema-flexible table: append and update on top of packed chunks.
//!
//! Rows land in an uncompressed tail; every `CHUNK` rows the tail is sealed into packed
//! columns. Updates to sealed rows go to a small per-chunk patch map; a chunk with many
//! patches is re-encoded. Each chunk picks its own type and encoding, so a column may
//! change type over time without rewriting old data.
use crate::buf::Buf;
use crate::{Hint, PackedInts, PackedStrs};
use std::collections::{BTreeMap, HashMap};

pub const CHUNK: usize = 16_384;
const MAX_PATCHES: usize = CHUNK / 16;

/// One value. `Missing` = the record had no such key; `Json` = raw JSON text (nested values, big integers).
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    Missing,
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Json(String),
}

pub fn to_text(c: &Cell) -> String {
    match c {
        Cell::Missing => String::new(),
        Cell::Null => "null".into(),
        Cell::Bool(b) => b.to_string(),
        Cell::Int(i) => i.to_string(),
        Cell::Float(f) => {
            if f.is_nan() {
                "NaN".into()
            } else if f.is_infinite() {
                if *f > 0.0 {
                    "Infinity".into()
                } else {
                    "-Infinity".into()
                }
            } else {
                serde_json::to_string(f).unwrap()
            }
        }
        Cell::Str(s) => serde_json::to_string(s).unwrap(),
        Cell::Json(s) => s.clone(),
    }
}

pub fn from_text(t: &[u8]) -> Cell {
    if t.is_empty() {
        return Cell::Missing;
    }
    let s = std::str::from_utf8(t).unwrap_or("");
    match t[0] {
        // text that is not a valid Rust string (a lone UTF-16 surrogate escape) stays as raw JSON text
        b'"' => match serde_json::from_str(s) {
            Ok(x) => Cell::Str(x),
            Err(_) => Cell::Json(s.to_string()),
        },
        b'n' => Cell::Null,
        b't' => Cell::Bool(true),
        b'f' => Cell::Bool(false),
        b'[' | b'{' => Cell::Json(s.to_string()),
        _ => {
            if let Ok(i) = s.parse::<i64>() {
                return Cell::Int(i);
            }
            match s {
                "NaN" => return Cell::Float(f64::NAN),
                "Infinity" => return Cell::Float(f64::INFINITY),
                "-Infinity" => return Cell::Float(f64::NEG_INFINITY),
                _ => {}
            }
            if s.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
                return Cell::Json(s.to_string());
            } // integer beyond 64 bits
            match s.parse::<f64>() {
                Ok(f) => Cell::Float(f),
                Err(_) => Cell::Json(s.to_string()),
            }
        }
    }
}

/// 1 for the ASCII bytes Python's `str.split()` treats as whitespace: space, tab to carriage return, 0x1c to 0x1f.
const ASCII_SPACE: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        t[i] = (i == 0x20 || (i >= 0x09 && i <= 0x0d) || (i >= 0x1c && i <= 0x1f)) as u8;
        i += 1
    }
    t
};

/// What to measure of a string: see `DynTable::list_str_sum`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StrMeasure {
    /// Whitespace-separated words, with Python's definition of whitespace (`len(s.split())`).
    Words,
    /// Unicode characters (`len(s)` in Python).
    Chars,
    /// UTF-8 bytes.
    Bytes,
}
impl StrMeasure {
    fn of(self, s: &str) -> i64 {
        // Python's str.isspace is Unicode White_Space plus the four ASCII separators 0x1c..0x1f
        let space = |c: char| c.is_whitespace() || ('\x1c'..='\x1f').contains(&c);
        match self {
            StrMeasure::Bytes => s.len() as i64,
            StrMeasure::Chars => s.chars().count() as i64,
            StrMeasure::Words if s.is_ascii() => {
                // the common case, counted on bytes: a word starts wherever a non-space follows a space
                let mut prev = 1u8;
                let mut n = 0i64;
                for &b in s.as_bytes() {
                    let sp = ASCII_SPACE[b as usize];
                    n += (prev & !sp & 1) as i64;
                    prev = sp
                }
                n
            }
            StrMeasure::Words => s.split(space).filter(|w| !w.is_empty()).count() as i64,
        }
    }
}
fn json_list_len(c: &Cell) -> Option<u32> {
    match c {
        Cell::Json(t) if t.starts_with('[') => {
            serde_json::from_str::<Vec<serde::de::IgnoredAny>>(t)
                .ok()
                .map(|v| v.len() as u32)
        }
        _ => None,
    }
}
fn json_list_str_sum(c: &Cell, field: &str, measure: StrMeasure) -> Option<i64> {
    let Cell::Json(t) = c else { return None };
    let serde_json::Value::Array(items) = serde_json::from_str(t).ok()? else {
        return None;
    };
    let mut sum = 0;
    for item in &items {
        match item {
            serde_json::Value::Object(m) => {
                if let Some(serde_json::Value::String(s)) = m.get(field) {
                    sum += measure.of(s)
                }
            }
            _ => return None,
        }
    }
    Some(sum)
}

#[derive(Clone, Debug)]
pub enum Pred {
    Eq(Cell),
    Range {
        lo: f64,
        hi: f64,
        lo_incl: bool,
        hi_incl: bool,
    },
    Prefix(String),
    Contains(String),
}

fn has(h: &[u8], n: &[u8]) -> bool {
    n.is_empty() || h.windows(n.len()).any(|w| w == n)
}
pub fn matches(c: &Cell, p: &Pred) -> bool {
    match (p, c) {
        (Pred::Eq(Cell::Int(a)), Cell::Int(b)) => a == b,
        (Pred::Eq(Cell::Float(a)), Cell::Float(b)) => a == b,
        (Pred::Eq(Cell::Int(a)), Cell::Float(b)) | (Pred::Eq(Cell::Float(b)), Cell::Int(a)) => {
            *a as f64 == *b && (*b as i64) == *a
        }
        (Pred::Eq(Cell::Str(a)), Cell::Str(b)) => a == b,
        (Pred::Eq(Cell::Bool(a)), Cell::Bool(b)) => a == b,
        (Pred::Eq(Cell::Null), Cell::Null) => true,
        (
            Pred::Range {
                lo,
                hi,
                lo_incl,
                hi_incl,
            },
            Cell::Int(_) | Cell::Float(_),
        ) => {
            let v = match c {
                Cell::Int(i) => *i as f64,
                Cell::Float(f) => *f,
                _ => unreachable!(),
            };
            (v > *lo || (*lo_incl && v == *lo)) && (v < *hi || (*hi_incl && v == *hi))
        }
        (Pred::Prefix(a), Cell::Str(b)) => b.starts_with(a.as_str()),
        (Pred::Contains(a), Cell::Str(b)) => b.contains(a.as_str()),
        _ => false,
    }
}

/// Stored-integer range [l, h] whose decoded values `code / 10^scale` satisfy a float range. Decoding is monotonic in the
/// code, so the matching codes are contiguous. `None` when a bound is outside the exactly representable zone.
fn dec_bounds(lo: f64, hi: f64, lo_incl: bool, hi_incl: bool, scale: usize) -> Option<(i64, i64)> {
    if lo.is_nan() || hi.is_nan() {
        return Some((1, 0));
    }
    let p = POW10[scale];
    let val = |c: i64| c as f64 / p;
    let l = if lo == f64::NEG_INFINITY {
        i64::MIN
    } else {
        let g = (lo * p).floor();
        if !(g.abs() < 9.0e15) {
            return None;
        }
        let mut c = g as i64 - 2;
        while {
            let v = val(c);
            !(v > lo || (lo_incl && v == lo))
        } {
            c += 1
        }
        c
    };
    let h = if hi == f64::INFINITY {
        i64::MAX
    } else {
        let g = (hi * p).ceil();
        if !(g.abs() < 9.0e15) {
            return None;
        }
        let mut c = g as i64 + 2;
        while {
            let v = val(c);
            !(v < hi || (hi_incl && v == hi))
        } {
            c -= 1
        }
        c
    };
    Some((l, h))
}

/// Receives the cells of rows one at a time, without building intermediate `Cell`s for packed data.
/// Absent keys are simply not reported.
pub trait RowVisitor {
    fn begin(&mut self);
    fn end(&mut self);
    fn null(&mut self, col: usize);
    fn boolean(&mut self, col: usize, v: bool);
    fn int(&mut self, col: usize, v: i64);
    fn float(&mut self, col: usize, v: f64);
    fn str(&mut self, col: usize, s: &str);
    /// A dictionary-coded string. `(col, seg, code)` identifies the value for the duration of one visit, so it can be cached; `value` decodes it.
    fn dict_str(
        &mut self,
        col: usize,
        seg: usize,
        code: u32,
        dict_len: usize,
        value: &mut dyn FnMut() -> String,
    );
    /// Nested values and integers beyond 64 bits.
    fn other(&mut self, col: usize, c: &Cell);
    /// A nested value stored as sub-columns: a list of `len` records, or one record when `is_record`. Return `true`
    /// to receive it piece by piece: `nested_elem_begin`, then for each field `nested_key` followed by exactly one
    /// value call (`null`, `int`, `str`, ..., whose `col` is then the field's index), `nested_elem_end`, and finally
    /// `nested_end`. The default declines, and the value arrives as JSON text through `other`.
    fn nested_begin(&mut self, _col: usize, _is_record: bool, _len: usize) -> bool {
        false
    }
    fn nested_elem_begin(&mut self) {}
    fn nested_key(&mut self, _field: usize, _name: &str) {}
    fn nested_elem_end(&mut self) {}
    fn nested_end(&mut self, _col: usize) {}
}
fn emit_cell<V: RowVisitor>(v: &mut V, ci: usize, c: &Cell) {
    match c {
        Cell::Missing => {}
        Cell::Null => v.null(ci),
        Cell::Bool(b) => v.boolean(ci, *b),
        Cell::Int(i) => v.int(ci, *i),
        Cell::Float(f) => v.float(ci, *f),
        Cell::Str(s) => v.str(ci, s),
        Cell::Json(_) => v.other(ci, c),
    }
}

/// Rows not yet packed, for one column: a tag byte and an 8-byte payload per cell, with all string bytes in one buffer.
/// This is about a third of a `Vec<Cell>` and needs no allocation per string.
#[derive(Default)]
struct Tail {
    tags: Vec<u8>,
    vals: Vec<u64>,
    text: String,
    ends: Vec<usize>,
}
const T_MISSING: u8 = 0;
const T_NULL: u8 = 1;
const T_BOOL: u8 = 2;
const T_INT: u8 = 3;
const T_FLOAT: u8 = 4;
const T_STR: u8 = 5;
const T_JSON: u8 = 6;
impl Tail {
    fn missing(n: usize) -> Tail {
        Tail {
            tags: vec![T_MISSING; n],
            vals: vec![0; n],
            ..Default::default()
        }
    }
    fn len(&self) -> usize {
        self.tags.len()
    }
    fn intern(&mut self, s: &str) -> u64 {
        self.text.push_str(s);
        self.ends.push(self.text.len());
        self.ends.len() as u64 - 1
    }
    fn enc(&mut self, c: &Cell) -> (u8, u64) {
        match c {
            Cell::Missing => (T_MISSING, 0),
            Cell::Null => (T_NULL, 0),
            Cell::Bool(b) => (T_BOOL, *b as u64),
            Cell::Int(i) => (T_INT, *i as u64),
            Cell::Float(f) => (T_FLOAT, f.to_bits()),
            Cell::Str(s) => (T_STR, self.intern(s)),
            Cell::Json(s) => (T_JSON, self.intern(s)),
        }
    }
    fn push(&mut self, c: &Cell) {
        let (t, v) = self.enc(c);
        self.tags.push(t);
        self.vals.push(v)
    }
    fn set(&mut self, i: usize, c: &Cell) {
        let (t, v) = self.enc(c);
        self.tags[i] = t;
        self.vals[i] = v
    }
    fn clear(&mut self) {
        self.tags.clear();
        self.vals.clear();
        self.text.clear();
        self.ends.clear()
    }
    fn truncate(&mut self, n: usize) {
        self.tags.truncate(n);
        self.vals.truncate(n)
    }
    #[inline]
    fn s(&self, i: usize) -> &str {
        let k = self.vals[i] as usize;
        &self.text[if k == 0 { 0 } else { self.ends[k - 1] }..self.ends[k]]
    }
    fn get(&self, i: usize) -> Cell {
        let v = self.vals[i];
        match self.tags[i] {
            T_MISSING => Cell::Missing,
            T_NULL => Cell::Null,
            T_BOOL => Cell::Bool(v != 0),
            T_INT => Cell::Int(v as i64),
            T_FLOAT => Cell::Float(f64::from_bits(v)),
            T_STR => Cell::Str(self.s(i).to_string()),
            _ => Cell::Json(self.s(i).to_string()),
        }
    }
    #[inline]
    fn emit<V: RowVisitor>(&self, i: usize, ci: usize, v: &mut V) {
        let x = self.vals[i];
        match self.tags[i] {
            T_MISSING => {}
            T_NULL => v.null(ci),
            T_BOOL => v.boolean(ci, x != 0),
            T_INT => v.int(ci, x as i64),
            T_FLOAT => v.float(ci, f64::from_bits(x)),
            T_STR => v.str(ci, self.s(i)),
            _ => v.other(ci, &self.get(i)),
        }
    }
    fn cells(&self) -> impl Iterator<Item = Cell> + '_ {
        (0..self.len()).map(|i| self.get(i))
    }
    fn bytes(&self) -> usize {
        self.tags.len() * 9 + self.text.len() + self.ends.len() * 8
    }
}

/// A small multiplicative hasher for byte-string keys (the FxHash scheme); the default SipHash dominates group-by otherwise.
#[derive(Default)]
struct Fx(u64);
impl std::hash::Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for c in bytes.chunks(8) {
            let mut w = [0u8; 8];
            w[..c.len()].copy_from_slice(c);
            self.0 =
                (self.0.rotate_left(5) ^ u64::from_le_bytes(w)).wrapping_mul(0x517c_c1b7_2722_0a95)
        }
    }
}

type Bits = Buf<u64>;
fn bit(b: &Option<Bits>, i: usize) -> bool {
    match b {
        Some(v) => v[i >> 6] >> (i & 63) & 1 == 1,
        None => false,
    }
}
enum Data {
    Absent,
    Int {
        p: PackedInts,
        is_bool: bool,
    },
    Dec {
        scale: u8,
        p: PackedInts,
    },
    F64(Buf<f64>),
    Str(PackedStrs),
    Mixed(PackedStrs),
    /// A list of records per row (or one record per row), stored as sub-columns.
    List(Box<ListCol>),
}

/// Sub-column storage for a column whose values are lists of records, e.g. the turns of a conversation.
/// Row `i` owns elements `offs[i]..offs[i + 1]`; each field of the records is a packed column over all elements.
/// The layout is the one Arrow uses for a list of structs. Which keys an element has, and in what order, is its
/// shape; shapes are stored once and referenced per element, so records read back exactly as they were written.
struct ListCol {
    /// Every row holds a single record rather than a list of them.
    is_record: bool,
    offs: Buf<u32>,
    names: Vec<String>,
    /// Each field name as a JSON string followed by a colon, ready to write.
    keys_json: Vec<String>,
    shapes: Vec<Vec<u16>>,
    shape_of: PackedInts,
    cols: Vec<Chunk>,
}

thread_local! {
    /// Emptied buffers from the last chunk that was split into sub-columns, reused by the next one. Regrowing them
    /// for every chunk leaves a trail of freed blocks that some allocators keep counted against the process.
    static SPARE_TAILS: std::cell::RefCell<Vec<Tail>> = const { std::cell::RefCell::new(Vec::new()) };
}
/// Drop the buffers kept between chunks; called when a bulk load ends.
fn release_spare_tails() {
    SPARE_TAILS.with(|s| *s.borrow_mut() = Vec::new())
}

/// Collects the elements of a chunk's nested values into one tail per field.
#[derive(Default)]
struct Shredder {
    names: Vec<String>,
    index: HashMap<String, u16>,
    tails: Vec<Tail>,
    shapes: Vec<Vec<u16>>,
    shape_ix: HashMap<Vec<u16>, i64>,
    shape_of: Vec<i64>,
    shape: Vec<u16>,
    elems: usize,
}
impl Shredder {
    fn field(&mut self, name: &str) -> Option<u16> {
        if let Some(&c) = self.index.get(name) {
            return Some(c);
        }
        let c = u16::try_from(self.names.len()).ok()?;
        self.names.push(name.to_string());
        self.index.insert(name.to_string(), c);
        let mut tail = SPARE_TAILS
            .with(|s| s.borrow_mut().pop())
            .unwrap_or_default();
        tail.tags.resize(self.elems, T_MISSING);
        tail.vals.resize(self.elems, 0);
        self.tails.push(tail);
        Some(c)
    }
    fn put(&mut self, c: u16, text: &str) {
        let t = &mut self.tails[c as usize];
        let fresh = t.len() == self.elems;
        if fresh {
            self.shape.push(c)
        }
        let b = text.as_bytes();
        if fresh && b.first() == Some(&b'"') && !b.contains(&b'\\') {
            // a plain string goes straight into the field's text buffer, with no allocation of its own
            let v = t.intern(&text[1..text.len() - 1]);
            t.tags.push(T_STR);
            t.vals.push(v);
            return;
        }
        let cell = from_text(b);
        if fresh {
            t.push(&cell)
        } else {
            t.set(self.elems, &cell) // a repeated key: the last value wins, as in json.loads
        }
    }
    fn end_elem(&mut self) {
        for t in &mut self.tails {
            if t.len() == self.elems {
                t.push(&Cell::Missing)
            }
        }
        let next = self.shapes.len() as i64;
        let id = match self.shape_ix.get(&self.shape) {
            Some(&id) => id,
            None => {
                self.shapes.push(self.shape.clone());
                self.shape_ix.insert(self.shape.clone(), next);
                next
            }
        };
        self.shape_of.push(id);
        self.shape.clear();
        self.elems += 1
    }
}
struct FieldSeed<'a>(&'a mut Shredder);
impl<'de> serde::de::DeserializeSeed<'de> for FieldSeed<'_> {
    type Value = u16;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<u16, D::Error> {
        d.deserialize_str(self)
    }
}
impl<'de> serde::de::Visitor<'de> for FieldSeed<'_> {
    type Value = u16;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a key")
    }
    fn visit_str<E: serde::de::Error>(self, k: &str) -> Result<u16, E> {
        self.0
            .field(k)
            .ok_or_else(|| E::custom("too many distinct keys"))
    }
}
struct ElemSeed<'a>(&'a mut Shredder);
impl<'de> serde::de::DeserializeSeed<'de> for ElemSeed<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de> serde::de::Visitor<'de> for ElemSeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a record")
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<(), A::Error> {
        while let Some(c) = m.next_key_seed(FieldSeed(&mut *self.0))? {
            let v: &serde_json::value::RawValue = m.next_value()?;
            self.0.put(c, v.get())
        }
        self.0.end_elem();
        Ok(())
    }
}
struct ListSeed<'a>(&'a mut Shredder);
impl<'de> serde::de::DeserializeSeed<'de> for ListSeed<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> serde::de::Visitor<'de> for ListSeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a list of records")
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while seq.next_element_seed(ElemSeed(&mut *self.0))?.is_some() {}
        Ok(())
    }
}

impl ListCol {
    /// Try to store a chunk whose values are all JSON text as sub-columns. `None` when the values are not uniformly
    /// lists of records (or uniformly records), in which case the chunk keeps them as text.
    fn shred(t: &Tail, hint: Hint, depth: usize) -> Option<ListCol> {
        use serde::de::DeserializeSeed;
        let n = t.len();
        let first = (0..n).find(|&k| t.tags[k] == T_JSON)?;
        let is_record = match t.s(first).as_bytes().first()? {
            b'{' => true,
            b'[' => false,
            _ => return None, // an integer beyond 64 bits
        };
        let mut sh = Shredder::default();
        let mut offs = Vec::with_capacity(n + 1);
        offs.push(0u32);
        for k in 0..n {
            if t.tags[k] == T_JSON {
                let text = t.s(k);
                if (text.as_bytes().first() == Some(&b'{')) != is_record {
                    return None;
                }
                let mut de = serde_json::Deserializer::from_str(text);
                let ok = if is_record {
                    ElemSeed(&mut sh).deserialize(&mut de).is_ok()
                } else {
                    ListSeed(&mut sh).deserialize(&mut de).is_ok()
                };
                if !ok || de.end().is_err() {
                    return None;
                }
            }
            offs.push(u32::try_from(sh.elems).ok()?);
        }
        if sh.elems == 0 {
            return None; // only empty lists: nothing to gain
        }
        let cols = sh
            .tails
            .iter()
            .map(|tail| Chunk::seal_at(tail, hint, depth + 1))
            .collect();
        SPARE_TAILS.with(|s| {
            let mut spare = s.borrow_mut();
            for mut tail in sh.tails.drain(..) {
                if spare.len() < 64 {
                    tail.clear();
                    spare.push(tail)
                }
            }
        });
        let keys_json = sh
            .names
            .iter()
            .map(|k| format!("{}:", serde_json::to_string(k).unwrap()))
            .collect();
        Some(ListCol {
            is_record,
            offs: offs.into(),
            names: sh.names,
            keys_json,
            shapes: sh.shapes,
            shape_of: PackedInts::encode(&sh.shape_of, hint),
            cols,
        })
    }
    #[inline]
    fn range(&self, i: usize) -> (usize, usize) {
        (self.offs[i] as usize, self.offs[i + 1] as usize)
    }
    /// Row `i` as compact JSON text.
    fn text(&self, i: usize) -> String {
        let (a, b) = self.range(i);
        let mut out = String::new();
        if !self.is_record {
            out.push('[')
        }
        for e in a..b {
            if e > a {
                out.push(',')
            }
            out.push('{');
            for (k, &c) in self.shapes[self.shape_of.get(e) as usize]
                .iter()
                .enumerate()
            {
                if k > 0 {
                    out.push(',')
                }
                out.push_str(&self.keys_json[c as usize]);
                out.push_str(&to_text(&self.cols[c as usize].get(e)))
            }
            out.push('}')
        }
        if !self.is_record {
            out.push(']')
        }
        out
    }
    fn emit<V: RowVisitor>(&self, i: usize, ci: usize, seg: usize, v: &mut V, buf: &mut Vec<u8>) {
        let (a, b) = self.range(i);
        if !v.nested_begin(ci, self.is_record, b - a) {
            return v.other(ci, &Cell::Json(self.text(i)));
        }
        for e in a..b {
            v.nested_elem_begin();
            for &c in &self.shapes[self.shape_of.get(e) as usize] {
                v.nested_key(c as usize, &self.names[c as usize]);
                self.cols[c as usize].emit(e, c as usize, seg, v, buf)
            }
            v.nested_elem_end()
        }
        v.nested_end(ci)
    }
    fn write(&self, w: &mut W) {
        w.bool(self.is_record);
        w.v_u32(&self.offs);
        w.u64(self.shapes.len() as u64);
        for s in &self.shapes {
            w.v_u16(s)
        }
        self.shape_of.write(w);
        w.u64(self.names.len() as u64);
        for (name, col) in self.names.iter().zip(&self.cols) {
            w.bytes(name.as_bytes());
            col.write(w)
        }
    }
    fn read(r: &mut R) -> Res<ListCol> {
        let is_record = r.get_bool()?;
        let offs = r.get_v_u32()?;
        if offs.first() != Some(&0) || offs.windows(2).any(|p| p[0] > p[1]) {
            return bad("list offsets");
        }
        let elems = *offs.last().unwrap() as usize;
        let mut shapes = Vec::new();
        for _ in 0..r.len(8)? {
            shapes.push(r.get_v_u16()?.to_vec())
        }
        let shape_of = PackedInts::read(r)?;
        let (mut names, mut cols) = (Vec::new(), Vec::new());
        for _ in 0..r.len(8)? {
            names.push(r.get_string()?);
            let col = Chunk::read_max(r, u32::MAX as usize)?;
            if col.len as usize != elems {
                return bad("sub-column length");
            }
            cols.push(col)
        }
        if shape_of.len() != elems
            || shapes.is_empty()
            || shapes.iter().flatten().any(|&c| c as usize >= names.len())
        {
            return bad("record shapes");
        }
        let keys_json = names
            .iter()
            .map(|k| format!("{}:", serde_json::to_string(k).unwrap()))
            .collect();
        Ok(ListCol {
            is_record,
            offs,
            names,
            keys_json,
            shapes,
            shape_of,
            cols,
        })
    }
    fn bytes(&self) -> usize {
        self.offs.len() * 4
            + self.shape_of.bytes()
            + self.shapes.iter().map(|s| s.len() * 2 + 24).sum::<usize>()
            + self.names.iter().map(|n| n.len() * 2 + 48).sum::<usize>()
            + self.cols.iter().map(|c| c.bytes()).sum::<usize>()
    }
    fn describe(&self) -> String {
        let fields: Vec<String> = self
            .names
            .iter()
            .zip(&self.cols)
            .map(|(n, c)| format!("{n}: {}", c.describe()))
            .collect();
        format!(
            "{}<{}>",
            if self.is_record { "record" } else { "list" },
            fields.join(", ")
        )
    }
}
const POW10: [f64; 7] = [1.0, 10.0, 100.0, 1e3, 1e4, 1e5, 1e6];

/// `safe_sum`: every stored integer is below 2^46 in magnitude, so a 64-bit sum of the chunk cannot overflow.
struct Chunk {
    data: Data,
    nulls: Option<Bits>,
    missing: Option<Bits>,
    fill: i64,
    holes: u32,
    len: u32,
    safe_sum: bool,
    patches: BTreeMap<u32, Cell>,
}

impl Chunk {
    fn absent(len: usize) -> Chunk {
        Chunk {
            data: Data::Absent,
            nulls: None,
            missing: None,
            fill: 0,
            holes: len as u32,
            len: len as u32,
            safe_sum: true,
            patches: BTreeMap::new(),
        }
    }
    fn seal_cells(cells: &[Cell], hint: Hint) -> Chunk {
        let mut t = Tail::default();
        for c in cells {
            t.push(c)
        }
        Chunk::seal(&t, hint)
    }
    fn seal(t: &Tail, hint: Hint) -> Chunk {
        Chunk::seal_at(t, hint, 0)
    }
    /// `depth` counts how many nested lists this column is inside; sub-columns are not split further beyond two levels.
    fn seal_at(t: &Tail, hint: Hint, depth: usize) -> Chunk {
        let n = t.len();
        let mut cnt = [0usize; 7];
        for &g in &t.tags {
            cnt[g as usize] += 1
        }
        let (miss, holes) = (
            cnt[T_MISSING as usize],
            (cnt[T_MISSING as usize] + cnt[T_NULL as usize]) as u32,
        );
        let vals = n - holes as usize;
        let bits = |tag: u8| -> Option<Bits> {
            if cnt[tag as usize] == 0 {
                return None;
            }
            let mut v = vec![0u64; (n + 63) / 64];
            for (k, &g) in t.tags.iter().enumerate() {
                if g == tag {
                    v[k >> 6] |= 1 << (k & 63)
                }
            }
            Some(v.into())
        };
        let mk = |data, fill, safe_sum| Chunk {
            data,
            nulls: bits(T_NULL),
            missing: bits(T_MISSING),
            fill,
            holes,
            len: n as u32,
            safe_sum,
            patches: BTreeMap::new(),
        };
        let small = |v: &[i64]| v.iter().all(|x| x.unsigned_abs() < 1 << 46);
        if miss == n {
            return Chunk::absent(n);
        }
        if vals > 0 && (cnt[T_INT as usize] == vals || cnt[T_BOOL as usize] == vals) {
            let is = |g: u8| g == T_INT || g == T_BOOL;
            let fill = t.vals[t.tags.iter().position(|&g| is(g)).unwrap()] as i64;
            let v: Vec<i64> = t
                .tags
                .iter()
                .zip(&t.vals)
                .map(|(&g, &x)| if is(g) { x as i64 } else { fill })
                .collect();
            let ok = small(&v);
            return mk(
                Data::Int {
                    p: PackedInts::encode(&v, hint),
                    is_bool: cnt[T_BOOL as usize] == vals,
                },
                fill,
                ok,
            );
        }
        if vals > 0 && cnt[T_FLOAT as usize] == vals {
            let fv = |k: usize| {
                if t.tags[k] == T_FLOAT {
                    Some(f64::from_bits(t.vals[k]))
                } else {
                    None
                }
            };
            // decimal scaling: if every value is exactly k-decimal, store round(v * 10^k) as integers
            'scale: for k in 0..POW10.len() {
                let mut v = Vec::with_capacity(n);
                let mut fill = None;
                for c in 0..n {
                    match fv(c) {
                        Some(x) => {
                            let sc = (x * POW10[k]).round();
                            if !(sc.abs() < 9.0e15)
                                || (sc / POW10[k]).to_bits() != x.to_bits()
                                || (x == 0.0 && x.is_sign_negative())
                            {
                                continue 'scale;
                            }
                            fill.get_or_insert(sc as i64);
                            v.push(Some(sc as i64))
                        }
                        None => v.push(None),
                    }
                }
                let fill = fill.unwrap();
                let v: Vec<i64> = v.into_iter().map(|x| x.unwrap_or(fill)).collect();
                let ok = small(&v);
                return mk(
                    Data::Dec {
                        scale: k as u8,
                        p: PackedInts::encode(&v, hint),
                    },
                    fill,
                    ok,
                );
            }
            return mk(
                Data::F64((0..n).map(|k| fv(k).unwrap_or(0.0)).collect()),
                0,
                true,
            );
        }
        if vals > 0 && cnt[T_STR as usize] == vals {
            let v: Vec<&str> = (0..n)
                .map(|k| if t.tags[k] == T_STR { t.s(k) } else { "" })
                .collect();
            return mk(Data::Str(PackedStrs::encode(&v, hint)), 0, true);
        }
        if vals > 0 && cnt[T_JSON as usize] == vals && depth < 2 {
            if let Some(list) = ListCol::shred(t, hint, depth) {
                return mk(Data::List(Box::new(list)), 0, true);
            }
        }
        let v: Vec<String> = t.cells().map(|c| to_text(&c)).collect();
        Chunk {
            data: Data::Mixed(PackedStrs::encode(&v, hint)),
            nulls: None,
            missing: None,
            fill: 0,
            holes,
            len: n as u32,
            safe_sum: true,
            patches: BTreeMap::new(),
        }
    }
    fn stored(&self, i: usize) -> Cell {
        if let Data::Mixed(p) = &self.data {
            let mut b = vec![];
            return from_text(p.get(i, &mut b));
        }
        if bit(&self.missing, i) {
            return Cell::Missing;
        }
        if bit(&self.nulls, i) {
            return Cell::Null;
        }
        match &self.data {
            Data::Absent => Cell::Missing,
            Data::Int { p, is_bool } => {
                if *is_bool {
                    Cell::Bool(p.get(i) != 0)
                } else {
                    Cell::Int(p.get(i))
                }
            }
            Data::Dec { scale, p } => Cell::Float(p.get(i) as f64 / POW10[*scale as usize]),
            Data::F64(v) => Cell::Float(v[i]),
            Data::Str(p) => Cell::Str(p.get_string(i)),
            Data::List(l) => Cell::Json(l.text(i)),
            Data::Mixed(_) => unreachable!(),
        }
    }
    #[inline]
    fn get(&self, i: usize) -> Cell {
        if !self.patches.is_empty() {
            if let Some(c) = self.patches.get(&(i as u32)) {
                return c.clone();
            }
        }
        self.stored(i)
    }
    #[inline]
    fn emit<V: RowVisitor>(&self, o: usize, ci: usize, seg: usize, v: &mut V, buf: &mut Vec<u8>) {
        if !self.patches.is_empty() {
            if let Some(c) = self.patches.get(&(o as u32)) {
                return emit_cell(v, ci, c);
            }
        }
        match &self.data {
            Data::Absent => {}
            Data::Mixed(p) => {
                let c = from_text(p.get(o, buf));
                emit_cell(v, ci, &c)
            }
            d => {
                if self.holes > 0 {
                    if bit(&self.missing, o) {
                        return;
                    }
                    if bit(&self.nulls, o) {
                        return v.null(ci);
                    }
                }
                match d {
                    Data::Int { p, is_bool } => {
                        if *is_bool {
                            v.boolean(ci, p.get(o) != 0)
                        } else {
                            v.int(ci, p.get(o))
                        }
                    }
                    Data::Dec { scale, p } => v.float(ci, p.get(o) as f64 / POW10[*scale as usize]),
                    Data::F64(x) => v.float(ci, x[o]),
                    Data::Str(p) => match p.dict_code(o) {
                        Some((code, n)) => v.dict_str(ci, seg, code, n, &mut || p.dict_value(code)),
                        None => v.str(ci, &String::from_utf8_lossy(p.get(o, buf))),
                    },
                    Data::List(l) => l.emit(o, ci, seg, v, buf),
                    Data::Absent | Data::Mixed(_) => unreachable!(),
                }
            }
        }
    }
    fn clean(&self) -> bool {
        self.patches.is_empty()
    }
    /// Is row `i` present and not null?
    fn has_value(&self, i: usize, buf: &mut Vec<u8>) -> bool {
        if !self.patches.is_empty() {
            if let Some(c) = self.patches.get(&(i as u32)) {
                return !matches!(c, Cell::Missing | Cell::Null);
            }
        }
        match &self.data {
            Data::Absent => false,
            Data::Mixed(p) => !matches!(p.get(i, buf), b"" | b"null"),
            _ => !self.hole(i),
        }
    }
    /// A measure of every row's string value; rows that are not strings count as zero.
    fn str_measures(&self, measure: StrMeasure, buf: &mut Vec<u8>) -> Vec<i64> {
        let n = self.len as usize;
        match (&self.data, self.clean()) {
            (Data::Str(p), true) => {
                // a dictionary column is measured once per distinct value
                let mut memo: Vec<Option<i64>> = Vec::new();
                (0..n)
                    .map(|i| {
                        if self.holes > 0 && self.hole(i) {
                            return 0;
                        }
                        match p.dict_code(i) {
                            Some((code, len)) => {
                                if memo.is_empty() {
                                    memo.resize(len, None)
                                }
                                *memo[code as usize]
                                    .get_or_insert_with(|| measure.of(&p.dict_value(code)))
                            }
                            None => measure.of(&String::from_utf8_lossy(p.get(i, buf))),
                        }
                    })
                    .collect()
            }
            _ => (0..n)
                .map(|i| match self.get(i) {
                    Cell::Str(s) => measure.of(&s),
                    _ => 0,
                })
                .collect(),
        }
    }
    fn hole(&self, i: usize) -> bool {
        bit(&self.missing, i) || bit(&self.nulls, i)
    }
    fn bytes(&self) -> usize {
        (match &self.data {
            Data::Absent => 0,
            Data::Int { p, .. } | Data::Dec { p, .. } => p.bytes(),
            Data::F64(v) => v.len() * 8,
            Data::Str(p) | Data::Mixed(p) => p.bytes(),
            Data::List(l) => l.bytes(),
        }) + self.nulls.as_ref().map_or(0, |b| b.len() * 8)
            + self.missing.as_ref().map_or(0, |b| b.len() * 8)
            + self
                .patches
                .values()
                .map(|c| {
                    48 + match c {
                        Cell::Str(s) | Cell::Json(s) => s.len(),
                        _ => 0,
                    }
                })
                .sum::<usize>()
            + 96
    }
    fn describe(&self) -> String {
        match &self.data {
            Data::Absent => "absent".into(),
            Data::Int { p, is_bool } => {
                format!("{}:{}", if *is_bool { "bool" } else { "int" }, p.describe())
            }
            Data::Dec { scale, p } => format!("decimal{}:{}", scale, p.describe()),
            Data::F64(_) => "f64".into(),
            Data::Str(p) => format!("str:{}", p.describe()),
            Data::Mixed(p) => format!("mixed:{}", p.describe()),
            Data::List(l) => l.describe(),
        }
    }
    fn select(&self, pred: &Pred, base: u32, out: &mut Vec<u32>) {
        let n = self.len as usize;
        let start = out.len();
        let mut fast = false;
        if self.clean() {
            match (&self.data, pred) {
                (Data::Absent, _) => fast = true,
                (Data::Int { p, is_bool: false }, Pred::Eq(Cell::Int(v))) => {
                    p.select_range(*v, *v, out);
                    fast = true
                }
                (
                    Data::Int { p, is_bool: false },
                    Pred::Range {
                        lo,
                        hi,
                        lo_incl,
                        hi_incl,
                    },
                ) => {
                    let l = if *lo <= -9.2e18 {
                        i64::MIN
                    } else if *lo >= 9.2e18 {
                        i64::MAX
                    } else {
                        let c = lo.ceil();
                        (c as i64) + (c == *lo && !*lo_incl) as i64
                    };
                    let h = if *hi >= 9.2e18 {
                        i64::MAX
                    } else if *hi <= -9.2e18 {
                        i64::MIN
                    } else {
                        let f = hi.floor();
                        (f as i64) - (f == *hi && !*hi_incl) as i64
                    };
                    if l <= h && !lo.is_nan() && !hi.is_nan() {
                        p.select_range(l, h, out)
                    }
                    fast = true
                }
                (
                    Data::Dec { scale, p },
                    Pred::Range {
                        lo,
                        hi,
                        lo_incl,
                        hi_incl,
                    },
                ) => {
                    if let Some((l, h)) = dec_bounds(*lo, *hi, *lo_incl, *hi_incl, *scale as usize)
                    {
                        if l <= h {
                            p.select_range(l, h, out)
                        }
                        fast = true
                    }
                }
                (Data::Dec { scale, p }, Pred::Eq(Cell::Float(x))) => {
                    if let Some((l, h)) = dec_bounds(*x, *x, true, true, *scale as usize) {
                        if l <= h {
                            p.select_range(l, h, out)
                        }
                        fast = true
                    }
                }
                (Data::Str(p), Pred::Eq(Cell::Str(s))) => {
                    p.select_where(|b| b == s.as_bytes(), out);
                    fast = true
                }
                (Data::Str(p), Pred::Prefix(s)) => {
                    p.select_where(|b| b.starts_with(s.as_bytes()), out);
                    fast = true
                }
                (Data::Str(p), Pred::Contains(s)) => {
                    p.select_where(|b| has(b, s.as_bytes()), out);
                    fast = true
                }
                (Data::Str(_), Pred::Range { .. })
                | (Data::Int { is_bool: false, .. }, Pred::Prefix(_) | Pred::Contains(_)) => {
                    fast = true
                } // type can never match
                _ => {}
            }
        }
        if fast {
            if self.holes > 0 && !matches!(self.data, Data::Absent) {
                let mut w = start;
                for r in start..out.len() {
                    let i = out[r];
                    if !self.hole(i as usize) {
                        out[w] = i;
                        w += 1
                    }
                }
                out.truncate(w)
            }
            for x in &mut out[start..] {
                *x += base
            }
        } else {
            for i in 0..n {
                if matches(&self.get(i), pred) {
                    out.push(base + i as u32)
                }
            }
        }
    }
}

/// Full chunks, then an optional sealed partial chunk (`plen` rows), then the uncompressed tail.
struct Column {
    chunks: Vec<Chunk>,
    partial: Option<Chunk>,
    tail: Tail,
}
const MIN_COMPACT: usize = 8192;
/// A chunk with at least this much string data is packed on a background thread during a parallel bulk load.
const PARALLEL_TEXT_BYTES: usize = 4 << 20;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Num {
    Int(i128),
    Float(f64),
}
impl Num {
    fn add(self, c: &Cell) -> Num {
        match (self, c) {
            (Num::Int(a), Cell::Int(b)) => Num::Int(a + *b as i128),
            (Num::Int(a), Cell::Bool(b)) => Num::Int(a + *b as i128),
            (Num::Float(a), Cell::Int(b)) => Num::Float(a + *b as f64),
            (Num::Float(a), Cell::Bool(b)) => Num::Float(a + *b as i64 as f64),
            (Num::Int(a), Cell::Float(b)) => Num::Float(a as f64 + b),
            (Num::Float(a), Cell::Float(b)) => Num::Float(a + b),
            (s, _) => s,
        }
    }
    fn plus(self, o: Num) -> Num {
        match (self, o) {
            (Num::Int(a), Num::Int(b)) => Num::Int(a + b),
            (Num::Int(a), Num::Float(b)) | (Num::Float(b), Num::Int(a)) => Num::Float(a as f64 + b),
            (Num::Float(a), Num::Float(b)) => Num::Float(a + b),
        }
    }
}

impl Column {
    fn sealed(&self) -> impl Iterator<Item = &Chunk> {
        self.chunks.iter().chain(self.partial.iter())
    }
    /// Pack every row after the last full chunk (sealed partial + tail) into one chunk. With `keep`, the tail's buffers are
    /// emptied but stay allocated for the next chunk, which avoids regrowing them during a bulk load.
    fn seal_open(&mut self, hint: Hint, keep: bool) -> Chunk {
        let ch = match self.partial.take() {
            None => Chunk::seal(&self.tail, hint),
            Some(p) => {
                let mut t = Tail::default();
                for i in 0..p.len as usize {
                    t.push(&p.get(i))
                }
                for c in self.tail.cells() {
                    t.push(&c)
                }
                Chunk::seal(&t, hint)
            }
        };
        if keep {
            self.tail.clear()
        } else {
            self.tail = Tail::default()
        }
        ch
    }
}

pub struct DynTable {
    names: Vec<String>,
    index: HashMap<String, usize>,
    cols: Vec<Column>,
    len: usize,
    plen: usize,
    epoch: u64,
    cur: usize,
    bulk: bool,
    /// Chunks being packed on background threads during a parallel bulk load, oldest first.
    sealers: std::collections::VecDeque<std::thread::JoinHandle<(Vec<Chunk>, Vec<Tail>)>>,
    /// Emptied tail buffers handed back by finished background threads, reused for the next chunk.
    spare_tails: Vec<Tail>,
    seal_threads: usize,
    pub hint: Hint,
}

impl DynTable {
    pub fn new(hint: Hint) -> Self {
        DynTable {
            names: vec![],
            index: HashMap::new(),
            cols: vec![],
            len: 0,
            plen: 0,
            epoch: 0,
            cur: 0,
            bulk: false,
            sealers: std::collections::VecDeque::new(),
            spare_tails: Vec::new(),
            seal_threads: 0,
            hint,
        }
    }
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn names(&self) -> &[String] {
        &self.names
    }
    pub fn col_index(&self, name: &str) -> Option<usize> {
        self.index.get(name).copied()
    }
    fn tail_len(&self) -> usize {
        self.len % CHUNK - self.plen
    }
    fn col_or_create(&mut self, name: &str) -> usize {
        if let Some(&i) = self.index.get(name) {
            return i;
        }
        // chunks still being packed in the background are added when they finish, for every column
        let nch = self.len / CHUNK - self.sealers.len();
        let tl = self.tail_len();
        let pl = self.plen;
        self.cols.push(Column {
            chunks: (0..nch).map(|_| Chunk::absent(CHUNK)).collect(),
            partial: if pl > 0 {
                Some(Chunk::absent(pl))
            } else {
                None
            },
            tail: Tail::missing(tl),
        });
        self.names.push(name.to_string());
        self.index.insert(name.to_string(), self.cols.len() - 1);
        self.cols.len() - 1
    }
    /// Append one record. Unknown keys create a column; keys absent from this record read back as `Missing`.
    pub fn append<'a>(&mut self, row: impl IntoIterator<Item = (&'a str, Cell)>) {
        for (k, v) in row {
            let c = self.col_for(k);
            self.put_at(c, v)
        }
        self.end_row()
    }
    /// Column for the next key of the row being built. Records usually repeat the same key order, so the expected position is tried before hashing.
    pub fn col_for(&mut self, name: &str) -> usize {
        let j = self.cur;
        let c = if j < self.names.len() && self.names[j] == name {
            j
        } else {
            self.col_or_create(name)
        };
        self.cur = c + 1;
        c
    }
    /// Set one cell of the row being built (`col_for`, `put_at`..., then `end_row`; `abort_row` discards it).
    pub fn put_at(&mut self, c: usize, v: Cell) {
        let slot = self.tail_len();
        let t = &mut self.cols[c].tail;
        if t.len() == slot {
            t.push(&v)
        } else {
            t.set(slot, &v)
        }
    }
    /// Same as `put_at` with a string cell, without building a `Cell`.
    pub fn put_str_at(&mut self, c: usize, s: &str) {
        let slot = self.tail_len();
        let t = &mut self.cols[c].tail;
        let v = t.intern(s);
        if t.len() == slot {
            t.tags.push(T_STR);
            t.vals.push(v)
        } else {
            t.tags[slot] = T_STR;
            t.vals[slot] = v
        }
    }
    pub fn end_row(&mut self) {
        let slot = self.tail_len();
        self.cur = 0;
        for c in &mut self.cols {
            if c.tail.len() == slot {
                c.tail.push(&Cell::Missing)
            }
        }
        self.len += 1;
        // Compressing text is what makes packing slow, so a chunk holding a lot of it is handed to a background thread
        // while parsing continues. Chunks of numbers and short strings are packed here: handing them off would only
        // keep more unpacked buffers alive.
        let heavy = self.len % CHUNK == 0
            && self.bulk
            && self.seal_threads > 0
            && self.plen == 0
            && self.cols.iter().map(|c| c.tail.text.len()).sum::<usize>() >= PARALLEL_TEXT_BYTES;
        if heavy {
            if self.sealers.len() >= self.seal_threads {
                self.join_oldest()
            }
            let h = self.hint;
            let spares = &mut self.spare_tails;
            let tails: Vec<Tail> = self
                .cols
                .iter_mut()
                .map(|c| std::mem::replace(&mut c.tail, spares.pop().unwrap_or_default()))
                .collect();
            self.sealers.push_back(std::thread::spawn(move || {
                let chunks = tails.iter().map(|t| Chunk::seal(t, h)).collect();
                (chunks, tails)
            }));
            self.epoch += 1
        } else if self.len % CHUNK == 0 {
            self.join_all();
            let (h, keep) = (self.hint, self.bulk);
            for c in &mut self.cols {
                let ch = c.seal_open(h, keep);
                c.chunks.push(ch)
            }
            self.plen = 0;
            self.epoch += 1
        } else if !self.bulk && self.tail_len() >= MIN_COMPACT.max(self.plen) {
            self.compact()
        }
    }
    pub fn abort_row(&mut self) {
        let slot = self.tail_len();
        self.cur = 0;
        for c in &mut self.cols {
            c.tail.truncate(slot)
        }
    }
    /// Like `set_bulk(true)`, and full chunks are packed on up to `threads` background threads while the caller keeps
    /// appending. The table must not be read until `set_bulk(false)`, which waits for them. The result is identical
    /// to a single-threaded load; up to `threads` unpacked chunks are held at once.
    pub fn set_bulk_parallel(&mut self, threads: usize) {
        self.bulk = true;
        self.seal_threads = threads
    }
    fn join_oldest(&mut self) {
        let Some(h) = self.sealers.pop_front() else {
            return;
        };
        let (chunks, mut tails) = h.join().unwrap_or_else(|e| std::panic::resume_unwind(e));
        for t in &mut tails {
            t.clear()
        }
        self.spare_tails.append(&mut tails);
        let mut chunks = chunks.into_iter();
        for c in &mut self.cols {
            // a column created after this chunk was handed off has no values in it
            c.chunks
                .push(chunks.next().unwrap_or_else(|| Chunk::absent(CHUNK)))
        }
    }
    fn join_all(&mut self) {
        while !self.sealers.is_empty() {
            self.join_oldest()
        }
    }
    /// While on, rows are only packed when a chunk fills, which avoids re-packing the open chunk as it grows. Turning it off packs what is left.
    pub fn set_bulk(&mut self, on: bool) {
        self.bulk = on;
        if !on {
            self.seal_threads = 0;
            self.compact();
            self.spare_tails = Vec::new();
            release_spare_tails();
            crate::ztext::release();
            for c in &mut self.cols {
                if c.tail.len() == 0 {
                    c.tail = Tail::default()
                }
            }
        }
    }
    /// Report rows `a..b` to a visitor, cell by cell in column order.
    pub fn visit_rows<V: RowVisitor>(&self, a: usize, b: usize, v: &mut V) {
        let b = b.min(self.len);
        let nfull = self.len / CHUNK;
        let mut r = a;
        let mut buf = Vec::new();
        while r < b {
            let (k, o) = (r / CHUNK, r % CHUNK);
            let (seg_end, tail) = if k < nfull {
                ((k + 1) * CHUNK, false)
            } else if o < self.plen {
                (k * CHUNK + self.plen, false)
            } else {
                (self.len, true)
            };
            let e = seg_end.min(b);
            for row in r..e {
                let o = row % CHUNK;
                v.begin();
                for (ci, c) in self.cols.iter().enumerate() {
                    if tail {
                        c.tail.emit(o - self.plen, ci, v)
                    } else {
                        let ch = if k < nfull {
                            &c.chunks[k]
                        } else {
                            c.partial.as_ref().unwrap()
                        };
                        ch.emit(o, ci, k, v, &mut buf)
                    }
                }
                v.end()
            }
            r = e
        }
    }
    /// Pack the rows that are still uncompressed. Called automatically as the table grows (amortised), and by bulk loaders when they finish.
    pub fn compact(&mut self) {
        self.join_all();
        if self.tail_len() == 0 {
            return;
        }
        let h = self.hint;
        for c in &mut self.cols {
            c.partial = Some(c.seal_open(h, false))
        }
        self.plen = self.len % CHUNK;
        self.epoch += 1
    }
    #[inline]
    pub fn get(&self, row: usize, col: usize) -> Cell {
        let c = &self.cols[col];
        let (k, o) = (row / CHUNK, row % CHUNK);
        if k < c.chunks.len() {
            c.chunks[k].get(o)
        } else if o < self.plen {
            c.partial.as_ref().unwrap().get(o)
        } else {
            c.tail.get(o - self.plen)
        }
    }
    /// Update one cell in place. Sealed rows are patched; heavily patched chunks are re-encoded.
    pub fn set(&mut self, row: usize, col: usize, v: Cell) {
        let h = self.hint;
        self.epoch += 1;
        let c = &mut self.cols[col];
        let k = row / CHUNK;
        let o = row % CHUNK;
        if k >= c.chunks.len() && o >= self.plen {
            c.tail.set(o - self.plen, &v);
            return;
        }
        let ch = if k < c.chunks.len() {
            &mut c.chunks[k]
        } else {
            c.partial.as_mut().unwrap()
        };
        ch.patches.insert(o as u32, v);
        if ch.patches.len() > MAX_PATCHES {
            let cells: Vec<Cell> = (0..ch.len as usize).map(|i| ch.get(i)).collect();
            *ch = Chunk::seal_cells(&cells, h)
        }
    }
    pub fn set_by_name(&mut self, row: usize, name: &str, v: Cell) {
        let c = self.col_or_create(name);
        self.set(row, c, v)
    }
    fn chunk_of(&self, row: usize, col: usize) -> Option<(usize, &Chunk, usize)> {
        let c = &self.cols[col];
        let (k, o) = (row / CHUNK, row % CHUNK);
        if k < c.chunks.len() {
            Some((k, &c.chunks[k], o))
        } else if o < self.plen {
            c.partial.as_ref().map(|p| (k, p, o))
        } else {
            None
        }
    }
    /// For a dictionary-encoded string cell: (chunk id, dictionary code, dictionary size). Lets callers cache decoded values per chunk.
    #[inline]
    pub fn str_code(&self, row: usize, col: usize) -> Option<(usize, u32, usize)> {
        let (k, ch, o) = self.chunk_of(row, col)?;
        if !ch.clean() || ch.holes > 0 {
            return None;
        }
        match &ch.data {
            Data::Str(p) => p.dict_code(o).map(|(code, n)| (k, code, n)),
            _ => None,
        }
    }
    pub fn dict_value(&self, row: usize, col: usize, code: u32) -> String {
        match self.chunk_of(row, col) {
            Some((
                _,
                Chunk {
                    data: Data::Str(p), ..
                },
                _,
            )) => p.dict_value(code),
            _ => String::new(),
        }
    }
    /// Changes whenever sealed data is rewritten, so per-chunk caches can be invalidated.
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    pub fn row(&self, row: usize) -> Vec<Cell> {
        (0..self.cols.len()).map(|c| self.get(row, c)).collect()
    }
    /// Row ids matching a predicate on one column; evaluated on encoded chunks where possible.
    pub fn select(&self, col: usize, pred: &Pred) -> Vec<u32> {
        let c = &self.cols[col];
        let mut out = vec![];
        for (k, ch) in c.sealed().enumerate() {
            ch.select(pred, (k * CHUNK) as u32, &mut out)
        }
        let base = (c.chunks.len() * CHUNK + self.plen) as u32;
        for (i, cell) in c.tail.cells().enumerate() {
            if matches(&cell, pred) {
                out.push(base + i as u32)
            }
        }
        out
    }
    pub fn sum(&self, col: usize, sel: Option<&[u32]>) -> Num {
        let c = &self.cols[col];
        let mut s = Num::Int(0);
        if let Some(sel) = sel {
            // work through the selection one chunk at a time, so the chunk and its encoding are resolved once per run
            let (mut i, mut offs) = (0, Vec::new());
            while i < sel.len() {
                let k = sel[i] as usize / CHUNK;
                let j = i + sel[i..]
                    .iter()
                    .take_while(|&&r| r as usize / CHUNK == k)
                    .count();
                let run = &sel[i..j];
                i = j;
                match self.chunk_of(run[0] as usize, col) {
                    Some((_, ch, _))
                        if ch.clean()
                            && (run[run.len() - 1] as usize % CHUNK) < ch.len as usize =>
                    {
                        match (&ch.data, s) {
                            (Data::Absent | Data::Str(_), _) => {}
                            (Data::Int { p, .. }, Num::Int(acc)) if ch.safe_sum => {
                                offs.clear();
                                offs.extend(
                                    run.iter()
                                        .map(|&r| r % CHUNK as u32)
                                        .filter(|&o| ch.holes == 0 || !ch.hole(o as usize)),
                                );
                                s = Num::Int(acc + p.sum_at(&offs) as i128)
                            }
                            (Data::Dec { scale, p }, _) => {
                                let d = POW10[*scale as usize];
                                for &r in run {
                                    let o = r as usize % CHUNK;
                                    if ch.holes == 0 || !ch.hole(o) {
                                        s = s.add(&Cell::Float(p.get(o) as f64 / d))
                                    }
                                }
                            }
                            _ => {
                                for &r in run {
                                    s = s.add(&ch.get(r as usize % CHUNK))
                                }
                            }
                        }
                    }
                    _ => {
                        for &r in run {
                            s = s.add(&self.get(r as usize, col))
                        }
                    }
                }
            }
            return s;
        }
        for ch in c.sealed() {
            let hole_adj = ch.fill.wrapping_mul(ch.holes as i64);
            match (&ch.data, ch.clean() && ch.safe_sum) {
                (Data::Absent, true) => {}
                (Data::Int { p, .. }, true) => s = s.plus(Num::Int((p.sum() - hole_adj) as i128)),
                (Data::Dec { scale, p }, true) => {
                    s = s.plus(Num::Float(
                        (p.sum() - hole_adj) as f64 / POW10[*scale as usize],
                    ))
                }
                (Data::F64(v), true) => s = s.plus(Num::Float(v.iter().sum())),
                (Data::Str(_), true) => {}
                _ => {
                    for i in 0..ch.len as usize {
                        s = s.add(&ch.get(i))
                    }
                }
            }
        }
        for cell in c.tail.cells() {
            s = s.add(&cell)
        }
        s
    }
    /// GROUP BY value -> count. Keys are returned as cells.
    pub fn group_count(&self, col: usize, sel: Option<&[u32]>) -> Vec<(Cell, usize)> {
        let c = &self.cols[col];
        let mut m: HashMap<String, usize> = HashMap::new();
        // plain string chunks are counted by their bytes, which skips a JSON encode and decode per group
        let mut strs: HashMap<Box<[u8]>, usize, std::hash::BuildHasherDefault<Fx>> =
            HashMap::default();
        if let Some(sel) = sel {
            // dictionary columns: count codes per chunk and decode each distinct value once
            let (mut i, mut counts) = (0, Vec::<usize>::new());
            while i < sel.len() {
                let k = sel[i] as usize / CHUNK;
                let j = i + sel[i..]
                    .iter()
                    .take_while(|&&r| r as usize / CHUNK == k)
                    .count();
                let run = &sel[i..j];
                i = j;
                let dict = match self.chunk_of(run[0] as usize, col) {
                    Some((_, ch, _))
                        if ch.clean()
                            && ch.holes == 0
                            && (run[run.len() - 1] as usize % CHUNK) < ch.len as usize =>
                    {
                        match &ch.data {
                            Data::Str(p) => p.dict_code(0).map(|(_, n)| (p, n)),
                            _ => None,
                        }
                    }
                    _ => None,
                };
                match dict {
                    Some((p, n)) => {
                        counts.clear();
                        counts.resize(n, 0);
                        for &r in run {
                            counts[p.dict_code(r as usize % CHUNK).unwrap().0 as usize] += 1
                        }
                        for (code, &n) in counts.iter().enumerate().filter(|(_, n)| **n > 0) {
                            *m.entry(serde_json::to_string(&p.dict_value(code as u32)).unwrap())
                                .or_default() += n
                        }
                    }
                    None => {
                        for &r in run {
                            *m.entry(to_text(&self.get(r as usize, col))).or_default() += 1
                        }
                    }
                }
            }
        } else {
            for ch in c.sealed() {
                match (&ch.data, ch.clean() && ch.holes == 0) {
                    (Data::Str(p), true) => p.for_each_group(|k, n| match strs.get_mut(k) {
                        Some(v) => *v += n,
                        None => {
                            strs.insert(k.into(), n);
                        }
                    }),
                    _ => {
                        for i in 0..ch.len as usize {
                            *m.entry(to_text(&ch.get(i))).or_default() += 1
                        }
                    }
                }
            }
            for cell in c.tail.cells() {
                *m.entry(to_text(&cell)).or_default() += 1
            }
        }
        if !m.is_empty() {
            // some chunks went through the general path: fold the string counts in so each value appears once
            for (k, n) in strs.drain() {
                *m.entry(serde_json::to_string(&String::from_utf8_lossy(&k)).unwrap())
                    .or_default() += n
            }
        }
        strs.into_iter()
            .map(|(k, n)| (Cell::Str(String::from_utf8_lossy(&k).into_owned()), n))
            .chain(m.into_iter().map(|(k, n)| (from_text(k.as_bytes()), n)))
            .collect()
    }
    /// Approximate bytes held (packed chunks + uncompressed tail).
    pub fn bytes(&self) -> usize {
        self.cols
            .iter()
            .map(|c| c.sealed().map(|ch| ch.bytes()).sum::<usize>() + c.tail.bytes())
            .sum()
    }
    pub fn describe(&self) -> Vec<(String, String, usize)> {
        self.names
            .iter()
            .zip(&self.cols)
            .map(|(n, c)| {
                let mut kinds: Vec<String> = vec![];
                for ch in c.sealed() {
                    let d = ch.describe();
                    if !kinds.contains(&d) {
                        kinds.push(d)
                    }
                }
                (
                    n.clone(),
                    if kinds.len() > 3 {
                        format!("{} (+{} more)", kinds[..3].join(", "), kinds.len() - 3)
                    } else {
                        kinds.join(", ")
                    },
                    c.sealed().map(|ch| ch.bytes()).sum(),
                )
            })
            .collect()
    }
    /// A new table holding the given rows of this one, in the given order (rows may repeat or be left out).
    /// Sorting, deleting and inserting in the middle are built on this; each is a full rebuild, O(rows).
    pub fn take(&self, order: &[u32]) -> DynTable {
        let mut t = DynTable::new(self.hint);
        for name in &self.names {
            t.col_or_create(name);
        }
        t.set_bulk(true);
        for &r in order {
            for c in 0..self.cols.len() {
                match self.get(r as usize, c) {
                    Cell::Missing => {}
                    cell => t.put_at(c, cell),
                }
            }
            t.end_row();
        }
        t.set_bulk(false);
        t
    }
    /// Replace or create a whole column from one value per row, packing it chunk by chunk. Far cheaper than updating
    /// every row, which would patch each packed chunk over and over.
    pub fn set_column(&mut self, name: &str, mut value: impl FnMut(usize) -> Cell) {
        self.compact();
        let c = self.col_or_create(name);
        let (h, nfull, plen) = (self.hint, self.len / CHUNK, self.plen);
        let mut t = Tail::default();
        let mut seal = |start: usize, n: usize| {
            t.clear();
            for i in 0..n {
                t.push(&value(start + i))
            }
            Chunk::seal(&t, h)
        };
        let chunks: Vec<Chunk> = (0..nfull).map(|k| seal(k * CHUNK, CHUNK)).collect();
        let partial = (plen > 0).then(|| seal(nfull * CHUNK, plen));
        self.cols[c] = Column {
            chunks,
            partial,
            tail: Tail::default(),
        };
        self.epoch += 1;
    }
    /// Append every row of `other`, matching columns by name, without leaving native code.
    pub fn extend_from(&mut self, other: &DynTable) {
        let map: Vec<usize> = other.names.iter().map(|n| self.col_or_create(n)).collect();
        let was_bulk = self.bulk;
        self.bulk = true;
        for r in 0..other.len {
            for (c, &dst) in map.iter().enumerate() {
                match other.get(r, c) {
                    Cell::Missing => {}
                    cell => self.put_at(dst, cell),
                }
            }
            self.end_row();
        }
        if !was_bulk {
            self.set_bulk(false)
        }
    }
    /// For every row: does it have a value for this column (the key is present and not null)?
    pub fn notna(&self, col: usize) -> Vec<bool> {
        let c = &self.cols[col];
        let mut out = Vec::with_capacity(self.len);
        let mut buf = Vec::new();
        for ch in c.sealed() {
            for i in 0..ch.len as usize {
                out.push(ch.has_value(i, &mut buf))
            }
        }
        out.extend(c.tail.tags.iter().map(|&t| t != T_MISSING && t != T_NULL));
        out
    }
    /// For every row: the number of elements in its list value, or `None` when the value is not a list.
    pub fn list_len(&self, col: usize) -> Vec<Option<u32>> {
        let c = &self.cols[col];
        let mut out = Vec::with_capacity(self.len);
        for ch in c.sealed() {
            match (&ch.data, ch.clean()) {
                (Data::List(l), true) if !l.is_record => {
                    for i in 0..ch.len as usize {
                        out.push((!ch.hole(i)).then(|| l.offs[i + 1] - l.offs[i]))
                    }
                }
                _ => out.extend((0..ch.len as usize).map(|i| json_list_len(&ch.get(i)))),
            }
        }
        out.extend(c.tail.cells().map(|cell| json_list_len(&cell)));
        out
    }
    /// For every row: the sum, over the records in its list value, of a measure of one string field (`Words` counts
    /// whitespace-separated words as Python's `str.split()` does). `None` when the value is not a list of records.
    pub fn list_str_sum(&self, col: usize, field: &str, measure: StrMeasure) -> Vec<Option<i64>> {
        let c = &self.cols[col];
        let mut out = Vec::with_capacity(self.len);
        let mut buf = Vec::new();
        for ch in c.sealed() {
            match (&ch.data, ch.clean()) {
                (Data::List(l), true) if !l.is_record => {
                    let per_elem = l
                        .names
                        .iter()
                        .position(|n| n == field)
                        .map(|f| l.cols[f].str_measures(measure, &mut buf));
                    for i in 0..ch.len as usize {
                        out.push((!ch.hole(i)).then(|| {
                            let (a, b) = l.range(i);
                            per_elem.as_ref().map_or(0, |m| m[a..b].iter().sum())
                        }))
                    }
                }
                _ => out.extend(
                    (0..ch.len as usize).map(|i| json_list_str_sum(&ch.get(i), field, measure)),
                ),
            }
        }
        out.extend(
            c.tail
                .cells()
                .map(|cell| json_list_str_sum(&cell, field, measure)),
        );
        out
    }
    /// Rows currently held uncompressed.
    pub fn tail_rows(&self) -> usize {
        self.tail_len()
    }
}

use crate::wire::{R, Res, W, bad};
const MAGIC: &[u8; 4] = b"PKM2";

fn write_cell(w: &mut W, c: &Cell) {
    match c {
        Cell::Missing => w.u8(T_MISSING),
        Cell::Null => w.u8(T_NULL),
        Cell::Bool(b) => {
            w.u8(T_BOOL);
            w.bool(*b)
        }
        Cell::Int(i) => {
            w.u8(T_INT);
            w.i64(*i)
        }
        Cell::Float(f) => {
            w.u8(T_FLOAT);
            w.f64(*f)
        }
        Cell::Str(s) => {
            w.u8(T_STR);
            w.bytes(s.as_bytes())
        }
        Cell::Json(s) => {
            w.u8(T_JSON);
            w.bytes(s.as_bytes())
        }
    }
}
fn read_cell(r: &mut R) -> Res<Cell> {
    Ok(match r.get_u8()? {
        T_MISSING => Cell::Missing,
        T_NULL => Cell::Null,
        T_BOOL => Cell::Bool(r.get_bool()?),
        T_INT => Cell::Int(r.get_i64()?),
        T_FLOAT => Cell::Float(r.get_f64()?),
        T_STR => Cell::Str(r.get_string()?),
        T_JSON => Cell::Json(r.get_string()?),
        _ => return bad("cell kind"),
    })
}
fn write_bits(w: &mut W, b: &Option<Bits>) {
    match b {
        None => w.u8(0),
        Some(v) => {
            w.u8(1);
            w.v_u64(v)
        }
    }
}
fn read_bits(r: &mut R, len: usize) -> Res<Option<Bits>> {
    Ok(match r.get_u8()? {
        0 => None,
        _ => {
            let v = r.get_v_u64()?;
            if v.len() != len.div_ceil(64) {
                return bad("bitmap size");
            }
            Some(v)
        }
    })
}

impl Chunk {
    fn write(&self, w: &mut W) {
        match &self.data {
            Data::Absent => w.u8(0),
            Data::Int { p, is_bool } => {
                w.u8(1);
                w.bool(*is_bool);
                p.write(w)
            }
            Data::Dec { scale, p } => {
                w.u8(2);
                w.u8(*scale);
                p.write(w)
            }
            Data::F64(v) => {
                w.u8(3);
                w.v_f64(v)
            }
            Data::Str(p) => {
                w.u8(4);
                p.write(w)
            }
            Data::Mixed(p) => {
                w.u8(5);
                p.write(w)
            }
            Data::List(l) => {
                w.u8(6);
                l.write(w)
            }
        }
        w.u32(self.len);
        w.u32(self.holes);
        w.i64(self.fill);
        w.bool(self.safe_sum);
        write_bits(w, &self.nulls);
        write_bits(w, &self.missing);
        w.u64(self.patches.len() as u64);
        for (i, c) in &self.patches {
            w.u32(*i);
            write_cell(w, c)
        }
    }
    fn read(r: &mut R) -> Res<Chunk> {
        Chunk::read_max(r, CHUNK)
    }
    /// `max` is the most rows the chunk may hold: a table chunk is bounded, a sub-column holds every element of one.
    fn read_max(r: &mut R, max: usize) -> Res<Chunk> {
        let data = match r.get_u8()? {
            0 => Data::Absent,
            1 => {
                let is_bool = r.get_bool()?;
                Data::Int {
                    p: PackedInts::read(r)?,
                    is_bool,
                }
            }
            2 => {
                let scale = r.get_u8()?;
                if scale as usize >= POW10.len() {
                    return bad("decimal scale");
                }
                Data::Dec {
                    scale,
                    p: PackedInts::read(r)?,
                }
            }
            3 => Data::F64(r.get_v_f64()?),
            4 => Data::Str(PackedStrs::read(r)?),
            5 => Data::Mixed(PackedStrs::read(r)?),
            6 => Data::List(Box::new(ListCol::read(r)?)),
            _ => return bad("column kind"),
        };
        let (len, holes, fill, safe_sum) =
            (r.get_u32()?, r.get_u32()?, r.get_i64()?, r.get_bool()?);
        let n = len as usize;
        let stored = match &data {
            Data::Absent => n,
            Data::Int { p, .. } | Data::Dec { p, .. } => p.len(),
            Data::F64(v) => v.len(),
            Data::Str(p) | Data::Mixed(p) => p.len(),
            Data::List(l) => l.offs.len() - 1,
        };
        if n > max || stored != n || holes > len {
            return bad("chunk length");
        }
        let (nulls, missing) = (read_bits(r, n)?, read_bits(r, n)?);
        let mut patches = BTreeMap::new();
        for _ in 0..r.len(5)? {
            let i = r.get_u32()?;
            if i >= len {
                return bad("patch position");
            }
            patches.insert(i, read_cell(r)?);
        }
        Ok(Chunk {
            data,
            nulls,
            missing,
            fill,
            holes,
            len,
            safe_sum,
            patches,
        })
    }
}

impl DynTable {
    /// The table as bytes, holding the packed columns as they are. Reading them back with `from_bytes` does not re-encode
    /// anything, so it costs about one copy of the packed size. The format is tied to this version of the library.
    pub fn to_bytes(&mut self) -> Vec<u8> {
        let mut out = vec![0u8; self.byte_len()];
        self.write_bytes(&mut out);
        out
    }
    /// Size of the table's byte form. Packs any rows still held uncompressed first.
    pub fn byte_len(&mut self) -> usize {
        self.compact();
        let mut w = W::counting();
        self.write(&mut w);
        w.written()
    }
    /// Write the byte form into `out`, which must be exactly `byte_len()` long (call that first: it packs the open rows).
    pub fn write_bytes(&self, out: &mut [u8]) {
        assert_eq!(self.tail_len(), 0, "call byte_len() before write_bytes()");
        let mut w = W::into(out);
        self.write(&mut w);
    }
    /// Stream the byte form to `sink` in small pieces (for writing to a file). Call `byte_len()` first: it packs the
    /// open rows.
    pub fn write_to(
        &self,
        sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
    ) -> std::io::Result<usize> {
        assert_eq!(self.tail_len(), 0, "call byte_len() before write_to()");
        let mut w = W::to_sink(sink);
        self.write(&mut w);
        w.finish()
    }
    fn write(&self, w: &mut W) {
        w.raw(MAGIC);
        w.u8(match self.hint {
            Hint::Memory => 0,
            Hint::Balanced => 1,
            Hint::Speed => 2,
            Hint::Compact => 3,
        });
        w.u64(self.len as u64);
        w.u64(self.cols.len() as u64);
        for (name, c) in self.names.iter().zip(&self.cols) {
            w.bytes(name.as_bytes());
            for ch in c.sealed() {
                ch.write(w)
            }
        }
    }
    /// Read a table by copying its packed columns out of `b`.
    pub fn from_bytes(b: &[u8]) -> Res<DynTable> {
        Self::read(R::new(b))
    }
    /// Open a table whose packed columns stay in `owner`'s bytes (a memory-mapped file) and are read in place: nothing
    /// is copied, and every process mapping the same file shares the same pages. The bytes must not change while the
    /// table, or anything derived from it by reference, is alive.
    pub fn from_backing(owner: std::sync::Arc<dyn crate::buf::Backing>) -> Res<DynTable> {
        Self::read(R::borrowing(&owner))
    }
    fn read(mut r: R) -> Res<DynTable> {
        if r.take(4)? != MAGIC {
            return Err(
                "not packed table data, or written by a different version of packmem".into(),
            );
        }
        let hint = match r.get_u8()? {
            0 => Hint::Memory,
            1 => Hint::Balanced,
            2 => Hint::Speed,
            3 => Hint::Compact,
            _ => return bad("hint"),
        };
        let len = r.get_u64()? as usize;
        let (nfull, plen) = (len / CHUNK, len % CHUNK);
        let mut t = DynTable::new(hint);
        for _ in 0..r.len(8)? {
            let name = r.get_string()?;
            let mut col = Column {
                chunks: Vec::new(),
                partial: None,
                tail: Tail::default(),
            };
            for _ in 0..nfull {
                let ch = Chunk::read(&mut r)?;
                if ch.len as usize != CHUNK {
                    return bad("chunk length");
                }
                col.chunks.push(ch)
            }
            if plen > 0 {
                let ch = Chunk::read(&mut r)?;
                if ch.len as usize != plen {
                    return bad("chunk length");
                }
                col.partial = Some(ch)
            }
            if t.index.insert(name.clone(), t.cols.len()).is_some() {
                return bad("duplicate column");
            }
            t.names.push(name);
            t.cols.push(col)
        }
        if !r.done() {
            return bad("trailing bytes");
        }
        (t.len, t.plen) = (len, plen);
        Ok(t)
    }
}
