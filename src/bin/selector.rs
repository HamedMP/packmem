//! Experiment 3: (a) how close is the sample-based selector to an exhaustive oracle, and how fast is it;
//! (b) how much does the best encoding depend on the operation.
use packmem::ints::{Scheme, choose, stats};
use packmem::{Hint, PackedInts};
use std::hint::black_box;
use std::time::Instant;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn f(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}
fn med(mut f: impl FnMut() -> u64, reps: usize) -> f64 {
    let mut t = vec![];
    black_box(f());
    for _ in 0..reps {
        let s = Instant::now();
        black_box(f());
        t.push(s.elapsed().as_secs_f64())
    }
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    t[reps / 2]
}

fn main() {
    let n = 1_000_000usize;
    let mut r = Rng(0x2545F4914F6CDD1D);
    let mut ds: Vec<(&str, Vec<i64>)> = vec![];
    ds.push(("constant", vec![42; n]));
    ds.push((
        "uniform 0..200",
        (0..n).map(|_| (r.next() % 200) as i64).collect(),
    ));
    ds.push((
        "uniform 20-bit",
        (0..n).map(|_| (r.next() % (1 << 20)) as i64).collect(),
    ));
    ds.push(("uniform 64-bit", (0..n).map(|_| r.next() as i64).collect()));
    ds.push((
        "5 distinct wide values",
        (0..n)
            .map(|_| [200i64, 404, 1 << 40, -77, 9_999_999_999][(r.next() % 5) as usize])
            .collect(),
    ));
    ds.push((
        "zipf ids (pareto 1.2)",
        (0..n)
            .map(|_| {
                loop {
                    let v = (1.0 / (1.0 - r.f()).powf(1.0 / 1.2)) as i64;
                    if v <= 100_000 {
                        break v;
                    }
                }
            })
            .collect(),
    ));
    let mut t = 1_760_000_000_000i64;
    ds.push((
        "sorted timestamps (ms)",
        (0..n)
            .map(|_| {
                t += (r.next() % 20) as i64;
                t
            })
            .collect(),
    ));
    let mut v = vec![];
    while v.len() < n {
        let x = (r.next() % 50) as i64;
        for _ in 0..(1 + r.next() % 300) {
            v.push(x)
        }
    }
    v.truncate(n);
    ds.push(("long runs (avg 150)", v));
    let mut v = vec![];
    while v.len() < n {
        let x = (r.next() % 50) as i64;
        for _ in 0..(1 + r.next() % 5) {
            v.push(x)
        }
    }
    v.truncate(n);
    ds.push(("short runs (avg 3)", v));
    let mut v = vec![];
    while v.len() < n {
        let b = (r.next() >> 4) as i64;
        for _ in 0..5000 {
            v.push(b + (r.next() % 1000) as i64)
        }
    }
    v.truncate(n);
    ds.push(("clustered (wide base + small noise)", v));
    ds.push((
        "small with 0.1% huge outliers",
        (0..n)
            .map(|_| {
                if r.next().is_multiple_of(1000) {
                    1 << 50
                } else {
                    (r.next() % 16) as i64
                }
            })
            .collect(),
    ));
    ds.push((
        "signed, mixed +/- 50k",
        (0..n)
            .map(|_| (r.next() % 100_000) as i64 - 50_000)
            .collect(),
    ));
    let mut id = 0i64;
    ds.push((
        "monotonic ids with gaps",
        (0..n)
            .map(|_| {
                id += 1 + (r.next() % 3) as i64;
                id
            })
            .collect(),
    ));
    ds.push((
        "booleans 0/1 (10% ones)",
        (0..n).map(|_| r.next().is_multiple_of(10) as i64).collect(),
    ));

    println!("== (a) selector vs exhaustive oracle, Hint::Memory, n={n} ==");
    println!(
        "{:<36} {:>9} {:>9} {:>9} {:>9} | {:<9} {:<9} {:>7} | {:>9} {:>10}",
        "dataset",
        "FOR b/v",
        "Dict",
        "RLE",
        "BlockFOR",
        "chosen",
        "oracle",
        "regret",
        "select ms",
        "try-all ms"
    );
    let (mut hits, mut worst, mut sumreg) = (0, 0f64, 0f64);
    for (name, v) in &ds {
        let st = stats(v);
        let sel_t = med(
            || {
                let st = stats(v);
                choose(&st, Hint::Memory) as u64
            },
            5,
        ) * 1e3;
        let chosen = choose(&st, Hint::Memory);
        let mut sizes = vec![];
        let t0 = Instant::now();
        for s in [Scheme::For, Scheme::Dict, Scheme::Rle, Scheme::BlockFor] {
            let p = PackedInts::encode_as(v, s, Hint::Memory, &st);
            // Dict silently falls back to FOR above 65,536 distinct values; mark that as not applicable
            let applicable = !(s == Scheme::Dict && !p.describe().starts_with("dict"));
            sizes.push((s, if applicable { p.bytes() } else { usize::MAX }));
        }
        let all_t = t0.elapsed().as_secs_f64() * 1e3;
        if st.min == st.max {
            sizes.push((Scheme::Const, 16))
        }
        let (os, ob) = *sizes.iter().min_by_key(|x| x.1).unwrap();
        let cb = if chosen == Scheme::Const {
            16
        } else {
            PackedInts::encode_as(v, chosen, Hint::Memory, &st).bytes()
        };
        let reg = if cb.abs_diff(ob) < 64 {
            0.0
        } else {
            cb as f64 / ob as f64 - 1.0
        };
        if reg < 0.005 {
            hits += 1
        }
        worst = worst.max(reg);
        sumreg += reg;
        let b = |s: Scheme| {
            sizes
                .iter()
                .find(|x| x.0 == s)
                .map(|x| {
                    if x.1 == usize::MAX {
                        "n/a".to_string()
                    } else {
                        format!("{:.2}", x.1 as f64 * 8.0 / n as f64)
                    }
                })
                .unwrap()
        };
        println!(
            "{:<36} {:>9} {:>9} {:>9} {:>9} | {:<9} {:<9} {:>6.1}% | {:>9.3} {:>10.1}",
            name,
            b(Scheme::For),
            b(Scheme::Dict),
            b(Scheme::Rle),
            b(Scheme::BlockFor),
            format!("{chosen:?}"),
            format!("{os:?}"),
            reg * 100.0,
            sel_t,
            all_t
        );
    }
    println!(
        "within 0.5% of oracle: {hits}/{}   mean regret {:.2}%   worst {:.1}%",
        ds.len(),
        sumreg / ds.len() as f64 * 100.0,
        worst * 100.0
    );

    println!("\n== (b) operation cost by encoding (ns per value / per lookup), n={n} ==");
    println!(
        "{:<26} {:<22} {:>9} {:>9} {:>11} {:>12}",
        "dataset", "encoding", "bits/val", "sum scan", "random get", "range count"
    );
    let mut x = 88172645463325252u64;
    let idx: Vec<usize> = (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x % n as u64) as usize
        })
        .collect();
    for name in [
        "uniform 20-bit",
        "sorted timestamps (ms)",
        "long runs (avg 150)",
        "zipf ids (pareto 1.2)",
    ] {
        let v = &ds.iter().find(|d| d.0 == name).unwrap().1;
        let st = stats(v);
        let (lo, hi) = {
            let mut s = v.clone();
            s.sort_unstable();
            (s[n / 2], s[n / 2 + n / 100])
        };
        let plain_sum =
            med(|| v.iter().fold(0i64, |a, &b| a.wrapping_add(b)) as u64, 9) * 1e9 / n as f64;
        let plain_get = med(
            || idx.iter().fold(0i64, |a, &i| a.wrapping_add(v[i])) as u64,
            9,
        ) * 1e9
            / n as f64;
        let plain_rng = med(
            || v.iter().filter(|&&x| x >= lo && x <= hi).count() as u64,
            9,
        ) * 1e9
            / n as f64;
        println!(
            "{:<26} {:<22} {:>9.2} {:>9.3} {:>11.3} {:>12.3}",
            name, "plain Vec<i64>", 64.0, plain_sum, plain_get, plain_rng
        );
        for (s, h) in [
            (Scheme::For, Hint::Speed),
            (Scheme::For, Hint::Memory),
            (Scheme::Dict, Hint::Memory),
            (Scheme::Rle, Hint::Memory),
            (Scheme::BlockFor, Hint::Memory),
        ] {
            let p = PackedInts::encode_as(v, s, h, &st);
            if s == Scheme::Dict && !p.describe().starts_with("dict") {
                continue;
            }
            let a = med(|| p.sum() as u64, 9) * 1e9 / n as f64;
            let g = med(
                || idx.iter().fold(0i64, |a, &i| a.wrapping_add(p.get(i))) as u64,
                5,
            ) * 1e9
                / n as f64;
            let c = med(|| p.count_range(lo, hi) as u64, 9) * 1e9 / n as f64;
            println!(
                "{:<26} {:<22} {:>9.2} {:>9.3} {:>11.3} {:>12.3}",
                "",
                p.describe(),
                p.bytes() as f64 * 8.0 / n as f64,
                a,
                g,
                c
            );
        }
    }
}
