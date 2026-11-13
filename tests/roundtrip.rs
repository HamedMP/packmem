use packmem::ints::{Scheme, stats};
use packmem::{Hint, PackedInts, PackedStrs};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn datasets() -> Vec<(&'static str, Vec<i64>)> {
    let mut r = Rng(0x9E3779B97F4A7C15);
    let n = 50_000;
    let mut sorted = vec![];
    let mut t = 1_700_000_000_000i64;
    for _ in 0..n {
        t += (r.next() % 50) as i64;
        sorted.push(t)
    }
    let mut runs = vec![];
    while runs.len() < n {
        let v = (r.next() % 20) as i64 - 5;
        for _ in 0..(1 + r.next() % 300) {
            runs.push(v)
        }
    }
    runs.truncate(n);
    vec![
        ("const", vec![7; n]),
        ("empty", vec![]),
        ("single", vec![-3]),
        ("small", (0..n).map(|_| (r.next() % 200) as i64).collect()),
        (
            "neg",
            (0..n)
                .map(|_| (r.next() % 100_000) as i64 - 50_000)
                .collect(),
        ),
        (
            "lowcard",
            (0..n)
                .map(|_| [200i64, 404, 500, 1 << 40, -9][(r.next() % 5) as usize])
                .collect(),
        ),
        ("wide", (0..n).map(|_| r.next() as i64).collect()),
        (
            "extremes",
            (0..n)
                .map(|i| if i % 2 == 0 { i64::MIN } else { i64::MAX })
                .collect(),
        ),
        ("sorted", sorted),
        ("runs", runs),
        (
            "outliers",
            (0..n)
                .map(|i| {
                    if i % 997 == 0 {
                        1 << 50
                    } else {
                        (r.next() % 16) as i64
                    }
                })
                .collect(),
        ),
    ]
}

#[test]
fn ints_match_plain_vec_for_every_scheme_and_hint() {
    for (name, v) in datasets() {
        let st = stats(&v);
        for hint in [Hint::Memory, Hint::Balanced, Hint::Speed] {
            let mut encs = vec![("auto", PackedInts::encode(&v, hint))];
            for s in [Scheme::For, Scheme::Dict, Scheme::Rle, Scheme::BlockFor] {
                if !v.is_empty() {
                    encs.push(("forced", PackedInts::encode_as(&v, s, hint, &st)))
                }
            }
            for (tag, p) in encs {
                let ctx = format!("{name}/{hint:?}/{tag}/{}", p.describe());
                assert_eq!(p.len(), v.len(), "{ctx}");
                assert_eq!(p.to_vec(), v, "{ctx}");
                assert_eq!(
                    p.sum(),
                    v.iter().fold(0i64, |a, &b| a.wrapping_add(b)),
                    "{ctx}"
                );
                let mut probes = vec![
                    (i64::MIN, i64::MAX),
                    (0, 0),
                    (5, 3),
                    (-10, 10),
                    (200, 404),
                    (i64::MIN, -1),
                    (1, i64::MAX),
                ];
                if !v.is_empty() {
                    let (a, b) = (v[v.len() / 3], v[2 * v.len() / 3]);
                    probes.push((a.min(b), a.max(b)));
                    probes.push((a, a));
                }
                for (lo, hi) in probes {
                    let want: Vec<u32> = v
                        .iter()
                        .enumerate()
                        .filter(|&(_, &x)| x >= lo && x <= hi)
                        .map(|(i, _)| i as u32)
                        .collect();
                    assert_eq!(p.count_range(lo, hi), want.len(), "{ctx} count [{lo},{hi}]");
                    if lo <= hi {
                        let mut got = vec![];
                        p.select_range(lo, hi, &mut got);
                        assert_eq!(got, want, "{ctx} select [{lo},{hi}]");
                    }
                }
            }
        }
    }
}

#[test]
fn strings_match_plain_vec() {
    let mut r = Rng(42);
    let low: Vec<String> = (0..30_000)
        .map(|_| format!("Mozilla/5.0 agent variant {}", r.next() % 12))
        .collect();
    let high: Vec<String> = (0..30_000)
        .map(|_| {
            format!(
                "/api/v1/items/{}?session={:x}",
                r.next() % 100_000,
                r.next()
            )
        })
        .collect();
    let odd: Vec<String> = vec![
        "".into(),
        "é–日本".into(),
        "\u{0}\u{ff}x".into(),
        "a".repeat(5000),
        "".into(),
    ];
    for (name, v) in [("low", low), ("high", high), ("odd", odd)] {
        for hint in [Hint::Memory, Hint::Balanced, Hint::Speed] {
            let p = PackedStrs::encode(&v, hint);
            let ctx = format!("{name}/{hint:?}/{}", p.describe());
            assert_eq!(p.len(), v.len());
            for (i, s) in v.iter().enumerate() {
                assert_eq!(&p.get_string(i), s, "{ctx} row {i}")
            }
            assert_eq!(
                p.count_eq(&v[v.len() / 2]),
                v.iter().filter(|s| **s == v[v.len() / 2]).count(),
                "{ctx}"
            );
            assert_eq!(p.count_eq("no such value"), 0);
            assert_eq!(
                p.count_where(|s| s.windows(2).any(|w| w == b"7?")),
                v.iter().filter(|s| s.contains("7?")).count(),
                "{ctx}"
            );
            let mut sel = vec![];
            p.select_where(|s| s.ends_with(b"3"), &mut sel);
            assert_eq!(
                sel,
                v.iter()
                    .enumerate()
                    .filter(|(_, s)| s.ends_with('3'))
                    .map(|(i, _)| i as u32)
                    .collect::<Vec<_>>(),
                "{ctx}"
            );
            let total: usize = p.group_count().iter().map(|(_, c)| c).sum();
            assert_eq!(total, v.len());
        }
    }
}

/// A long-tailed column (token ids): the sample sees a few thousand distinct values, the column has all 32,000.
/// The dictionary that the sample suggests must not be kept when plain offsets are smaller.
#[test]
fn long_tail_does_not_keep_an_oversized_dictionary() {
    let n = 2_000_000usize;
    let mut x = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    // Zipf-like: id = floor(32000 * u^6), so a few hundred ids carry most of the mass; then make every id occur
    let mut v: Vec<i64> = (0..n)
        .map(|_| {
            let u = (next() >> 11) as f64 / (1u64 << 53) as f64;
            (32_000.0 * u.powi(6)) as i64
        })
        .collect();
    for id in 0..32_000 {
        v[(next() % n as u64) as usize] = id;
    }
    for hint in [Hint::Memory, Hint::Balanced, Hint::Speed] {
        let p = PackedInts::encode(&v, hint);
        let bits = p.bytes() as f64 * 8.0 / n as f64;
        assert!(
            bits <= 16.01,
            "{hint:?}: {} at {bits:.2} bits per value",
            p.describe()
        );
        assert_eq!(p.sum(), v.iter().sum::<i64>());
        assert_eq!(
            p.count_range(100, 20_000),
            v.iter().filter(|&&a| (100..=20_000).contains(&a)).count()
        );
        for i in (0..n).step_by(9973) {
            assert_eq!(p.get(i), v[i]);
        }
        println!("{hint:?}: {} {bits:.2} bits", p.describe());
    }
}

/// A table saved to bytes and opened in place must answer exactly like the table it came from, and must stay usable
/// from several threads at once (the Node binding shares one table between worker threads).
#[test]
fn opened_in_place_matches_the_original() {
    use packmem::buf::Backing;
    use packmem::{Cell, DynTable, Pred};
    use std::sync::Arc;
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<DynTable>();

    let mut t = DynTable::new(Hint::Balanced);
    let n = 40_000usize;
    for i in 0..n {
        let mut row: Vec<(&str, Cell)> = vec![
            ("id", Cell::Int(i as i64)),
            ("g", Cell::Str(["x", "yy", "zzz"][i % 3].to_string())),
            (
                "v",
                if i % 7 == 0 {
                    Cell::Null
                } else {
                    Cell::Float(i as f64 / 4.0)
                },
            ),
            (
                "text",
                Cell::Str(format!(
                    "row number {i} with some repeated words words words"
                )),
            ),
            ("flag", Cell::Bool(i % 5 == 0)),
        ];
        if i % 2 == 1 {
            row.push(("opt", Cell::Json(format!("[{i},\"a\"]"))));
        }
        t.append(row);
    }
    t.set(3, 1, Cell::Str("patched".into()));
    let bytes = t.to_bytes();
    let copied = DynTable::from_bytes(&bytes).unwrap();
    let owner: Arc<dyn Backing> = Arc::new(bytes.clone());
    // a Vec<u8> is not guaranteed to be aligned for wider types; a mapped file is. Skip the in-place half if this
    // allocation happens to be misaligned rather than fail spuriously.
    let opened = if (owner.bytes().as_ptr() as usize) % 8 == 0 {
        Some(DynTable::from_backing(owner.clone()).unwrap())
    } else {
        None
    };
    for other in [Some(copied), opened].into_iter().flatten() {
        assert_eq!(other.len(), n);
        assert_eq!(other.names(), t.names());
        for r in (0..n).step_by(37).chain([3, n - 1]) {
            assert_eq!(other.row(r), t.row(r), "row {r}");
        }
        for (c, p) in [
            (1, Pred::Eq(Cell::Str("yy".into()))),
            (
                0,
                Pred::Range {
                    lo: 100.0,
                    hi: 5000.0,
                    lo_incl: true,
                    hi_incl: false,
                },
            ),
            (3, Pred::Contains("number 77".into())),
        ] {
            assert_eq!(other.select(c, &p), t.select(c, &p));
        }
        assert_eq!(other.sum(2, None), t.sum(2, None));
        let (mut a, mut b) = (other.group_count(1, None), t.group_count(1, None));
        a.sort_by_key(|x| format!("{x:?}"));
        b.sort_by_key(|x| format!("{x:?}"));
        assert_eq!(a, b);
        // readers on several threads at once
        std::thread::scope(|s| {
            for k in 0..4 {
                let other = &other;
                let t = &t;
                s.spawn(move || {
                    for r in (k..n).step_by(101) {
                        assert_eq!(other.row(r), t.row(r));
                    }
                });
            }
        });
        // writing to a table opened in place leaves the bytes alone and still reads back
        let mut w = other;
        w.set(10, 0, Cell::Int(-1));
        w.append([("id", Cell::Int(7))]);
        assert_eq!(w.get(10, 0), Cell::Int(-1));
        assert_eq!(w.get(n, 0), Cell::Int(7));
        assert_eq!(w.len(), n + 1);
    }
    // damaged input is refused, not read out of bounds
    for bad in [&bytes[..bytes.len() - 9], &bytes[..40], &[][..]] {
        assert!(DynTable::from_bytes(bad).is_err());
        let owner: Arc<dyn Backing> = Arc::new(bad.to_vec());
        assert!(DynTable::from_backing(owner).is_err());
    }
}
