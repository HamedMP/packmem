//! Integer columns: a small vocabulary of composable lightweight encodings,
//! chosen per column from a sample, each with operators that run on the encoded form.
use crate::buf::Buf;
use std::collections::HashSet;

/// What the caller will mostly do with the data. Steers the encoding choice.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Hint {
    Memory,
    Balanced,
    Speed,
    /// As `Memory`, and long text is compressed with Zstandard in small blocks: about half the size on prose, at the
    /// cost of decoding a block to read a value and of filters reading the text. Builds without Zstandard treat it
    /// as `Memory`.
    Compact,
}

fn width(max: u64) -> u8 {
    (64 - max.leading_zeros()) as u8
}

/// Exact-width bit-packed array (width <= 56), O(1) random access via one unaligned load.
pub struct BitPacked {
    data: Buf<u8>,
    w: u8,
    mask: u64,
}
impl BitPacked {
    fn new(vals: impl Iterator<Item = u64>, n: usize, w: u8) -> Self {
        let mut data = vec![0u8; (n * w as usize + 7) / 8 + 8];
        for (i, v) in vals.enumerate() {
            let bit = i * w as usize;
            let p = bit >> 3;
            let mut x = u64::from_le_bytes(data[p..p + 8].try_into().unwrap());
            x |= v << (bit & 7);
            data[p..p + 8].copy_from_slice(&x.to_le_bytes());
        }
        BitPacked {
            data: data.into(),
            w,
            mask: if w == 0 { 0 } else { (1u64 << w) - 1 },
        }
    }
    #[inline(always)]
    fn get(&self, i: usize) -> u64 {
        let bit = i * self.w as usize;
        let p = bit >> 3;
        let x = u64::from_le_bytes(self.data[p..p + 8].try_into().unwrap());
        (x >> (bit & 7)) & self.mask
    }
}

/// Physical storage of unsigned codes: byte-aligned (SIMD-friendly) or exact-width bits.
pub enum Store {
    A8(Buf<u8>),
    A16(Buf<u16>),
    A32(Buf<u32>),
    A64(Buf<u64>),
    Bits(BitPacked),
}

macro_rules! each {
    ($s:expr, $v:ident => $body:expr, $b:ident, $n:ident => $bits:expr) => {
        match $s {
            Store::A8($v) => $body,
            Store::A16($v) => $body,
            Store::A32($v) => $body,
            Store::A64($v) => $body,
            Store::Bits($b) => {
                let $n = 0usize;
                let _ = $n;
                $bits
            }
        }
    };
}

impl Store {
    /// The field width `pack` will use for codes up to `max` (aligned, or exact bits), and whether it is bit-packed.
    fn layout(max: u64, hint: Hint) -> (u8, bool) {
        let w = width(max);
        let aligned = match w {
            0..=8 => 8,
            9..=16 => 16,
            17..=32 => 32,
            _ => 64,
        };
        let use_bits = w <= 56
            && w < aligned
            && match hint {
                Hint::Memory | Hint::Compact => true,
                Hint::Balanced => aligned as f64 / w.max(1) as f64 >= 1.34,
                Hint::Speed => false,
            };
        (if use_bits { w } else { aligned }, use_bits)
    }
    pub fn pack(vals: impl Iterator<Item = u64> + Clone, n: usize, max: u64, hint: Hint) -> Store {
        let w = width(max);
        let (aligned, use_bits) = match Self::layout(max, hint) {
            (_, true) => (0, true),
            (a, false) => (a, false),
        };
        if use_bits {
            return Store::Bits(BitPacked::new(vals, n, w));
        }
        match aligned {
            8 => Store::A8(vals.map(|v| v as u8).collect()),
            16 => Store::A16(vals.map(|v| v as u16).collect()),
            32 => Store::A32(vals.map(|v| v as u32).collect()),
            _ => Store::A64(vals.collect()),
        }
    }
    pub fn bytes(&self) -> usize {
        match self {
            Store::A8(v) => v.len(),
            Store::A16(v) => v.len() * 2,
            Store::A32(v) => v.len() * 4,
            Store::A64(v) => v.len() * 8,
            Store::Bits(b) => b.data.len(),
        }
    }
    pub fn kind(&self) -> String {
        match self {
            Store::A8(_) => "u8".into(),
            Store::A16(_) => "u16".into(),
            Store::A32(_) => "u32".into(),
            Store::A64(_) => "u64".into(),
            Store::Bits(b) => format!("{}bit", b.w),
        }
    }
    #[inline(always)]
    pub fn get(&self, i: usize) -> u64 {
        match self {
            Store::A8(v) => v[i] as u64,
            Store::A16(v) => v[i] as u64,
            Store::A32(v) => v[i] as u64,
            Store::A64(v) => v[i],
            Store::Bits(b) => b.get(i),
        }
    }
    pub fn sum(&self, n: usize) -> u64 {
        each!(self, v => v.iter().map(|&x| x as u64).sum(), b, _z => (0..n).map(|i| b.get(i)).sum())
    }
    pub fn count_range(&self, n: usize, lo: u64, hi: u64) -> usize {
        each!(self, v => v.iter().filter(|&&x| (x as u64) >= lo && (x as u64) <= hi).count(), b, _z => (0..n).filter(|&i| { let x = b.get(i); x >= lo && x <= hi }).count())
    }
    pub fn select_range(&self, n: usize, lo: u64, hi: u64, out: &mut Vec<u32>) {
        each!(self, v => for (i, &x) in v.iter().enumerate() { if (x as u64) >= lo && (x as u64) <= hi { out.push(i as u32) } },
              b, _z => for i in 0..n { let x = b.get(i); if x >= lo && x <= hi { out.push(i as u32) } })
    }
    pub fn for_each(&self, n: usize, mut f: impl FnMut(u64)) {
        each!(self, v => for &x in v.iter() { f(x as u64) }, b, _z => for i in 0..n { f(b.get(i)) })
    }
}

const BLOCK: usize = 1024;

pub enum PackedInts {
    /// Every value identical.
    Const { v: i64, len: usize },
    /// Frame of reference: value = base + code.
    For { base: i64, s: Store, len: usize },
    /// Sorted dictionary + codes. Order-preserving, so range predicates work on codes.
    Dict {
        dict: Buf<i64>,
        codes: Store,
        len: usize,
    },
    /// Run-length: (value, exclusive end index) per run.
    Rle {
        vals: Buf<i64>,
        ends: Buf<u32>,
        len: usize,
    },
    /// Per-1024-block frame of reference with per-block width (good for sorted/clustered data).
    BlockFor {
        bases: Buf<i64>,
        widths: Buf<u8>,
        offs: Buf<u32>,
        data: Buf<u8>,
        len: usize,
        sorted: bool,
    },
}

pub struct IntStats {
    pub n: usize,
    pub min: i64,
    pub max: i64,
    pub sample_n: usize,
    pub sample_distinct: usize,
    pub avg_run: f64,
    pub block_bits: f64,
    pub sorted: bool,
}

pub fn stats(vals: &[i64]) -> IntStats {
    let n = vals.len();
    let (mut min, mut max, mut sorted) = (i64::MAX, i64::MIN, true);
    let mut prev = i64::MIN;
    for &v in vals {
        if v < min {
            min = v
        }
        if v > max {
            max = v
        }
        if v < prev {
            sorted = false
        }
        prev = v;
    }
    // sample: up to 64 runs of 256 consecutive values, evenly spaced (keeps run/cluster structure visible)
    let run = 256usize;
    let nruns = if n <= 64 * run {
        (n + run - 1) / run
    } else {
        64
    };
    let mut distinct: HashSet<i64> = HashSet::new();
    let (mut sample_n, mut runs, mut bits) = (0usize, 0usize, 0f64);
    for r in 0..nruns {
        let start = if n <= 64 * run {
            r * run
        } else {
            r * (n - run) / (nruns - 1).max(1)
        };
        let s = &vals[start..(start + run).min(n)];
        let (mut lo, mut hi) = (i64::MAX, i64::MIN);
        for (i, &v) in s.iter().enumerate() {
            distinct.insert(v);
            if v < lo {
                lo = v
            }
            if v > hi {
                hi = v
            }
            if i == 0 || v != s[i - 1] {
                runs += 1
            }
        }
        sample_n += s.len();
        bits += width((hi as i128 - lo as i128) as u64) as f64 * s.len() as f64;
    }
    IntStats {
        n,
        min,
        max,
        sample_n,
        sample_distinct: distinct.len(),
        avg_run: sample_n as f64 / runs.max(1) as f64,
        block_bits: bits / sample_n.max(1) as f64 + 13.0 * 8.0 / BLOCK as f64,
        sorted,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scheme {
    Const,
    For,
    Dict,
    Rle,
    BlockFor,
}

/// Estimated bits/value for every applicable scheme (from the sample), before operation weighting.
pub fn estimates(st: &IntStats) -> Vec<(Scheme, f64)> {
    let mut c = vec![];
    if st.n == 0 || st.min == st.max {
        c.push((Scheme::Const, 0.0));
        return c;
    }
    let range = (st.max as i128 - st.min as i128) as u128;
    let w = if range > u64::MAX as u128 {
        64
    } else {
        width(range as u64)
    };
    c.push((Scheme::For, w as f64));
    if st.sample_distinct <= 4096 && st.sample_distinct * 4 < st.sample_n {
        c.push((
            Scheme::Dict,
            width(st.sample_distinct as u64 - 1).max(1) as f64
                + st.sample_distinct as f64 * 64.0 / st.n as f64,
        ));
    }
    if st.avg_run >= 2.0 {
        c.push((Scheme::Rle, 96.0 / st.avg_run));
    }
    c.push((Scheme::BlockFor, st.block_bits));
    c
}

/// Operation-aware choice: bits/value scaled by a per-scheme access-cost penalty for the hint.
pub fn choose(st: &IntStats, hint: Hint) -> Scheme {
    let pen = |s: Scheme| -> f64 {
        match (hint, s) {
            (Hint::Memory | Hint::Compact, _) => 1.0,
            (Hint::Balanced, Scheme::Dict) => 1.1,
            (Hint::Balanced, Scheme::BlockFor) => 1.25,
            (Hint::Balanced, Scheme::Rle) => 1.5,
            (Hint::Speed, Scheme::Dict) => 1.3,
            (Hint::Speed, Scheme::BlockFor) => 2.0,
            (Hint::Speed, Scheme::Rle) => 4.0,
            _ => 1.0,
        }
    };
    // +1 bit floor so that near-zero estimates don't make penalties meaningless
    estimates(st)
        .into_iter()
        .min_by(|a, b| {
            ((a.1 + 0.5) * pen(a.0))
                .partial_cmp(&((b.1 + 0.5) * pen(b.0)))
                .unwrap()
        })
        .unwrap()
        .0
}

impl PackedInts {
    pub fn encode(vals: &[i64], hint: Hint) -> Self {
        let st = stats(vals);
        Self::encode_as(vals, choose(&st, hint), hint, &st)
    }
    pub fn encode_as(vals: &[i64], scheme: Scheme, hint: Hint, st: &IntStats) -> Self {
        let n = vals.len();
        match scheme {
            Scheme::Const => PackedInts::Const {
                v: if n > 0 { st.min } else { 0 },
                len: n,
            },
            Scheme::For => {
                let base = st.min;
                let range = (st.max as i128 - base as i128) as u64;
                PackedInts::For {
                    base,
                    s: Store::pack(
                        vals.iter().map(move |&v| v.wrapping_sub(base) as u64),
                        n,
                        range,
                        hint,
                    ),
                    len: n,
                }
            }
            Scheme::Dict => {
                let mut set: HashSet<i64> = HashSet::new();
                for &v in vals {
                    set.insert(v);
                    if set.len() > 65536 {
                        return Self::encode_as(vals, Scheme::For, hint, st);
                    }
                }
                // The choice was made from a sample, which undercounts distinct values when the tail is long (token ids,
                // Zipf-like keys). Now that the real dictionary is known, keep it only if it is actually smaller.
                let range = (st.max as i128 - st.min as i128) as u128;
                if range <= u64::MAX as u128 {
                    let dict_bits = Store::layout(set.len() as u64 - 1, hint).0 as u128 * n as u128
                        + set.len() as u128 * 64;
                    let for_bits = Store::layout(range as u64, hint).0 as u128 * n as u128;
                    if dict_bits >= for_bits {
                        return Self::encode_as(vals, Scheme::For, hint, st);
                    }
                }
                let mut dict: Vec<i64> = set.into_iter().collect();
                dict.sort_unstable();
                let d = &dict;
                let codes = Store::pack(
                    vals.iter().map(move |v| d.binary_search(v).unwrap() as u64),
                    n,
                    dict.len() as u64 - 1,
                    hint,
                );
                PackedInts::Dict {
                    dict: dict.into(),
                    codes,
                    len: n,
                }
            }
            Scheme::Rle => {
                let (mut rv, mut ends) = (vec![], vec![]);
                for (i, &v) in vals.iter().enumerate() {
                    if i == 0 || v != vals[i - 1] {
                        if i > 0 {
                            ends.push(i as u32)
                        }
                        rv.push(v)
                    }
                }
                if n > 0 {
                    ends.push(n as u32)
                }
                rv.shrink_to_fit();
                ends.shrink_to_fit();
                PackedInts::Rle {
                    vals: rv.into(),
                    ends: ends.into(),
                    len: n,
                }
            }
            Scheme::BlockFor => {
                let (mut bases, mut widths, mut offs, mut data) =
                    (vec![], vec![], vec![], Vec::<u8>::new());
                for blk in vals.chunks(BLOCK) {
                    let lo = *blk.iter().min().unwrap();
                    let hi = *blk.iter().max().unwrap();
                    let range = (hi as i128 - lo as i128) as u128;
                    let w = if range > (1u128 << 56) - 1 {
                        64
                    } else {
                        width(range as u64)
                    };
                    bases.push(lo);
                    widths.push(w);
                    offs.push(data.len() as u32);
                    if w == 64 {
                        for &v in blk {
                            data.extend_from_slice(&(v.wrapping_sub(lo) as u64).to_le_bytes())
                        }
                    } else {
                        let bp = BitPacked::new(blk.iter().map(|&v| (v - lo) as u64), blk.len(), w);
                        data.extend_from_slice(&bp.data[..bp.data.len() - 8]);
                    }
                }
                data.extend_from_slice(&[0u8; 8]);
                data.shrink_to_fit();
                bases.shrink_to_fit();
                widths.shrink_to_fit();
                offs.shrink_to_fit();
                PackedInts::BlockFor {
                    bases: bases.into(),
                    widths: widths.into(),
                    offs: offs.into(),
                    data: data.into(),
                    len: n,
                    sorted: st.sorted,
                }
            }
        }
    }
    pub fn len(&self) -> usize {
        match self {
            PackedInts::Const { len, .. }
            | PackedInts::For { len, .. }
            | PackedInts::Dict { len, .. }
            | PackedInts::Rle { len, .. }
            | PackedInts::BlockFor { len, .. } => *len,
        }
    }
    pub fn bytes(&self) -> usize {
        match self {
            PackedInts::Const { .. } => 16,
            PackedInts::For { s, .. } => s.bytes() + 8,
            PackedInts::Dict { dict, codes, .. } => dict.len() * 8 + codes.bytes(),
            PackedInts::Rle { vals, ends, .. } => vals.len() * 8 + ends.len() * 4,
            PackedInts::BlockFor {
                bases,
                widths,
                offs,
                data,
                ..
            } => bases.len() * 8 + widths.len() + offs.len() * 4 + data.len(),
        }
    }
    pub fn describe(&self) -> String {
        match self {
            PackedInts::Const { .. } => "const".into(),
            PackedInts::For { s, .. } => format!("for/{}", s.kind()),
            PackedInts::Dict { dict, codes, .. } => {
                format!("dict({})/{}", dict.len(), codes.kind())
            }
            PackedInts::Rle { vals, .. } => format!("rle({} runs)", vals.len()),
            PackedInts::BlockFor { sorted, .. } => {
                format!("blockfor{}", if *sorted { "/sorted" } else { "" })
            }
        }
    }
    #[inline]
    fn blk_get(data: &[u8], off: usize, w: u8, i: usize) -> u64 {
        if w == 64 {
            let p = off + i * 8;
            return u64::from_le_bytes(data[p..p + 8].try_into().unwrap());
        }
        if w == 0 {
            return 0;
        }
        let bit = i * w as usize;
        let p = off + (bit >> 3);
        (u64::from_le_bytes(data[p..p + 8].try_into().unwrap()) >> (bit & 7)) & ((1u64 << w) - 1)
    }
    /// O(1) random access (O(log runs) for RLE) without decoding neighbours.
    #[inline]
    pub fn get(&self, i: usize) -> i64 {
        match self {
            PackedInts::Const { v, .. } => *v,
            PackedInts::For { base, s, .. } => base.wrapping_add(s.get(i) as i64),
            PackedInts::Dict { dict, codes, .. } => dict[codes.get(i) as usize],
            PackedInts::Rle { vals, ends, .. } => vals[ends.partition_point(|&e| e as usize <= i)],
            PackedInts::BlockFor {
                bases,
                widths,
                offs,
                data,
                ..
            } => {
                let b = i / BLOCK;
                bases[b].wrapping_add(Self::blk_get(data, offs[b] as usize, widths[b], i % BLOCK) as i64)
            }
        }
    }
    fn blk_len(&self, b: usize) -> usize {
        (self.len() - b * BLOCK).min(BLOCK)
    }
    /// Sum computed on the encoded form (e.g. RLE: value*run; Dict: histogram of codes).
    pub fn sum(&self) -> i64 {
        match self {
            PackedInts::Const { v, len } => v.wrapping_mul(*len as i64),
            PackedInts::For { base, s, len } => base
                .wrapping_mul(*len as i64)
                .wrapping_add(s.sum(*len) as i64),
            PackedInts::Dict { dict, codes, len } => {
                let mut h = vec![0u64; dict.len()];
                codes.for_each(*len, |c| h[c as usize] += 1);
                h.iter()
                    .zip(dict)
                    .fold(0i64, |a, (&c, &v)| a.wrapping_add(v.wrapping_mul(c as i64)))
            }
            PackedInts::Rle { vals, ends, .. } => {
                let mut p = 0u32;
                let mut s = 0i64;
                for (v, &e) in vals.iter().zip(ends) {
                    s = s.wrapping_add(v.wrapping_mul((e - p) as i64));
                    p = e
                }
                s
            }
            PackedInts::BlockFor {
                bases,
                widths,
                offs,
                data,
                ..
            } => {
                let mut s = 0i64;
                for b in 0..bases.len() {
                    let m = self.blk_len(b);
                    s = s.wrapping_add(bases[b].wrapping_mul(m as i64));
                    let (o, w) = (offs[b] as usize, widths[b]);
                    let mut t = 0u64;
                    for i in 0..m {
                        t = t.wrapping_add(Self::blk_get(data, o, w, i))
                    }
                    s = s.wrapping_add(t as i64)
                }
                s
            }
        }
    }
    /// Count of values in [lo, hi], evaluated on codes.
    pub fn count_range(&self, lo: i64, hi: i64) -> usize {
        if lo > hi {
            return 0;
        }
        match self {
            PackedInts::Const { v, len } => {
                if *v >= lo && *v <= hi {
                    *len
                } else {
                    0
                }
            }
            PackedInts::For { base, s, len } => {
                if hi < *base {
                    return 0;
                }
                let l = if lo <= *base {
                    0
                } else {
                    lo.wrapping_sub(*base) as u64
                };
                s.count_range(*len, l, hi.wrapping_sub(*base) as u64)
            }
            PackedInts::Dict { dict, codes, len } => {
                let a = dict.partition_point(|&d| d < lo);
                let b = dict.partition_point(|&d| d <= hi);
                if a >= b {
                    0
                } else {
                    codes.count_range(*len, a as u64, b as u64 - 1)
                }
            }
            PackedInts::Rle { vals, ends, .. } => {
                let mut p = 0u32;
                let mut c = 0usize;
                for (v, &e) in vals.iter().zip(ends) {
                    if *v >= lo && *v <= hi {
                        c += (e - p) as usize
                    }
                    p = e
                }
                c
            }
            PackedInts::BlockFor { bases, sorted, .. } => {
                if *sorted {
                    // binary search on block bases, then inside two blocks only
                    let lb = |x: i64| -> usize {
                        // first index with value >= x
                        let b = bases.partition_point(|&v| v < x);
                        let b0 = b.saturating_sub(1);
                        if bases.is_empty() {
                            return 0;
                        }
                        let m = self.blk_len(b0);
                        let (mut l, mut r) = (0, m);
                        while l < r {
                            let mid = (l + r) / 2;
                            if self.get(b0 * BLOCK + mid) < x {
                                l = mid + 1
                            } else {
                                r = mid
                            }
                        }
                        b0 * BLOCK + l
                    };
                    let a = lb(lo);
                    let b = if hi == i64::MAX {
                        self.len()
                    } else {
                        lb(hi + 1)
                    };
                    b.saturating_sub(a)
                } else {
                    (0..self.len())
                        .filter(|&i| {
                            let v = self.get(i);
                            v >= lo && v <= hi
                        })
                        .count()
                }
            }
        }
    }
    pub fn count_eq(&self, v: i64) -> usize {
        self.count_range(v, v)
    }
    /// Row ids whose value lies in [lo, hi].
    pub fn select_range(&self, lo: i64, hi: i64, out: &mut Vec<u32>) {
        match self {
            PackedInts::For { base, s, len } => {
                if hi < *base {
                    return;
                }
                let l = if lo <= *base {
                    0
                } else {
                    lo.wrapping_sub(*base) as u64
                };
                s.select_range(*len, l, hi.wrapping_sub(*base) as u64, out)
            }
            PackedInts::Dict { dict, codes, len } => {
                let a = dict.partition_point(|&d| d < lo);
                let b = dict.partition_point(|&d| d <= hi);
                if a < b {
                    codes.select_range(*len, a as u64, b as u64 - 1, out)
                }
            }
            PackedInts::Rle { vals, ends, .. } => {
                let mut p = 0u32;
                for (v, &e) in vals.iter().zip(ends) {
                    if *v >= lo && *v <= hi {
                        out.extend(p..e)
                    }
                    p = e
                }
            }
            _ => {
                for i in 0..self.len() {
                    let v = self.get(i);
                    if v >= lo && v <= hi {
                        out.push(i as u32)
                    }
                }
            }
        }
    }
    pub fn sum_at(&self, sel: &[u32]) -> i64 {
        sel.iter()
            .fold(0i64, |a, &i| a.wrapping_add(self.get(i as usize)))
    }
    pub fn to_vec(&self) -> Vec<i64> {
        (0..self.len()).map(|i| self.get(i)).collect()
    }
}

use crate::wire::{R, Res, W, bad};

impl Store {
    pub(crate) fn write(&self, w: &mut W) {
        match self {
            Store::A8(v) => {
                w.u8(0);
                w.v_u8(v)
            }
            Store::A16(v) => {
                w.u8(1);
                w.v_u16(v)
            }
            Store::A32(v) => {
                w.u8(2);
                w.v_u32(v)
            }
            Store::A64(v) => {
                w.u8(3);
                w.v_u64(v)
            }
            Store::Bits(b) => {
                w.u8(4);
                w.u8(b.w);
                w.v_u8(&b.data)
            }
        }
    }
    pub(crate) fn read(r: &mut R) -> Res<Store> {
        Ok(match r.get_u8()? {
            0 => Store::A8(r.get_v_u8()?),
            1 => Store::A16(r.get_v_u16()?),
            2 => Store::A32(r.get_v_u32()?),
            3 => Store::A64(r.get_v_u64()?),
            4 => {
                let w = r.get_u8()?;
                if w > 56 {
                    return bad("bit width");
                }
                Store::Bits(BitPacked {
                    data: r.get_v_u8()?,
                    w,
                    mask: if w == 0 { 0 } else { (1u64 << w) - 1 },
                })
            }
            _ => return bad("store kind"),
        })
    }
}

impl PackedInts {
    pub(crate) fn write(&self, w: &mut W) {
        match self {
            PackedInts::Const { v, len } => {
                w.u8(0);
                w.i64(*v);
                w.u64(*len as u64)
            }
            PackedInts::For { base, s, len } => {
                w.u8(1);
                w.i64(*base);
                s.write(w);
                w.u64(*len as u64)
            }
            PackedInts::Dict { dict, codes, len } => {
                w.u8(2);
                w.v_i64(dict);
                codes.write(w);
                w.u64(*len as u64)
            }
            PackedInts::Rle { vals, ends, len } => {
                w.u8(3);
                w.v_i64(vals);
                w.v_u32(ends);
                w.u64(*len as u64)
            }
            PackedInts::BlockFor {
                bases,
                widths,
                offs,
                data,
                len,
                sorted,
            } => {
                w.u8(4);
                w.v_i64(bases);
                w.v_u8(widths);
                w.v_u32(offs);
                w.v_u8(data);
                w.u64(*len as u64);
                w.bool(*sorted)
            }
        }
    }
    pub(crate) fn read(r: &mut R) -> Res<PackedInts> {
        Ok(match r.get_u8()? {
            0 => PackedInts::Const {
                v: r.get_i64()?,
                len: r.get_u64()? as usize,
            },
            1 => PackedInts::For {
                base: r.get_i64()?,
                s: Store::read(r)?,
                len: r.get_u64()? as usize,
            },
            2 => PackedInts::Dict {
                dict: r.get_v_i64()?,
                codes: Store::read(r)?,
                len: r.get_u64()? as usize,
            },
            3 => PackedInts::Rle {
                vals: r.get_v_i64()?,
                ends: r.get_v_u32()?,
                len: r.get_u64()? as usize,
            },
            4 => PackedInts::BlockFor {
                bases: r.get_v_i64()?,
                widths: r.get_v_u8()?,
                offs: r.get_v_u32()?,
                data: r.get_v_u8()?,
                len: r.get_u64()? as usize,
                sorted: r.get_bool()?,
            },
            _ => return bad("integer encoding"),
        })
    }
}
