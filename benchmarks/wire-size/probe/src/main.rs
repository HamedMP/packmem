//! Byte accounting for one dataset: for each table size and each writer variant, the bytes per section.
//! usage: probe <records.jsonl> <dataset name> <out dir> <size,size,...>
//! Prints one JSON line per (size, mode); writes each table's bytes to <out>/<dataset>-<size>-<mode>.pkm.
mod load;
use packmem::wire::probe::{COUNTS, FSSTN, LENOFFS, MODE, NOPAD, VARHDR};
use packmem::{DynTable, Hint};
use std::collections::BTreeMap;

const MODES: [(&str, u32); 7] = [
    ("as_is", 0),
    ("fsst_used", FSSTN),
    ("varint_lengths", LENOFFS),
    ("no_padding", NOPAD),
    ("varint_headers", VARHDR),
    ("all_but_fsst", LENOFFS | NOPAD | VARHDR),
    ("all", FSSTN | LENOFFS | NOPAD | VARHDR),
];

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let text = std::fs::read_to_string(&a[1]).unwrap();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let (name, out) = (&a[2], std::path::Path::new(&a[3]));
    for n in a[4].split(',').map(|s| s.parse::<usize>().unwrap()) {
        if n > lines.len() {
            continue;
        }
        let input = lines[..n].join("\n");
        let mut t = DynTable::new(Hint::Balanced);
        t.set_bulk(true);
        load::push_lines(&mut t, &input).unwrap();
        t.set_bulk(false);
        for (mode_name, mode) in MODES {
            MODE.with(|m| m.set(mode));
            let len = t.byte_len();
            COUNTS.with(|c| c.borrow_mut().clear());
            let mut buf = vec![0u8; len];
            t.write_bytes(&mut buf);
            let counts: BTreeMap<String, usize> =
                COUNTS.with(|c| c.borrow().iter().map(|((ctx, kind), v)| (format!("{ctx}/{kind}"), *v)).collect());
            let sum: usize = counts.values().sum();
            assert_eq!(sum, len, "{name} {n} {mode_name}: accounted {sum} of {len} bytes");
            std::fs::write(out.join(format!("{name}-{n}-{mode_name}.pkm")), &buf).unwrap();
            println!(
                "{}",
                serde_json::json!({"dataset": name, "rows": n, "mode": mode_name, "bytes": len, "sections": counts})
            );
        }
    }
}
