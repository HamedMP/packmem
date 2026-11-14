"""Copy the packmem core (../../src, ../../Cargo.toml) into build/core and add byte accounting to its writer.

Nothing in the repository's own source changes. The copy writes the same bytes as the original unless a variant is
switched on (probe::MODE), and that is checked: with MODE=0 the probe must write the same bytes as the Node addon
built from the unmodified source (check.mjs).
"""
import pathlib, re, shutil, sys

here = pathlib.Path(__file__).resolve().parent
root = here.parent.parent
dst = here / "build" / "core"
if dst.exists():
    shutil.rmtree(dst)
shutil.copytree(root / "src", dst / "src")
toml = (root / "Cargo.toml").read_text()
toml = re.sub(r"\n\[\[bin\]\][\s\S]*?(?=\n\[|\Z)", "\n", toml)  # the comparison benchmark binary is not needed
toml = toml.replace('name = "packmem"', 'name = "packmem"\nautobins = false', 1)
(dst / "Cargo.toml").write_text(toml)
shutil.rmtree(dst / "src" / "bin", ignore_errors=True)


def edit(path, old, new, count=1):
    p = dst / "src" / path
    s = p.read_text()
    n = s.count(old)
    if n != count:
        sys.exit(f"{path}: expected {count} of {old!r}, found {n}")
    p.write_text(s.replace(old, new))


PROBE = r'''
/// Byte accounting for benchmarks/wire-size (not part of the library).
pub mod probe {
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;
    thread_local! {
        static CTX: RefCell<Vec<&'static str>> = RefCell::new(vec!["other"]);
        static KIND: RefCell<Vec<&'static str>> = RefCell::new(vec!["raw"]);
        pub static COUNTS: RefCell<BTreeMap<(String, String), usize>> = RefCell::new(BTreeMap::new());
        pub static MODE: Cell<u32> = Cell::new(0);
    }
    /// No alignment padding before vectors.
    pub const NOPAD: u32 = 1;
    /// Header integers (counts, lengths, chunk metadata) as LEB128 varints, signed ones zigzagged.
    pub const VARHDR: u32 = 2;
    /// String and list offsets as varint lengths (differences of consecutive offsets).
    pub const LENOFFS: u32 = 4;
    /// Only the FSST symbols in use (n_symbols), not all 255 slots.
    pub const FSSTN: u32 = 8;
    pub struct G(bool);
    impl Drop for G {
        fn drop(&mut self) {
            if self.0 { KIND.with(|k| k.borrow_mut().pop()); } else { CTX.with(|c| c.borrow_mut().pop()); }
        }
    }
    pub fn ctx(s: &'static str) -> G { CTX.with(|c| c.borrow_mut().push(s)); G(false) }
    pub fn kind(s: &'static str) -> G { KIND.with(|c| c.borrow_mut().push(s)); G(true) }
    /// A scalar's kind, unless an enclosing call already said what it is (a vector's length prefix).
    pub fn scalar() -> G {
        let top = KIND.with(|k| *k.borrow().last().unwrap());
        kind(if top == "raw" { "scalar" } else { top })
    }
    pub fn top_ctx() -> &'static str { CTX.with(|c| *c.borrow().last().unwrap()) }
    pub fn on(f: u32) -> bool { MODE.with(|m| m.get() & f != 0) }
    pub fn add(n: usize) {
        let c = top_ctx();
        let k = KIND.with(|k| *k.borrow().last().unwrap());
        COUNTS.with(|m| *m.borrow_mut().entry((c.to_string(), k.to_string())).or_default() += n);
    }
    pub fn leb(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 { out.push(b); return; }
            out.push(b | 0x80);
        }
    }
}
use probe::{FSSTN, LENOFFS, NOPAD, VARHDR};
'''

edit("wire.rs", "pub type Res<T> = Result<T, String>;\n", "pub type Res<T> = Result<T, String>;\n" + PROBE)
# padding
edit("wire.rs", """    fn align(&mut self, n: usize) {
        let pad = (n - self.n % n) % n;""", """    fn align(&mut self, n: usize) {
        if probe::on(NOPAD) {
            return;
        }
        let _k = probe::kind("pad");
        let pad = (n - self.n % n) % n;""")
edit("wire.rs", """    pub fn raw(&mut self, b: &[u8]) {
""", """    pub fn raw(&mut self, b: &[u8]) {
        probe::add(b.len());
""")
# scalars: varints under VARHDR (not for FSST symbols, which are 8 bytes of data, nor f64)
edit("wire.rs", """            pub fn $put(&mut self, v: $t) {
                self.raw(&v.to_le_bytes())
            }""", """            pub fn $put(&mut self, v: $t) {
                let _k = probe::scalar();
                let size = std::mem::size_of::<$t>();
                if probe::on(VARHDR) && size > 1 && stringify!($t) != "f64" && probe::top_ctx() != "str.fsst_table" {
                    let mut b = Vec::new();
                    let x = v as i128;
                    let z = if stringify!($t) == "i64" { ((x << 1) ^ (x >> 127)) as u64 } else { x as u64 };
                    probe::leb(z, &mut b);
                    return self.raw(&b);
                }
                self.raw(&v.to_le_bytes())
            }""")
edit("wire.rs", """                const N: usize = std::mem::size_of::<$t>();
                self.u64(v.len() as u64);
                self.align(N);""", """                const N: usize = std::mem::size_of::<$t>();
                {
                    let _k = probe::kind("len");
                    self.u64(v.len() as u64);
                }
                self.align(N);
                let _k = probe::kind("data");""")
edit("wire.rs", """                let size = std::mem::size_of_val(v);
                if let Some(out) = &mut self.out {""", """                let size = std::mem::size_of_val(v);
                if self.sink.is_none() {
                    probe::add(size);
                }
                if let Some(out) = &mut self.out {""")
edit("wire.rs", """    pub fn bytes(&mut self, v: &[u8]) {
        self.u64(v.len() as u64);
        self.raw(v)
    }""", """    pub fn bytes(&mut self, v: &[u8]) {
        {
            let _k = probe::kind("len");
            self.u64(v.len() as u64);
        }
        let _k = probe::kind("data");
        self.raw(v)
    }
    /// Monotonic offsets (strings, lists): as they are, or under LENOFFS as a count and varint lengths.
    pub fn offsets(&mut self, v: &[u32]) {
        if !probe::on(LENOFFS) {
            return self.v_u32(v);
        }
        {
            let _k = probe::kind("len");
            self.u64(v.len() as u64);
        }
        let _k = probe::kind("data");
        let mut b = Vec::new();
        let mut prev = 0u32;
        for &o in v {
            probe::leb((o - prev) as u64, &mut b);
            prev = o;
        }
        self.raw(&b)
    }
    pub fn fsst_used(&self) -> bool {
        probe::on(FSSTN)
    }""")

# contexts: the table header and column names
edit("dynamic.rs", """    fn write(&self, w: &mut W) {
        w.raw(MAGIC);""", """    fn write(&self, w: &mut W) {
        let _c = crate::wire::probe::ctx("table.header");
        w.raw(MAGIC);""")
edit("dynamic.rs", """        for (name, c) in self.names.iter().zip(&self.cols) {
            w.bytes(name.as_bytes());
            for ch in c.sealed() {""", """        for (name, c) in self.names.iter().zip(&self.cols) {
            {
                let _c = crate::wire::probe::ctx("col.name");
                w.bytes(name.as_bytes());
            }
            for ch in c.sealed() {""")
# chunk metadata, with the data inside each arm labelled
edit("dynamic.rs", """impl Chunk {
    fn write(&self, w: &mut W) {
        match &self.data {""", """impl Chunk {
    fn write(&self, w: &mut W) {
        let _c = crate::wire::probe::ctx("chunk.meta");
        match &self.data {""")
edit("dynamic.rs", """                w.bool(*is_bool);
                p.write(w)""", """                w.bool(*is_bool);
                let _c = crate::wire::probe::ctx("ints");
                p.write(w)""")
edit("dynamic.rs", """                w.u8(*scale);
                p.write(w)""", """                w.u8(*scale);
                let _c = crate::wire::probe::ctx("decimals");
                p.write(w)""")
edit("dynamic.rs", """                w.u8(3);
                w.v_f64(v)""", """                w.u8(3);
                let _c = crate::wire::probe::ctx("floats");
                w.v_f64(v)""")
edit("dynamic.rs", """            Data::Mixed(p) => {
                w.u8(5);
                p.write(w)""", """            Data::Mixed(p) => {
                w.u8(5);
                let _c = crate::wire::probe::ctx("mixed");
                p.write(w)""")
edit("dynamic.rs", """fn write_bits(w: &mut W, b: &Option<Bits>) {
""", """fn write_bits(w: &mut W, b: &Option<Bits>) {
    let _c = crate::wire::probe::ctx("bitmaps");
""")
edit("dynamic.rs", """        for (i, c) in &self.patches {""", """        let _c = crate::wire::probe::ctx("patches");
        for (i, c) in &self.patches {""")
# lists of records
edit("dynamic.rs", """    fn write(&self, w: &mut W) {
        w.bool(self.is_record);
        w.v_u32(&self.offs);
        w.u64(self.shapes.len() as u64);
        for s in &self.shapes {
            w.v_u16(s)
        }
        self.shape_of.write(w);
        w.u64(self.names.len() as u64);
        for (name, col) in self.names.iter().zip(&self.cols) {
            w.bytes(name.as_bytes());
            col.write(w)
        }
    }""", """    fn write(&self, w: &mut W) {
        use crate::wire::probe::ctx;
        let _c = ctx("list.meta");
        w.bool(self.is_record);
        {
            let _c = ctx("list.offsets");
            w.offsets(&self.offs);
        }
        {
            let _c = ctx("list.shapes");
            w.u64(self.shapes.len() as u64);
            for s in &self.shapes {
                w.v_u16(s)
            }
            self.shape_of.write(w);
        }
        w.u64(self.names.len() as u64);
        for (name, col) in self.names.iter().zip(&self.cols) {
            {
                let _c = ctx("list.field_name");
                w.bytes(name.as_bytes());
            }
            col.write(w)
        }
    }""")
# strings
edit("strs.rs", """    fn write(&self, w: &mut W) {
        w.v_u8(&self.bytes);
        w.v_u32(&self.offs);
        w.u64(self.raw_bytes as u64);""", """    fn write(&self, w: &mut W) {
        use crate::wire::probe::ctx;
        {
            let _c = ctx("str.bytes");
            w.v_u8(&self.bytes);
        }
        {
            let _c = ctx("str.offsets");
            w.offsets(&self.offs);
        }
        let _c = ctx("str.meta");
        w.u64(self.raw_bytes as u64);""")
edit("strs.rs", """                w.u8(1);
                w.u8(p.n_symbols);
                for s in &p.symbols {
                    w.u64(s.to_u64())
                }
                w.raw(&p.lengths)""", """                w.u8(1);
                w.u8(p.n_symbols);
                let _c = ctx("str.fsst_table");
                let n = if w.fsst_used() { p.n_symbols as usize } else { 255 };
                for s in &p.symbols[..n] {
                    w.u64(s.to_u64())
                }
                w.raw(&p.lengths[..n])""")
edit("strs.rs", """                w.u8(0);
                pool.write(w);
                codes.write(w);""", """                w.u8(0);
                pool.write(w);
                let _c = crate::wire::probe::ctx("str.codes");
                codes.write(w);""")
shutil.copy(root / "node" / "src" / "load.rs", here / "probe" / "src" / "load.rs")
print("instrumented copy in", dst)
