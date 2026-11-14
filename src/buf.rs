//! A read-only array that either owns its values or borrows them from a shared block of bytes, such as a
//! memory-mapped file. Packed columns hold their data in these, so a table can be opened without copying it.
use std::ops::Deref;
use std::sync::Arc;

/// Bytes that outlive every `Buf` borrowing from them: a memory-mapped file, in practice.
pub trait Backing: Send + Sync {
    fn bytes(&self) -> &[u8];
}
impl Backing for Vec<u8> {
    fn bytes(&self) -> &[u8] {
        self
    }
}

mod sealed {
    pub trait Sealed {}
}
/// Plain numeric types whose in-memory form is their little-endian byte form.
///
/// # Safety
/// Implemented only for integer and float types: every bit pattern is a valid value and there is no padding.
pub unsafe trait Pod: sealed::Sealed + Copy + Send + Sync + 'static {}
macro_rules! pod {
    ($($t:ty),*) => {$(
        impl sealed::Sealed for $t {}
        unsafe impl Pod for $t {}
    )*};
}
pod!(u8, u16, u32, u64, i64, f64);

enum Inner<T: Pod> {
    Owned(Vec<T>),
    Borrowed {
        /// Keeps the bytes alive; `ptr` points into them.
        _owner: Arc<dyn Backing>,
        ptr: *const T,
        len: usize,
    },
}

pub struct Buf<T: Pod>(Inner<T>);

// SAFETY: a borrowed buffer is read-only and its owner is `Send + Sync`; an owned one is a `Vec<T>` of `Send + Sync` values.
unsafe impl<T: Pod> Send for Buf<T> {}
unsafe impl<T: Pod> Sync for Buf<T> {}

impl<T: Pod> Buf<T> {
    /// `len` values starting `offset` bytes into `owner`, read in place.
    ///
    /// Fails if the range is out of bounds or not aligned for `T`, or on a big-endian machine, where the stored
    /// little-endian values could not be read in place.
    pub fn borrowed(owner: &Arc<dyn Backing>, offset: usize, len: usize) -> Result<Self, String> {
        if cfg!(target_endian = "big") {
            return Err(
                "packed tables can only be opened in place on little-endian machines".into(),
            );
        }
        let bytes = owner.bytes();
        let size = len
            .checked_mul(std::mem::size_of::<T>())
            .ok_or("packed table data is corrupt (length out of range)")?;
        let end = offset
            .checked_add(size)
            .ok_or("packed table data is corrupt (length out of range)")?;
        if end > bytes.len() {
            return Err("packed table data is truncated".into());
        }
        let ptr = bytes[offset..].as_ptr();
        if (ptr as usize) % std::mem::align_of::<T>() != 0 {
            return Err("packed table data is corrupt (misaligned array)".into());
        }
        Ok(Buf(Inner::Borrowed {
            _owner: owner.clone(),
            ptr: ptr.cast(),
            len,
        }))
    }
    /// Bytes this buffer holds on the heap; zero when it borrows.
    pub fn heap_bytes(&self) -> usize {
        match &self.0 {
            Inner::Owned(v) => std::mem::size_of_val(v.as_slice()),
            Inner::Borrowed { .. } => 0,
        }
    }
}

impl<T: Pod> Deref for Buf<T> {
    type Target = [T];
    #[inline]
    fn deref(&self) -> &[T] {
        match &self.0 {
            Inner::Owned(v) => v,
            // SAFETY: `borrowed` checked that `ptr..ptr + len` lies inside the owner's bytes and is aligned for `T`;
            // the owner is kept alive by the `Arc` and never mutated; any bit pattern is a valid `T` (`Pod`).
            Inner::Borrowed { ptr, len, .. } => unsafe { std::slice::from_raw_parts(*ptr, *len) },
        }
    }
}

impl<'a, T: Pod> IntoIterator for &'a Buf<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl<T: Pod> From<Vec<T>> for Buf<T> {
    fn from(v: Vec<T>) -> Self {
        Buf(Inner::Owned(v))
    }
}

impl<T: Pod> FromIterator<T> for Buf<T> {
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
        Buf(Inner::Owned(iter.into_iter().collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn borrowed_reads_in_place_and_rejects_bad_ranges() {
        let mut data = vec![0u8; 80];
        // the allocation's own alignment is not guaranteed, so pick the first offset past 8 that is aligned for u32
        let start = 8 + (4 - (data.as_ptr() as usize + 8) % 4) % 4;
        for (i, v) in [7u32, 1 << 20, u32::MAX].iter().enumerate() {
            data[start + i * 4..start + i * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        let owner: Arc<dyn Backing> = Arc::new(data);
        let b = Buf::<u32>::borrowed(&owner, start, 3).unwrap();
        assert_eq!(&*b, &[7, 1 << 20, u32::MAX]);
        assert_eq!(b.heap_bytes(), 0);
        assert!(
            Buf::<u32>::borrowed(&owner, start + 1, 1).is_err(),
            "misaligned"
        );
        assert!(
            Buf::<u32>::borrowed(&owner, 76, 2).is_err(),
            "out of bounds"
        );
        assert!(
            Buf::<u64>::borrowed(&owner, 0, usize::MAX).is_err(),
            "overflow"
        );
        let owned: Buf<u16> = vec![1u16, 2, 3].into();
        assert_eq!((&*owned, owned.heap_bytes()), (&[1u16, 2, 3][..], 6));
    }
}
