//! Byte-level reader and writer for saving packed tables as they are, without re-encoding.
//! Integers are little-endian; vectors and byte strings carry a 64-bit length prefix. Each vector's data is padded
//! to its element size, so that a reader holding the bytes in aligned memory (a mapped file) can use the vector in
//! place instead of copying it.
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
}

impl<'a> W<'a> {
    pub fn counting() -> Self {
        W {
            out: None,
            sink: None,
            err: None,
            n: 0,
        }
    }
    pub fn into(out: &'a mut [u8]) -> Self {
        W {
            out: Some(out),
            sink: None,
            err: None,
            n: 0,
        }
    }
    pub fn to_sink(sink: &'a mut dyn FnMut(&[u8]) -> std::io::Result<()>) -> Self {
        W {
            out: None,
            sink: Some(sink),
            err: None,
            n: 0,
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
}

macro_rules! num {
    ($put:ident, $get:ident, $putv:ident, $getv:ident, $t:ty) => {
        impl W<'_> {
            pub fn $put(&mut self, v: $t) {
                self.raw(&v.to_le_bytes())
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
        }
    }
    /// Reads vectors in place from `owner`'s bytes, which they then keep alive.
    pub fn borrowing(owner: &'a Arc<dyn Backing>) -> Self {
        R {
            b: owner.bytes(),
            p: 0,
            owner: Some(owner),
        }
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
