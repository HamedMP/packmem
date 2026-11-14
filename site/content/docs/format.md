# Byte format

`to_bytes()` in Python, `toBytes()` in Node and WebAssembly, `save()` and `share()` in Python and
`DynTable::to_bytes` in Rust all write the same form: the packed columns as they are in memory, so reading them
back copies or maps them and re-encodes nothing. Any binding reads what any other wrote, subject to the version rule
below.

## Versions

The bytes start with `PKMT` and a format version.

| packmem | Writes | Reads |
| --- | --- | --- |
| 0.2.0 | `PKM2` (format 2) | format 2 |
| 0.3.0 | format 4 | formats 2, 3 and 4 |
| 0.3.1 | format 5 | formats 2 to 5 |

Format 3 was only written by development builds between 0.2.0 and 0.3.0. Format 5 stores no per-row offsets for
columns of records that are never absent, which 0.3.0 did. A reader refuses bytes from a newer format with an error
that says so:

```text
written by a newer packmem (format 5, this build reads up to 4): upgrade packmem to read it
```

Anything else that is not a table fails with "not packed table data, or written by packmem 0.1".

## The rule for servers and clients

**A reader must be the same version as the writer, or newer.** Pin the same packmem version on both sides. When
the two are deployed separately, upgrade the reader first: the browser bundle, the worker that opens saved files,
the service that receives bytes. So far every release reads the formats of the releases before it, so files saved
with `save()` keep opening after an upgrade.

Over HTTP, [`packmem/http`](/docs/http/) negotiates per request: clients that do not ask for bytes get JSON, and
from 0.3.1 `fetchTable` asks again for JSON when the server's bytes are from a newer packmem than the client's.
`fetchTable` in 0.3.0 does not, and throws instead.

## What is inside

- A header: `PKMT`, the format version, the table's hint, the row count and the column count.
- For each column, its name and its chunks of 16,384 rows. Each chunk holds its encoded values (packed integers,
  dictionaries, FSST-compressed strings, sub-columns for lists of records), null and missing bitmaps, and any
  patched cells.
- Since format 4, single integers in the headers (counts, lengths, chunk metadata) are variable-length (LEB128,
  signed ones zigzagged). Vectors and floats are at full width and padded to their element size from the start of
  the bytes, so a memory-mapped file is read in place without copying.

The exact layout is defined by the code in [src/wire.rs](https://github.com/HamedMP/packmem/blob/main/src/wire.rs)
and [src/dynamic.rs](https://github.com/HamedMP/packmem/blob/main/src/dynamic.rs). It is not a stable interchange
format like Arrow or Parquet; for exchange with other tools, use `to_arrow()` and `to_parquet()` in Python, or
JSON.

## Limits

- Tables written with Python's `hint="compact"` hold Zstandard-compressed text, which the WebAssembly build cannot
  read.
- After compression (gzip, Brotli), the bytes of a table of a few dozen rows, or of text-heavy rows, are about as
  large as JSON or larger. Send JSON for those.
