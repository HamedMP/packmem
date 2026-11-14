# Rust

The `packmem` crate is the core the Python, Node and WebAssembly packages are built on: the encodings, the
sampling selector, the mutable record table and the operators on packed data.

```sh
cargo add packmem --no-default-features
```

| Feature | What it adds |
| --- | --- |
| `baselines` (default) | LZ4 and Zstandard, only for the repository's comparison benchmark. Turn it off. |
| `ztext` | `Hint::Compact`: long text compressed with Zstandard in small blocks. Native builds only (C code). |

## Packed columns

```rust
use packmem::{Hint, PackedInts, PackedStrs};

let latency = PackedInts::encode(&values, Hint::Balanced);   // values: &[i64]
latency.get(42);
latency.sum();
latency.count_range(1_000, 5_000);
latency.describe();                                           // the encoding chosen

let agents = PackedStrs::encode(&strings, Hint::Balanced);    // strings: &[impl AsRef<str>]
agents.count_where(|s| s.starts_with(b"curl"));
agents.count_eq("curl/8.0");
agents.get_string(7);
```

`Hint` is `Memory`, `Balanced`, `Speed` or `Compact` (as `Memory` without the `ztext` feature).

## The record table

`DynTable` is the table behind `packmem.Table` in Python and `Table` in Node: records of any shape, columns
created as keys appear, values as `Cell`s.

```rust
use packmem::{Cell, DynTable, Hint, Pred};

let mut t = DynTable::new(Hint::Balanced);
t.append([("carrier", Cell::Str("UA".into())), ("delay", Cell::Int(12))]);
t.append([("carrier", Cell::Str("B6".into())), ("delay", Cell::Int(-3))]);

let carrier = t.col_index("carrier").unwrap();
let delay = t.col_index("delay").unwrap();
let ua = t.select(carrier, &Pred::Eq(Cell::Str("UA".into())));   // row ids
let total = t.sum(delay, Some(&ua));                              // Num::Int or Num::Float
let by_carrier = t.group_count(carrier, None);                    // Vec<(Cell, usize)>
t.get(0, delay);                                                  // a Cell

let bytes = t.to_bytes();                                          // the byte form
let back = DynTable::from_bytes(&bytes)?;
```

`Pred` is `Eq(Cell)`, `Range { lo, hi, lo_incl, hi_incl }`, `Prefix(String)` or `Contains(String)`. `Cell` is
`Missing`, `Null`, `Bool`, `Int`, `Float`, `Str` or `Json` (nested values as JSON text).

The crate's API is lower level than the Python and Node packages and may change between minor versions. The
source of truth is [the crate on docs.rs](https://docs.rs/packmem) and the
[source](https://github.com/HamedMP/packmem/tree/main/src).
