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
