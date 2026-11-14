//! Stand-in for `ztext` in builds without Zstandard (WebAssembly, and anything built without the `ztext` feature).
//! Text is never compressed that way here, and a file that was is refused with an explanation.
use crate::wire::{R, Res, W};

/// Never constructed in this build.
pub enum ZBlocks {}

pub fn release() {}

impl ZBlocks {
    pub fn build(_items: &[&str]) -> Option<ZBlocks> {
        None
    }
    pub fn len(&self) -> usize {
        match *self {}
    }
    pub fn bytes(&self) -> usize {
        match *self {}
    }
    pub fn get<'a>(&self, _i: usize, _buf: &'a mut Vec<u8>) -> &'a [u8] {
        match *self {}
    }
    pub fn write(&self, _w: &mut W) {
        match *self {}
    }
    pub fn read(_r: &mut R) -> Res<ZBlocks> {
        Err("this table has text compressed with Zstandard (hint \"compact\"), which this build of packmem does not include".into())
    }
}
