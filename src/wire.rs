//! Byte-level reader and writer for saving packed tables as they are, without re-encoding.
//! Single integers (counts, lengths, chunk metadata) are LEB128 varints, signed ones zigzagged; a small table is mostly
//! such headers, and fixed 8-byte fields made it larger than JSON after compression. Vectors and floats are
//! little-endian at full width, and each vector's data is padded to its element size, counted from the start of the
//! output, so that a reader holding the bytes in aligned memory (a mapped file) can use the vector in place instead of
//! copying it. Formats before 4 wrote every integer at full width; `R::fixed` reads those.
use crate::buf::{Backing, Buf};
use std::sync::Arc;

pub type Res<T> = Result<T, String>;

/// Writes into a caller-provided buffer, or only counts bytes when given none. Serialising is two passes (count, then
/// write into a buffer of exactly that size), so no growing vector and no second copy is left behind.
pub struct W<'a> {
    out: Option<&'a mut [u8]>,
    /// When set, bytes go to this sink instead (a file); the first error is kept and later writes are skipped.
    sink: Option<&'a mut dyn FnMut(&[u8]) -> std::io::Result<()>>,
    err: Option<std::io::Error>,
    n: usize,
    /// Identities of the text dictionaries written so far; a repeat is written as its position here.
    pub dicts: Vec<usize>,
}

impl<'a> W<'a> {
    pub fn counting() -> Self {
        W {
            out: None,
            sink: None,
            err: None,
            n: 0,
            dicts: Vec::new(),
        }
    }
    pub fn into(out: &'a mut [u8]) -> Self {
        W {
            out: Some(out),
            sink: None,
            err: None,
            n: 0,
            dicts: Vec::new(),
        }
    }
    pub fn to_sink(sink: &'a mut dyn FnMut(&[u8]) -> std::io::Result<()>) -> Self {
        W {
            out: None,
            sink: Some(sink),
            err: None,
            n: 0,
            dicts: Vec::new(),
        }
    }
    pub fn finish(self) -> std::io::Result<usize> {
        match self.err {
            Some(e) => Err(e),
            None => Ok(self.n),
        }
    }
    /// Bytes written (or counted) so far.
    pub fn written(&self) -> usize {
        self.n
    }
    /// Zero padding up to the next multiple of `n` bytes from the start of the output.
    fn align(&mut self, n: usize) {
        let pad = (n - self.n % n) % n;
        if pad > 0 {
            self.raw(&[0u8; 8][..pad])
        }
    }
    #[inline]
    pub fn raw(&mut self, b: &[u8]) {
        if let Some(out) = &mut self.out {
            out[self.n..self.n + b.len()].copy_from_slice(b)
        } else if let Some(sink) = &mut self.sink {
            if self.err.is_none() {
                self.err = sink(b).err()
            }
        }
        self.n += b.len()
    }
}

pub struct R<'a> {
    b: &'a [u8],
    p: usize,
    /// The shared block `b` belongs to, when vectors may be borrowed from it rather than copied.
    owner: Option<&'a Arc<dyn Backing>>,
    /// The text dictionaries read so far, for the repeats that refer back to them.
    pub dicts: Vec<Arc<dyn std::any::Any + Send + Sync>>,
    /// Single integers are at full width (formats before 4), not varints.
    pub fixed: bool,
}

/// How a single integer is written: as a varint, or (u8, f64) as it is.
pub trait Scalar: Sized {
    const VAR: bool;
    fn to_var(self) -> u64;
    fn from_var(v: u64) -> Option<Self>;
}
macro_rules! unsigned {
    ($($t:ty),*) => {$(
        impl Scalar for $t {
            const VAR: bool = true;
            fn to_var(self) -> u64 {
                self as u64
            }
            fn from_var(v: u64) -> Option<Self> {
                <$t>::try_from(v).ok()
            }
        }
    )*};
}
unsigned!(u16, u32, u64);
impl Scalar for i64 {
    const VAR: bool = true;
    fn to_var(self) -> u64 {
        ((self << 1) ^ (self >> 63)) as u64
    }
    fn from_var(v: u64) -> Option<Self> {
        Some(((v >> 1) as i64) ^ -((v & 1) as i64))
    }
}
macro_rules! as_is {
    ($($t:ty),*) => {$(
        impl Scalar for $t {
            const VAR: bool = false;
            fn to_var(self) -> u64 {
                unreachable!()
            }
            fn from_var(_: u64) -> Option<Self> {
                unreachable!()
            }
        }
    )*};
}
as_is!(u8, f64);

macro_rules! num {
    ($put:ident, $get:ident, $putv:ident, $getv:ident, $t:ty) => {
        impl W<'_> {
            pub fn $put(&mut self, v: $t) {
                if <$t as Scalar>::VAR {
                    self.varint(v.to_var())
                } else {
                    self.raw(&v.to_le_bytes())
                }
            }
            pub fn $putv(&mut self, v: &[$t]) {
                const N: usize = std::mem::size_of::<$t>();
                self.u64(v.len() as u64);
                self.align(N);
                let size = std::mem::size_of_val(v);
                if let Some(out) = &mut self.out {
                    for (d, x) in out[self.n..self.n + size].chunks_exact_mut(N).zip(v) {
                        d.copy_from_slice(&x.to_le_bytes())
                    }
                } else if self.sink.is_some() {
                    // through a fixed stack buffer, so a large column never needs a second copy in memory
                    let mut buf = [0u8; 4096];
                    let start = self.n;
                    for block in v.chunks(4096 / N) {
                        for (d, x) in buf.chunks_exact_mut(N).zip(block) {
                            d.copy_from_slice(&x.to_le_bytes())
                        }
                        self.raw(&buf[..block.len() * N]);
                    }
                    self.n = start;
                }
                self.n += size
            }
        }
        impl R<'_> {
            pub fn $get(&mut self) -> Res<$t> {
                const N: usize = std::mem::size_of::<$t>();
                if <$t as Scalar>::VAR && !self.fixed {
                    return <$t>::from_var(self.varint()?).ok_or_else(|| {
                        "packed table data is corrupt (integer out of range)".into()
                    });
                }
                Ok(<$t>::from_le_bytes(self.take(N)?.try_into().unwrap()))
            }
            /// A vector, borrowed in place when the reader has an owner for its bytes, copied otherwise.
            pub fn $getv(&mut self) -> Res<Buf<$t>> {
                const N: usize = std::mem::size_of::<$t>();
                let n = self.len(N)?;
                self.skip_to(N)?;
                if let Some(owner) = self.owner {
                    let buf = Buf::borrowed(owner, self.p, n)?;
                    self.take(n * N)?;
                    return Ok(buf);
                }
                Ok(self
                    .take(n * N)?
                    .chunks_exact(N)
                    .map(|c| <$t>::from_le_bytes(c.try_into().unwrap()))
                    .collect())
            }
        }
    };
}
num!(u8, get_u8, v_u8, get_v_u8, u8);
num!(u16, get_u16, v_u16, get_v_u16, u16);
num!(u32, get_u32, v_u32, get_v_u32, u32);
num!(u64, get_u64, v_u64, get_v_u64, u64);
num!(i64, get_i64, v_i64, get_v_i64, i64);
num!(f64, get_f64, v_f64, get_v_f64, f64);

impl W<'_> {
    fn varint(&mut self, mut v: u64) {
        let mut b = [0u8; 10];
        let mut n = 0;
        loop {
            b[n] = (v & 0x7f) as u8;
            v >>= 7;
            n += 1;
            if v == 0 {
                break;
            }
            b[n - 1] |= 0x80;
        }
        self.raw(&b[..n])
    }
    /// A u64 at full width whatever the format: data that only looks like an integer (FSST symbols).
    pub fn u64_raw(&mut self, v: u64) {
        self.raw(&v.to_le_bytes())
    }
    pub fn bool(&mut self, v: bool) {
        self.u8(v as u8)
    }
    pub fn bytes(&mut self, v: &[u8]) {
        self.u64(v.len() as u64);
        self.raw(v)
    }
}

impl<'a> R<'a> {
    /// Reads by copying: `b` can live anywhere.
    pub fn new(b: &'a [u8]) -> Self {
        R {
            b,
            p: 0,
            owner: None,
            dicts: Vec::new(),
            fixed: false,
        }
    }
    /// Reads vectors in place from `owner`'s bytes, which they then keep alive.
    pub fn borrowing(owner: &'a Arc<dyn Backing>) -> Self {
        R {
            b: owner.bytes(),
            p: 0,
            owner: Some(owner),
            dicts: Vec::new(),
            fixed: false,
        }
    }
    fn varint(&mut self) -> Res<u64> {
        let mut v = 0u64;
        for i in 0..10 {
            let b = self.take(1)?[0];
            if i == 9 && b > 1 {
                break;
            }
            v |= ((b & 0x7f) as u64) << (7 * i);
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err("packed table data is corrupt (integer out of range)".into())
    }
    pub fn get_u64_raw(&mut self) -> Res<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    /// Skip the padding the writer put before a vector of `n`-byte elements.
    fn skip_to(&mut self, n: usize) -> Res<()> {
        let pad = (n - self.p % n) % n;
        self.take(pad).map(|_| ())
    }
    pub fn take(&mut self, n: usize) -> Res<&'a [u8]> {
        let end = self
            .p
            .checked_add(n)
            .filter(|&e| e <= self.b.len())
            .ok_or("packed table data is truncated")?;
        let s = &self.b[self.p..end];
        self.p = end;
        Ok(s)
    }
    /// A length prefix for items of `size` bytes, checked against what is left so a bad length cannot trigger a huge allocation.
    pub fn len(&mut self, size: usize) -> Res<usize> {
        let n = self.get_u64()? as usize;
        if n.checked_mul(size.max(1))
            .is_none_or(|b| b > self.b.len() - self.p)
        {
            return Err("packed table data is corrupt (length out of range)".into());
        }
        Ok(n)
    }
    pub fn get_bool(&mut self) -> Res<bool> {
        Ok(self.get_u8()? != 0)
    }
    pub fn get_bytes(&mut self) -> Res<&'a [u8]> {
        let n = self.len(1)?;
        self.take(n)
    }
    pub fn get_string(&mut self) -> Res<String> {
        String::from_utf8(self.get_bytes()?.to_vec())
            .map_err(|_| "packed table data is corrupt (text is not UTF-8)".to_string())
    }
    pub fn done(&self) -> bool {
        self.p == self.b.len()
    }
}

pub fn bad<T>(what: &str) -> Res<T> {
    Err(format!("packed table data is corrupt ({what})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(f: impl Fn(&mut W)) -> Vec<u8> {
        let mut c = W::counting();
        f(&mut c);
        let mut out = vec![0u8; c.written()];
        f(&mut W::into(&mut out));
        out
    }

    #[test]
    fn integers_round_trip_as_varints() {
        let u = [0, 1, 127, 128, 300, u32::MAX as u64, u64::MAX];
        let i = [0, -1, 1, -64, 64, i64::MIN, i64::MAX];
        let b = write(|w| {
            u.iter().for_each(|&v| w.u64(v));
            i.iter().for_each(|&v| w.i64(v));
            w.u16(u16::MAX);
            w.u32(7);
            w.u64_raw(5);
        });
        assert_eq!(&b[..3], &[0, 1, 127], "small values take one byte");
        let mut r = R::new(&b);
        assert_eq!(u.map(|_| r.get_u64().unwrap()), u);
        assert_eq!(i.map(|_| r.get_i64().unwrap()), i);
        assert_eq!((r.get_u16().unwrap(), r.get_u32().unwrap()), (u16::MAX, 7));
        assert_eq!(r.take(8).unwrap(), &5u64.to_le_bytes());
        assert!(r.done());
    }

    #[test]
    fn bad_varints_are_refused() {
        let too_long = [0xffu8; 11];
        assert!(R::new(&too_long).get_u64().is_err());
        assert!(R::new(&[0x80, 0x80]).get_u64().is_err(), "truncated");
        let big = write(|w| w.u64(1 << 20));
        assert!(R::new(&big).get_u16().is_err(), "out of range for the type");
    }

    #[test]
    fn vectors_stay_aligned_from_the_start_of_the_output() {
        let b = write(|w| {
            w.u8(1);
            w.v_u64(&[9, 10]);
        });
        let p = b.len() - 16;
        assert_eq!(p % 8, 0);
        assert_eq!(R::new(&b).get_u8().unwrap(), 1);
        let mut r = R::new(&b);
        r.get_u8().unwrap();
        assert_eq!(r.get_v_u64().unwrap().to_vec(), vec![9, 10]);
    }

    #[test]
    fn fixed_readers_read_full_width_integers() {
        let b = [7u64.to_le_bytes(), (-2i64).to_le_bytes()].concat();
        let mut r = R::new(&b);
        r.fixed = true;
        assert_eq!((r.get_u64().unwrap(), r.get_i64().unwrap()), (7, -2));
    }
}
