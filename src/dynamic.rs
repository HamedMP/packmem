//! Mutable, schema-flexible table: append and update on top of packed chunks.
//!
//! Rows land in an uncompressed tail; every `CHUNK` rows the tail is sealed into packed
//! columns. Updates to sealed rows go to a small per-chunk patch map; a chunk with many
//! patches is re-encoded. Each chunk picks its own type and encoding, so a column may
//! change type over time without rewriting old data.
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
        b'"' => Cell::Str(serde_json::from_str(s).unwrap_or_default()),
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

type Bits = Vec<u64>;
fn bit(b: &Option<Bits>, i: usize) -> bool {
    match b {
        Some(v) => v[i >> 6] >> (i & 63) & 1 == 1,
        None => false,
    }
}
enum Data {
    Absent,
    Int { p: PackedInts, is_bool: bool },
    Dec { scale: u8, p: PackedInts },
    F64(Vec<f64>),
    Str(PackedStrs),
    Mixed(PackedStrs),
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
            Some(v)
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
                    Data::Absent | Data::Mixed(_) => unreachable!(),
                }
            }
        }
    }
    fn clean(&self) -> bool {
        self.patches.is_empty()
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
        let nch = self.len / CHUNK;
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
        if self.len % CHUNK == 0 {
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
    /// While on, rows are only packed when a chunk fills, which avoids re-packing the open chunk as it grows. Turning it off packs what is left.
    pub fn set_bulk(&mut self, on: bool) {
        self.bulk = on;
        if !on {
            self.compact();
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
            for &r in sel {
                let r = r as usize;
                match self.chunk_of(r, col) {
                    Some((_, ch, o)) if ch.clean() => match &ch.data {
                        Data::Absent | Data::Str(_) => {}
                        Data::Int { p, .. } => {
                            if ch.holes == 0 || !ch.hole(o) {
                                s = s.add(&Cell::Int(p.get(o)))
                            }
                        }
                        _ => s = s.add(&ch.get(o)),
                    },
                    _ => s = s.add(&self.get(r, col)),
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
        if let Some(sel) = sel {
            for &r in sel {
                *m.entry(to_text(&self.get(r as usize, col))).or_default() += 1
            }
        } else {
            for ch in c.sealed() {
                match (&ch.data, ch.clean() && ch.holes == 0) {
                    (Data::Str(p), true) => {
                        for (k, n) in p.group_count() {
                            *m.entry(serde_json::to_string(&k).unwrap()).or_default() += n
                        }
                    }
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
        m.into_iter()
            .map(|(k, n)| (from_text(k.as_bytes()), n))
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
    /// Rows currently held uncompressed.
    pub fn tail_rows(&self) -> usize {
        self.tail_len()
    }
}
