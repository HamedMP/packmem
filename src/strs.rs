//! String columns: dictionary (predicates run once per distinct value) and/or FSST
//! (per-string random access, equality on compressed bytes).
use crate::ints::{Hint, Store};
use fsst::{Compressor, CompressorParts, Decompressor};
use std::collections::HashMap;
use std::mem::MaybeUninit;

/// Concatenated strings + offsets, optionally FSST-compressed (each string independently decodable).
/// Only the 255-entry symbol table is kept (about 2.3 KB); the encoder is rebuilt on demand.
pub struct StrPool {
    bytes: Vec<u8>,
    offs: Vec<u32>,
    fsst: Option<Box<CompressorParts>>,
    raw_bytes: usize,
    /// Encoder for needles, built lazily on the first equality query (not needed for decoding).
    enc: std::sync::OnceLock<Compressor>,
}

fn rebuild(p: &CompressorParts) -> Compressor {
    let n = p.n_symbols as usize;
    Compressor::rebuild_from(&p.symbols[..n], &p.lengths[..n])
}

impl StrPool {
    fn build<'a>(items: &[&'a str], hint: Hint) -> Self {
        let raw: usize = items.iter().map(|s| s.len()).sum();
        let mut fsst = None;
        if hint != Hint::Speed && raw >= 16 * 1024 {
            let step = (items.len() / 4096).max(1);
            let sample: Vec<&[u8]> = items.iter().step_by(step).map(|s| s.as_bytes()).collect();
            let c = Compressor::train(&sample);
            let (a, b) = sample.iter().fold((0usize, 0usize), |(a, b), s| {
                (a + s.len(), b + c.compress(s).len())
            });
            let ratio = a as f64 / b.max(1) as f64;
            if ratio >= if hint == Hint::Memory { 1.05 } else { 1.3 } {
                fsst = Some(Box::new(c.into_parts()))
            }
        }
        let mut bytes = Vec::with_capacity(raw / 2);
        let mut offs = Vec::with_capacity(items.len() + 1);
        offs.push(0u32);
        // encode with the rebuilt encoder so that later needle encodings are byte-identical
        let enc = fsst.as_deref().map(rebuild);
        for s in items {
            match &enc {
                Some(c) => bytes.extend_from_slice(&c.compress(s.as_bytes())),
                None => bytes.extend_from_slice(s.as_bytes()),
            }
            offs.push(bytes.len() as u32);
        }
        bytes.shrink_to_fit();
        StrPool {
            bytes,
            offs,
            fsst,
            raw_bytes: raw,
            enc: std::sync::OnceLock::new(),
        }
    }
    pub fn len(&self) -> usize {
        self.offs.len() - 1
    }
    pub fn bytes(&self) -> usize {
        self.bytes.len()
            + self.offs.len() * 4
            + if self.fsst.is_some() {
                std::mem::size_of::<CompressorParts>()
            } else {
                0
            }
    }
    #[inline]
    fn enc(&self, i: usize) -> &[u8] {
        &self.bytes[self.offs[i] as usize..self.offs[i + 1] as usize]
    }
    /// Decode string i into `buf` (reused across calls) and return it. Touches only that string.
    #[inline]
    pub fn get<'a>(&'a self, i: usize, buf: &'a mut Vec<u8>) -> &'a [u8] {
        let e = self.enc(i);
        match &self.fsst {
            None => e,
            Some(c) => {
                let d = Decompressor::new(&c.symbols, &c.lengths);
                buf.clear();
                buf.reserve(d.max_decompression_capacity(e));
                let spare: &mut [MaybeUninit<u8>] = buf.spare_capacity_mut();
                let n = d.decompress_into(e, spare);
                unsafe { buf.set_len(n) }
                &buf[..]
            }
        }
    }
    /// Equality without decoding: compress the needle once, then compare encoded bytes.
    fn count_eq(&self, needle: &[u8]) -> usize {
        let nd = match &self.fsst {
            Some(c) => self.enc.get_or_init(|| rebuild(c)).compress(needle),
            None => needle.to_vec(),
        };
        let (nd, b) = (&nd[..], &self.bytes[..]);
        self.offs
            .windows(2)
            .filter(|w| {
                (w[1] - w[0]) as usize == nd.len() && &b[w[0] as usize..w[1] as usize] == nd
            })
            .count()
    }
}

pub enum PackedStrs {
    Dict {
        pool: StrPool,
        codes: Store,
        len: usize,
    },
    Direct {
        pool: StrPool,
    },
}

impl PackedStrs {
    pub fn encode<S: AsRef<str>>(vals: &[S], hint: Hint) -> Self {
        let n = vals.len();
        let mut map: HashMap<&str, u32> = HashMap::new();
        let mut distinct: Vec<&str> = vec![];
        let mut codes: Vec<u32> = Vec::with_capacity(n);
        let mut dict_ok = true;
        for s in vals {
            let s = s.as_ref();
            if dict_ok {
                let next = distinct.len() as u32;
                let c = *map.entry(s).or_insert_with(|| {
                    distinct.push(s);
                    next
                });
                codes.push(c);
                if distinct.len() > n / 2 + 64 {
                    dict_ok = false
                }
            }
        }
        if dict_ok {
            let total: usize = vals.iter().map(|s| s.as_ref().len()).sum();
            let dbytes: usize = distinct.iter().map(|s| s.len()).sum();
            let w = (32 - (distinct.len() as u32).leading_zeros()).max(1) as usize;
            let dict_cost = dbytes + 4 * distinct.len() + n * w / 8;
            let direct_cost = total + 4 * n;
            if dict_cost * 10 < direct_cost * 9 {
                let pool = StrPool::build(&distinct, hint);
                let max = distinct.len().saturating_sub(1) as u64;
                return PackedStrs::Dict {
                    pool,
                    codes: Store::pack(codes.iter().map(|&c| c as u64), n, max, hint),
                    len: n,
                };
            }
        }
        let refs: Vec<&str> = vals.iter().map(|s| s.as_ref()).collect();
        PackedStrs::Direct {
            pool: StrPool::build(&refs, hint),
        }
    }
    pub fn len(&self) -> usize {
        match self {
            PackedStrs::Dict { len, .. } => *len,
            PackedStrs::Direct { pool } => pool.len(),
        }
    }
    pub fn bytes(&self) -> usize {
        match self {
            PackedStrs::Dict { pool, codes, .. } => pool.bytes() + codes.bytes(),
            PackedStrs::Direct { pool } => pool.bytes(),
        }
    }
    pub fn raw_bytes(&self) -> usize {
        match self {
            PackedStrs::Dict { pool, .. } | PackedStrs::Direct { pool } => pool.raw_bytes,
        }
    }
    pub fn describe(&self) -> String {
        let f = |p: &StrPool| if p.fsst.is_some() { "+fsst" } else { "" };
        match self {
            PackedStrs::Dict { pool, codes, .. } => {
                format!("dict({}){}/{}", pool.len(), f(pool), codes.kind())
            }
            PackedStrs::Direct { pool } => format!("direct{}", f(pool)),
        }
    }
    #[inline]
    pub fn get<'a>(&'a self, i: usize, buf: &'a mut Vec<u8>) -> &'a [u8] {
        match self {
            PackedStrs::Dict { pool, codes, .. } => pool.get(codes.get(i) as usize, buf),
            PackedStrs::Direct { pool } => pool.get(i, buf),
        }
    }
    /// Dictionary code of row i and the dictionary size, when this column is dictionary-encoded.
    #[inline]
    pub fn dict_code(&self, i: usize) -> Option<(u32, usize)> {
        match self {
            PackedStrs::Dict { pool, codes, .. } => Some((codes.get(i) as u32, pool.len())),
            _ => None,
        }
    }
    /// The string behind a dictionary code.
    pub fn dict_value(&self, code: u32) -> String {
        match self {
            PackedStrs::Dict { pool, .. } => {
                let mut b = vec![];
                String::from_utf8_lossy(pool.get(code as usize, &mut b)).into_owned()
            }
            _ => String::new(),
        }
    }
    pub fn get_string(&self, i: usize) -> String {
        let mut b = vec![];
        String::from_utf8_lossy(self.get(i, &mut b)).into_owned()
    }
    /// Evaluate an arbitrary predicate. Dict: once per distinct value, then a scan of the codes.
    pub fn count_where(&self, pred: impl Fn(&[u8]) -> bool) -> usize {
        let mut buf = vec![];
        match self {
            PackedStrs::Dict { pool, codes, len } => {
                let hit: Vec<u64> = (0..pool.len())
                    .map(|i| pred(pool.get(i, &mut buf)) as u64)
                    .collect();
                let mut c = 0u64;
                codes.for_each(*len, |k| c += hit[k as usize]);
                c as usize
            }
            PackedStrs::Direct { pool } => (0..pool.len())
                .filter(|&i| pred(pool.get(i, &mut buf)))
                .count(),
        }
    }
    pub fn select_where(&self, pred: impl Fn(&[u8]) -> bool, out: &mut Vec<u32>) {
        let mut buf = vec![];
        match self {
            PackedStrs::Dict { pool, codes, len } => {
                let hit: Vec<bool> = (0..pool.len())
                    .map(|i| pred(pool.get(i, &mut buf)))
                    .collect();
                let mut i = 0u32;
                codes.for_each(*len, |k| {
                    if hit[k as usize] {
                        out.push(i)
                    }
                    i += 1
                })
            }
            PackedStrs::Direct { pool } => {
                for i in 0..pool.len() {
                    if pred(pool.get(i, &mut buf)) {
                        out.push(i as u32)
                    }
                }
            }
        }
    }
    pub fn count_eq(&self, needle: &str) -> usize {
        match self {
            PackedStrs::Dict { .. } => self.count_where(|s| s == needle.as_bytes()),
            PackedStrs::Direct { pool } => pool.count_eq(needle.as_bytes()),
        }
    }
    /// GROUP BY value -> count. Dict: a histogram over codes; strings are never materialised per row.
    pub fn group_count(&self) -> Vec<(String, usize)> {
        match self {
            PackedStrs::Dict { pool, codes, len } => {
                let mut h = vec![0usize; pool.len()];
                codes.for_each(*len, |k| h[k as usize] += 1);
                let mut b = vec![];
                h.into_iter()
                    .enumerate()
                    .map(|(i, c)| (String::from_utf8_lossy(pool.get(i, &mut b)).into_owned(), c))
                    .collect()
            }
            PackedStrs::Direct { pool } => {
                let mut m: HashMap<Vec<u8>, usize> = HashMap::new();
                let mut b = vec![];
                for i in 0..pool.len() {
                    *m.entry(pool.get(i, &mut b).to_vec()).or_default() += 1
                }
                m.into_iter()
                    .map(|(k, c)| (String::from_utf8_lossy(&k).into_owned(), c))
                    .collect()
            }
        }
    }
}
