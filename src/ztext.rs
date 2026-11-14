//! Long text compressed with Zstandard in small blocks that share a trained dictionary.
//!
//! FSST keeps every string separately decodable and comparable in compressed form, but stops at roughly 2x on
//! prose. Zstandard with a dictionary trained on the column reaches what a compressed file format gets, as long as
//! it has about a kilobyte to work on, so values are grouped into blocks of about that size. Reading a value decodes
//! its block. Used only under `Hint::Compact`, and only in builds with the `ztext` feature (Zstandard is C code).
use crate::buf::Buf;
use crate::wire::{R, Res, W, bad};
use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use zstd::zstd_safe::{CCtx, CDict, DCtx, DDict};

/// Raw bytes a block aims for, and the most values it may hold.
const BLOCK_BYTES: usize = 1024;
const BLOCK_VALUES: usize = 64;
/// How many blocks each thread keeps decoded. A row is read a field at a time, so several columns of compressed
/// text take turns; with one slot each read would decode its block again.
const CACHED_BLOCKS: usize = 8;
const MAX_BLOCK_RAW: usize = 1 << 28;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct ZBlocks {
    /// Identifies this pool in the per-thread cache of the last decoded block.
    id: u64,
    n: usize,
    dict: Arc<Dict>,
    data: Buf<u8>,
    /// Where each block's compressed bytes start in `data`; one extra entry for the end.
    offs: Buf<u32>,
    /// Index of each block's first value; one extra entry holding `n`.
    first: Buf<u32>,
    /// Each block's size once decoded.
    raw_lens: Buf<u32>,
}

/// A trained dictionary, shared by every chunk compressed with it.
struct Dict {
    bytes: Vec<u8>,
    ddict: DDict<'static>,
}
impl Dict {
    fn new(bytes: Vec<u8>) -> Option<Arc<Dict>> {
        let ddict = DDict::try_create(&bytes)?;
        Some(Arc::new(Dict { bytes, ddict }))
    }
}

/// A decoded block: (pool id, block, raw bytes, end offset of each value within them).
type Decoded = (u64, u32, Vec<u8>, Vec<u32>);

struct Trained {
    dict: Arc<Dict>,
    /// The compression ratio the dictionary reached on the sample it was trained for.
    ratio: f64,
}
thread_local! {
    static DCTX: RefCell<DCtx<'static>> = RefCell::new(DCtx::create());
    /// The blocks decoded most recently, and which slot is refilled next.
    static LAST: RefCell<(Vec<Decoded>, usize)> = const { RefCell::new((Vec::new(), 0)) };
    /// The dictionary trained for the previous chunk of text sealed on this thread. Consecutive chunks of one column
    /// usually hold the same kind of text, and training costs far more than checking that the old one still fits.
    static PREV: RefCell<Option<Trained>> = const { RefCell::new(None) };
}
/// Forget the dictionary kept between chunks; called when a bulk load ends.
pub fn release() {
    PREV.with(|p| *p.borrow_mut() = None)
}

/// Bytes of dictionary to train: `PACKMEM_ZSTD_DICT_KB`, 256 KB unless set. One dictionary serves every chunk it
/// still fits, so its size is paid once per column, not once per chunk.
fn dict_bytes() -> usize {
    std::env::var("PACKMEM_ZSTD_DICT_KB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .map_or(256, |kb| kb.clamp(4, 4096))
        * 1024
}
/// Raw bytes a block aims for: `PACKMEM_ZSTD_BLOCK`, else `BLOCK_BYTES`. Larger blocks pack a little tighter and
/// make reading one value slower, since its whole block is decoded.
fn block_bytes() -> usize {
    std::env::var("PACKMEM_ZSTD_BLOCK")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .map_or(BLOCK_BYTES, |b| b.clamp(64, 1 << 20))
}

fn level() -> i32 {
    std::env::var("PACKMEM_ZSTD_LEVEL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3)
}

fn varint(out: &mut Vec<u8>, mut v: usize) {
    while v >= 0x80 {
        out.push(v as u8 | 0x80);
        v >>= 7
    }
    out.push(v as u8)
}

/// One block before compression: every value's length as a varint, then the values end to end.
fn raw_block(items: &[&str], out: &mut Vec<u8>) {
    out.clear();
    for s in items {
        varint(out, s.len())
    }
    for s in items {
        out.extend_from_slice(s.as_bytes())
    }
}

/// Split the values into blocks: (first value, one past the last).
fn blocks(items: &[&str]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let block_bytes = block_bytes();
    let (mut a, mut bytes) = (0, 0);
    for (i, s) in items.iter().enumerate() {
        bytes += s.len();
        if bytes >= block_bytes || i + 1 - a == BLOCK_VALUES {
            out.push((a, i + 1));
            a = i + 1;
            bytes = 0
        }
    }
    if a < items.len() {
        out.push((a, items.len()))
    }
    out
}

fn compress(
    cctx: &mut CCtx<'static>,
    cdict: &CDict<'static>,
    raw: &[u8],
    out: &mut Vec<u8>,
) -> bool {
    out.clear();
    out.reserve(zstd::zstd_safe::compress_bound(raw.len()));
    cctx.compress_using_cdict(out, raw, cdict).is_ok()
}

impl ZBlocks {
    /// Compress `items`, or `None` when a dictionary cannot be trained on them (too little text to learn from).
    pub fn build(items: &[&str]) -> Option<ZBlocks> {
        let spans = blocks(items);
        if spans.is_empty() || items.len() > u32::MAX as usize {
            return None;
        }
        let level = level();
        let mut cctx = CCtx::create();
        let (mut raw, mut comp) = (Vec::new(), Vec::new());
        // a sample of blocks, to judge a dictionary by
        let step = (spans.len() / 64).max(1);
        let sample: Vec<(usize, usize)> = spans.iter().step_by(step).copied().collect();
        let mut ratio_of = |dict: &[u8]| -> Option<f64> {
            let cdict = CDict::try_create(dict, level)?;
            let (mut a, mut b) = (0usize, 0usize);
            for &(x, y) in &sample {
                raw_block(&items[x..y], &mut raw);
                if !compress(&mut cctx, &cdict, &raw, &mut comp) {
                    return None;
                }
                a += raw.len();
                b += comp.len()
            }
            Some(a as f64 / b.max(1) as f64)
        };
        let reused = PREV.with(|p| p.borrow().as_ref().map(|t| (t.dict.clone(), t.ratio)));
        let mut dict = None;
        if let Some((d, was)) = reused {
            if ratio_of(&d.bytes).is_some_and(|now| now >= was * 0.92) {
                dict = Some(d)
            }
        }
        let dict = match dict {
            Some(d) => d,
            None => {
                // train on values spread over the chunk, up to a few megabytes of them
                let step = (items.len() / 20_000).max(1);
                let mut total = 0;
                let samples: Vec<&[u8]> = items
                    .iter()
                    .step_by(step)
                    .map(|s| s.as_bytes())
                    .filter(|s| !s.is_empty())
                    .take_while(|s| {
                        total += s.len();
                        total <= 8 << 20
                    })
                    .collect();
                let d = Dict::new(zstd::dict::from_samples(&samples, dict_bytes()).ok()?)?;
                let ratio = ratio_of(&d.bytes)?;
                PREV.with(|p| {
                    *p.borrow_mut() = Some(Trained {
                        dict: d.clone(),
                        ratio,
                    })
                });
                d
            }
        };
        let cdict = CDict::try_create(&dict.bytes, level)?;
        let mut data = Vec::new();
        let (mut offs, mut first, mut raw_lens) = (
            vec![0u32],
            Vec::with_capacity(spans.len() + 1),
            Vec::with_capacity(spans.len()),
        );
        for &(x, y) in &spans {
            raw_block(&items[x..y], &mut raw);
            if raw.len() > MAX_BLOCK_RAW || !compress(&mut cctx, &cdict, &raw, &mut comp) {
                return None;
            }
            data.extend_from_slice(&comp);
            offs.push(u32::try_from(data.len()).ok()?);
            first.push(x as u32);
            raw_lens.push(raw.len() as u32)
        }
        first.push(items.len() as u32);
        data.shrink_to_fit();
        Some(ZBlocks {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            n: items.len(),
            dict,
            data: data.into(),
            offs: offs.into(),
            first: first.into(),
            raw_lens: raw_lens.into(),
        })
    }
    pub fn len(&self) -> usize {
        self.n
    }
    pub fn bytes(&self) -> usize {
        // the dictionary is counted once over the chunks that share it
        self.dict.bytes.len() / Arc::strong_count(&self.dict).max(1)
            + self.data.len()
            + (self.offs.len() + self.first.len() + self.raw_lens.len()) * 4
    }
    /// Copy value `i` into `buf` and return it. Its block is decoded unless it is the one this thread decoded last.
    pub fn get<'a>(&self, i: usize, buf: &'a mut Vec<u8>) -> &'a [u8] {
        buf.clear();
        let b = self.first.partition_point(|&f| f as usize <= i) - 1;
        LAST.with(|last| {
            let mut last = last.borrow_mut();
            let (slots, next) = &mut *last;
            let hit = slots.iter().position(|d| d.0 == self.id && d.1 == b as u32);
            let k = hit.unwrap_or_else(|| {
                if slots.len() < CACHED_BLOCKS {
                    slots.push((0, 0, Vec::new(), Vec::new()));
                    slots.len() - 1
                } else {
                    *next = (*next + 1) % CACHED_BLOCKS;
                    *next
                }
            });
            let (id, block, raw, ends) = &mut slots[k];
            if hit.is_none() {
                *id = 0; // not valid while it is being refilled
                let src = &self.data[self.offs[b] as usize..self.offs[b + 1] as usize];
                raw.clear();
                raw.reserve(self.raw_lens[b] as usize);
                let ok = DCTX.with(|d| {
                    d.borrow_mut()
                        .decompress_using_ddict(raw, src, &self.dict.ddict)
                        .is_ok()
                });
                ends.clear();
                let count = (self.first[b + 1] - self.first[b]) as usize;
                // the header: one varint length per value
                let (mut p, mut end) = (0usize, 0usize);
                let mut lens = Vec::with_capacity(count);
                while ok && lens.len() < count && p < raw.len() {
                    let (mut v, mut shift) = (0usize, 0);
                    while p < raw.len() {
                        let byte = raw[p];
                        p += 1;
                        v |= ((byte & 0x7f) as usize) << shift;
                        shift += 7;
                        if byte < 0x80 || shift > 56 {
                            break;
                        }
                    }
                    lens.push(v)
                }
                for v in lens {
                    end = end.saturating_add(v);
                    ends.push(p.saturating_add(end).min(raw.len()) as u32)
                }
                // damaged data decodes to empty values rather than reading out of bounds
                ends.resize(count, raw.len() as u32);
                ends.insert(0, p.min(raw.len()) as u32);
                *block = b as u32;
                *id = self.id
            }
            let j = i - self.first[b] as usize;
            buf.extend_from_slice(&raw[ends[j] as usize..ends[j + 1] as usize])
        });
        &buf[..]
    }
    pub fn write(&self, w: &mut W) {
        w.u64(self.n as u64);
        // a dictionary shared by many chunks is written once; the others say which one they use
        let key = Arc::as_ptr(&self.dict) as usize;
        match w.dicts.iter().position(|&k| k == key) {
            Some(i) => {
                w.u8(1);
                w.u64(i as u64)
            }
            None => {
                w.dicts.push(key);
                w.u8(0);
                w.v_u8(&self.dict.bytes)
            }
        }
        w.v_u8(&self.data);
        w.v_u32(&self.offs);
        w.v_u32(&self.first);
        w.v_u32(&self.raw_lens)
    }
    pub fn read(r: &mut R) -> Res<ZBlocks> {
        let n = r.get_u64()? as usize;
        let dict = match r.get_u8()? {
            0 => {
                let Some(d) = Dict::new(r.get_v_u8()?.to_vec()) else {
                    return bad("text dictionary");
                };
                r.dicts.push(d.clone());
                d
            }
            1 => {
                let i = r.get_u64()? as usize;
                match r.dicts.get(i).cloned().map(Arc::downcast::<Dict>) {
                    Some(Ok(d)) => d,
                    _ => return bad("text dictionary reference"),
                }
            }
            _ => return bad("text dictionary kind"),
        };
        let (data, offs, first, raw_lens) = (
            r.get_v_u8()?,
            r.get_v_u32()?,
            r.get_v_u32()?,
            r.get_v_u32()?,
        );
        let nb = raw_lens.len();
        let sorted = |v: &[u32]| v.windows(2).all(|p| p[0] <= p[1]);
        if offs.len() != nb + 1
            || first.len() != nb + 1
            || nb == 0
            || offs[0] != 0
            || first[0] != 0
            || !sorted(&offs)
            || !first.windows(2).all(|p| p[0] < p[1])
            || offs[nb] as usize != data.len()
            || first[nb] as usize != n
            || raw_lens.iter().any(|&l| l as usize > MAX_BLOCK_RAW)
        {
            return bad("text blocks");
        }
        Ok(ZBlocks {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            n,
            dict,
            data,
            offs,
            first,
            raw_lens,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_round_trip_through_blocks() {
        let words = [
            "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "é", "日本", "",
        ];
        let mut x = 12345u64;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as usize
        };
        let items: Vec<String> = (0..30_000)
            .map(|i| {
                if i % 97 == 0 {
                    String::new()
                } else {
                    (0..next() % 40)
                        .map(|_| words[next() % words.len()])
                        .collect::<Vec<_>>()
                        .join(" ")
                }
            })
            .collect();
        let refs: Vec<&str> = items.iter().map(|s| s.as_str()).collect();
        let z = ZBlocks::build(&refs).expect("enough text to train on");
        let raw: usize = items.iter().map(|s| s.len()).sum();
        assert!(z.bytes() * 2 < raw, "{} of {raw}", z.bytes());
        let mut buf = Vec::new();
        for i in (0..items.len()).chain((0..items.len()).rev().step_by(131)) {
            assert_eq!(z.get(i, &mut buf), items[i].as_bytes(), "value {i}")
        }
        let mut w = W::counting();
        z.write(&mut w);
        let mut bytes = vec![0u8; w.written()];
        z.write(&mut W::into(&mut bytes));
        let back = ZBlocks::read(&mut R::new(&bytes)).unwrap();
        for i in (0..items.len()).step_by(7) {
            assert_eq!(back.get(i, &mut buf), items[i].as_bytes())
        }
        assert!(ZBlocks::read(&mut R::new(&bytes[..bytes.len() / 2])).is_err());
        assert!(
            ZBlocks::build(&["a", "b"]).is_none(),
            "nothing to train a dictionary on"
        );
    }
}
