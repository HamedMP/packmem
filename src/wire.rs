//! Byte-level reader and writer for saving packed tables as they are, without re-encoding.
//! Integers are little-endian; vectors and byte strings carry a 64-bit length prefix.

pub type Res<T> = Result<T, String>;

/// Writes into a caller-provided buffer, or only counts bytes when given none. Serialising is two passes (count, then
/// write into a buffer of exactly that size), so no growing vector and no second copy is left behind.
pub struct W<'a> {
    out: Option<&'a mut [u8]>,
    n: usize,
}

impl<'a> W<'a> {
    pub fn counting() -> Self {
        W { out: None, n: 0 }
    }
    pub fn into(out: &'a mut [u8]) -> Self {
        W {
            out: Some(out),
            n: 0,
        }
    }
    /// Bytes written (or counted) so far.
    pub fn written(&self) -> usize {
        self.n
    }
    #[inline]
    pub fn raw(&mut self, b: &[u8]) {
        if let Some(out) = &mut self.out {
            out[self.n..self.n + b.len()].copy_from_slice(b)
        }
        self.n += b.len()
    }
}

pub struct R<'a> {
    b: &'a [u8],
    p: usize,
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
                let size = std::mem::size_of_val(v);
                if let Some(out) = &mut self.out {
                    for (d, x) in out[self.n..self.n + size].chunks_exact_mut(N).zip(v) {
                        d.copy_from_slice(&x.to_le_bytes())
                    }
                }
                self.n += size
            }
        }
        impl R<'_> {
            pub fn $get(&mut self) -> Res<$t> {
                const N: usize = std::mem::size_of::<$t>();
                Ok(<$t>::from_le_bytes(self.take(N)?.try_into().unwrap()))
            }
            pub fn $getv(&mut self) -> Res<Vec<$t>> {
                const N: usize = std::mem::size_of::<$t>();
                let n = self.len(N)?;
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
    pub fn new(b: &'a [u8]) -> Self {
        R { b, p: 0 }
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
