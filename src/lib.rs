//! packmem: adaptive, operation-aware in-memory encodings that are processed without decompression.
pub mod dynamic;
pub mod ints;
pub mod strs;
pub mod table;
pub use dynamic::{Cell, DynTable, Num, Pred};
pub use ints::{Hint, PackedInts};
pub use strs::PackedStrs;
pub use table::{Column, Table};
