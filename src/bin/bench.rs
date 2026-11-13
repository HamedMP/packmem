//! Benchmark: memory (exact live heap bytes) and query time for the same records held as
//! A) dynamic values, B) native structs, C) plain columns, D) lz4 page-compressed columns (zram-style), E) packmem.
use packmem::{Column, Hint, PackedInts, PackedStrs, Table};
use serde_json::Value;
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::hint::black_box;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        LIVE.fetch_add(l.size(), Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        LIVE.fetch_add(n, Relaxed);
        LIVE.fetch_sub(l.size(), Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static G: Counting = Counting;
fn live() -> usize {
    LIVE.load(Relaxed)
}

struct Rec {
    ts: i64,
    user_id: i64,
    method: String,
    path: String,
    status: i64,
    bytes: i64,
    latency_us: i64,
    ip: String,
    country: String,
    ua: String,
    session: String,
}
const INTS: [&str; 5] = ["ts", "user_id", "status", "bytes", "latency_us"];
const STRS: [&str; 6] = ["method", "path", "ip", "country", "ua", "session"];
struct Cols {
    i: Vec<Vec<i64>>,
    s: Vec<Vec<String>>,
}

fn has(h: &[u8], n: &[u8]) -> bool {
    h.windows(n.len()).any(|w| w == n)
}
fn time(mut f: impl FnMut() -> u64) -> (f64, u64) {
    let mut r = f();
    let mut t = vec![];
    for _ in 0..9 {
        let s = Instant::now();
        r = black_box(f());
        t.push(s.elapsed().as_secs_f64() * 1e3)
    }
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (t[4], r)
}

// ---- D: page-compressed columns (4 KiB pages, LZ4), one cached decompressed page per reader ----
struct PageCol {
    comp: Vec<u8>,
    offs: Vec<u32>,
}
impl PageCol {
    fn new(raw: &[u8]) -> Self {
        let (mut comp, mut offs) = (vec![], vec![0u32]);
        for p in raw.chunks(4096) {
            comp.extend_from_slice(&lz4_flex::block::compress(p));
            offs.push(comp.len() as u32)
        }
        comp.shrink_to_fit();
        PageCol { comp, offs }
    }
    fn bytes(&self) -> usize {
        self.comp.len() + self.offs.len() * 4
    }
}
struct Reader<'a> {
    pc: &'a PageCol,
    cur: usize,
    buf: Vec<u8>,
    faults: u64,
}
impl<'a> Reader<'a> {
    fn new(pc: &'a PageCol) -> Self {
        Reader {
            pc,
            cur: usize::MAX,
            buf: vec![0u8; 4096],
            faults: 0,
        }
    }
    #[inline]
    fn page(&mut self, k: usize) -> &[u8] {
        if k != self.cur {
            let c = &self.pc.comp[self.pc.offs[k] as usize..self.pc.offs[k + 1] as usize];
            let n = lz4_flex::block::decompress_into(c, &mut self.buf).unwrap();
            let _ = n;
            self.cur = k;
            self.faults += 1
        }
        &self.buf
    }
    #[inline]
    fn i64_at(&mut self, i: usize) -> i64 {
        let p = self.page(i >> 9);
        let o = (i & 511) * 8;
        i64::from_le_bytes(p[o..o + 8].try_into().unwrap())
    }
    #[inline]
    fn u32_at(&mut self, i: usize) -> u32 {
        let p = self.page(i >> 10);
        let o = (i & 1023) * 4;
        u32::from_le_bytes(p[o..o + 4].try_into().unwrap())
    }
    fn range(&mut self, a: usize, b: usize, out: &mut Vec<u8>) {
        out.clear();
        let mut a = a;
        while a < b {
            let k = a >> 12;
            let e = b.min((k + 1) << 12);
            let p = self.page(k);
            out.extend_from_slice(&p[a & 4095..=((e - 1) & 4095)]);
            a = e
        }
    }
}
struct PagedStr {
    offs: PageCol,
    data: PageCol,
}
struct Paged {
    i: Vec<PageCol>,
    s: Vec<PagedStr>,
    n: usize,
}
struct SR<'a> {
    o: Reader<'a>,
    d: Reader<'a>,
    buf: Vec<u8>,
}
impl<'a> SR<'a> {
    fn new(p: &'a PagedStr) -> Self {
        SR {
            o: Reader::new(&p.offs),
            d: Reader::new(&p.data),
            buf: vec![],
        }
    }
    #[inline]
    fn get(&mut self, i: usize) -> &[u8] {
        let a = self.o.u32_at(i) as usize;
        let b = self.o.u32_at(i + 1) as usize;
        self.d.range(a, b, &mut self.buf);
        &self.buf
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("jsonl path");
    let b0 = live();
    let mut recs: Vec<Rec> = vec![];
    for l in BufReader::new(std::fs::File::open(&path).unwrap()).lines() {
        let l = l.unwrap();
        let v: Value = serde_json::from_str(&l).unwrap();
        let s = |k: &str| v[k].as_str().unwrap().to_string();
        let i = |k: &str| v[k].as_i64().unwrap();
        recs.push(Rec {
            ts: i("ts"),
            user_id: i("user_id"),
            method: s("method"),
            path: s("path"),
            status: i("status"),
            bytes: i("bytes"),
            latency_us: i("latency_us"),
            ip: s("ip"),
            country: s("country"),
            ua: s("ua"),
            session: s("session"),
        })
    }
    recs.shrink_to_fit();
    let n = recs.len();
    let mem_b = live() - b0;
    let file_bytes = std::fs::metadata(&path).unwrap().len() as usize;
    // query parameters
    let (ts_lo, ts_hi) = (recs[n / 2].ts, recs[n / 2 + n / 100].ts);
    let needle_session = recs[n / 3].session.clone();
    let mut x = 88172645463325252u64;
    let idx: Vec<usize> = (0..100_000)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x % n as u64) as usize
        })
        .collect();
    let mut out: Vec<(String, usize, Vec<f64>)> = vec![];
    let mut answers: Vec<Vec<u64>> = vec![];
    let grp = |m: HashMap<Vec<u8>, u64>| -> u64 {
        m.iter()
            .map(|(k, c)| c * (k[0] as u64 * 31 + k[1] as u64))
            .sum()
    };

    // ---- A: Vec<serde_json::Value> (how dynamic runtimes hold parsed JSON) ----
    {
        let a0 = live();
        let mut vals: Vec<Value> = BufReader::new(std::fs::File::open(&path).unwrap())
            .lines()
            .map(|l| serde_json::from_str(&l.unwrap()).unwrap())
            .collect();
        vals.shrink_to_fit();
        let mem = live() - a0;
        let v = &vals;
        let qs: Vec<Box<dyn FnMut() -> u64 + '_>> = vec![
            Box::new(|| {
                v.iter()
                    .filter(|r| r["status"].as_i64() == Some(404))
                    .map(|r| r["bytes"].as_i64().unwrap() as u64)
                    .sum()
            }),
            Box::new(|| {
                v.iter()
                    .filter(|r| {
                        r["path"]
                            .as_str()
                            .unwrap()
                            .as_bytes()
                            .starts_with(b"/api/v1/search")
                    })
                    .count() as u64
            }),
            Box::new(|| {
                v.iter()
                    .filter(|r| has(r["ua"].as_str().unwrap().as_bytes(), b"curl"))
                    .count() as u64
            }),
            Box::new(|| {
                let mut m = HashMap::new();
                for r in v {
                    *m.entry(r["country"].as_str().unwrap().as_bytes().to_vec())
                        .or_default() += 1
                }
                grp(m)
            }),
            Box::new(|| {
                idx.iter()
                    .map(|&i| {
                        v[i]["user_id"].as_i64().unwrap() as u64
                            + v[i]["path"].as_str().unwrap().len() as u64
                    })
                    .sum()
            }),
            Box::new(|| {
                v.iter()
                    .filter(|r| {
                        let t = r["ts"].as_i64().unwrap();
                        t >= ts_lo && t <= ts_hi
                    })
                    .count() as u64
            }),
            Box::new(|| {
                v.iter()
                    .map(|r| r["latency_us"].as_i64().unwrap() as u64)
                    .sum()
            }),
            Box::new(|| {
                v.iter()
                    .filter(|r| r["session"].as_str().unwrap() == needle_session)
                    .count() as u64
            }),
        ];
        let (t, a): (Vec<f64>, Vec<u64>) = qs.into_iter().map(time).unzip();
        out.push(("A dynamic values (serde_json::Value)".into(), mem, t));
        answers.push(a);
    }

    // ---- B: Vec<Rec> native structs ----
    {
        let v = &recs;
        let qs: Vec<Box<dyn FnMut() -> u64 + '_>> = vec![
            Box::new(|| {
                v.iter()
                    .filter(|r| r.status == 404)
                    .map(|r| r.bytes as u64)
                    .sum()
            }),
            Box::new(|| {
                v.iter()
                    .filter(|r| r.path.as_bytes().starts_with(b"/api/v1/search"))
                    .count() as u64
            }),
            Box::new(|| v.iter().filter(|r| has(r.ua.as_bytes(), b"curl")).count() as u64),
            Box::new(|| {
                let mut m = HashMap::new();
                for r in v {
                    *m.entry(r.country.as_bytes().to_vec()).or_default() += 1
                }
                grp(m)
            }),
            Box::new(|| {
                idx.iter()
                    .map(|&i| v[i].user_id as u64 + v[i].path.len() as u64)
                    .sum()
            }),
            Box::new(|| v.iter().filter(|r| r.ts >= ts_lo && r.ts <= ts_hi).count() as u64),
            Box::new(|| v.iter().map(|r| r.latency_us as u64).sum()),
            Box::new(|| v.iter().filter(|r| r.session == needle_session).count() as u64),
        ];
        let (t, a): (Vec<f64>, Vec<u64>) = qs.into_iter().map(time).unzip();
        out.push((
            "B native structs (Vec<struct>, String fields)".into(),
            mem_b,
            t,
        ));
        answers.push(a);
    }

    // ---- C: plain columns ----
    let c0 = live();
    let cols = Cols {
        i: vec![
            recs.iter().map(|r| r.ts).collect(),
            recs.iter().map(|r| r.user_id).collect(),
            recs.iter().map(|r| r.status).collect(),
            recs.iter().map(|r| r.bytes).collect(),
            recs.iter().map(|r| r.latency_us).collect(),
        ],
        s: vec![
            recs.iter().map(|r| r.method.clone()).collect(),
            recs.iter().map(|r| r.path.clone()).collect(),
            recs.iter().map(|r| r.ip.clone()).collect(),
            recs.iter().map(|r| r.country.clone()).collect(),
            recs.iter().map(|r| r.ua.clone()).collect(),
            recs.iter().map(|r| r.session.clone()).collect(),
        ],
    };
    let mem_c = live() - c0;
    drop(recs);
    {
        let (ci, cs) = (&cols.i, &cols.s);
        let qs: Vec<Box<dyn FnMut() -> u64 + '_>> = vec![
            Box::new(|| {
                ci[2]
                    .iter()
                    .zip(&ci[3])
                    .filter(|(s, _)| **s == 404)
                    .map(|(_, b)| *b as u64)
                    .sum()
            }),
            Box::new(|| {
                cs[1]
                    .iter()
                    .filter(|p| p.as_bytes().starts_with(b"/api/v1/search"))
                    .count() as u64
            }),
            Box::new(|| cs[4].iter().filter(|u| has(u.as_bytes(), b"curl")).count() as u64),
            Box::new(|| {
                let mut m = HashMap::new();
                for c in &cs[3] {
                    *m.entry(c.as_bytes().to_vec()).or_default() += 1
                }
                grp(m)
            }),
            Box::new(|| {
                idx.iter()
                    .map(|&i| ci[1][i] as u64 + cs[1][i].len() as u64)
                    .sum()
            }),
            Box::new(|| ci[0].iter().filter(|&&t| t >= ts_lo && t <= ts_hi).count() as u64),
            Box::new(|| ci[4].iter().map(|&l| l as u64).sum()),
            Box::new(|| cs[5].iter().filter(|s| **s == needle_session).count() as u64),
        ];
        let (t, a): (Vec<f64>, Vec<u64>) = qs.into_iter().map(time).unzip();
        out.push(("C plain columns (Vec<i64>, Vec<String>)".into(), mem_c, t));
        answers.push(a);
    }

    // ---- D: LZ4 page-compressed columns ----
    let raw_i: Vec<Vec<u8>> = cols
        .i
        .iter()
        .map(|c| c.iter().flat_map(|v| v.to_le_bytes()).collect())
        .collect();
    let raw_s: Vec<(Vec<u8>, Vec<u8>)> = cols
        .s
        .iter()
        .map(|c| {
            let mut o = vec![0u32];
            let mut d = vec![];
            for s in c {
                d.extend_from_slice(s.as_bytes());
                o.push(d.len() as u32)
            }
            (o.iter().flat_map(|v| v.to_le_bytes()).collect(), d)
        })
        .collect();
    let raw_total: usize = raw_i.iter().map(|r| r.len()).sum::<usize>()
        + raw_s.iter().map(|(a, b)| a.len() + b.len()).sum::<usize>();
    let zsize = |blk: usize, lvl: i32| -> usize {
        raw_i
            .iter()
            .chain(raw_s.iter().flat_map(|(a, b)| [a, b]))
            .map(|r| {
                r.chunks(blk)
                    .map(|c| zstd::bulk::compress(c, lvl).unwrap().len() + 4)
                    .sum::<usize>()
            })
            .sum()
    };
    let (z4k, z64k) = (zsize(4096, 3), zsize(65536, 3));
    {
        let pg = Paged {
            i: raw_i.iter().map(|r| PageCol::new(r)).collect(),
            s: raw_s
                .iter()
                .map(|(o, d)| PagedStr {
                    offs: PageCol::new(o),
                    data: PageCol::new(d),
                })
                .collect(),
            n,
        };
        let mem = pg.i.iter().map(|p| p.bytes()).sum::<usize>()
            + pg.s
                .iter()
                .map(|p| p.offs.bytes() + p.data.bytes())
                .sum::<usize>();
        let p = &pg;
        let qs: Vec<Box<dyn FnMut() -> u64 + '_>> = vec![
            Box::new(|| {
                let (mut s, mut b) = (Reader::new(&p.i[2]), Reader::new(&p.i[3]));
                (0..p.n)
                    .filter(|&i| s.i64_at(i) == 404)
                    .map(|i| b.i64_at(i) as u64)
                    .sum()
            }),
            Box::new(|| {
                let mut r = SR::new(&p.s[1]);
                (0..p.n)
                    .filter(|&i| r.get(i).starts_with(b"/api/v1/search"))
                    .count() as u64
            }),
            Box::new(|| {
                let mut r = SR::new(&p.s[4]);
                (0..p.n).filter(|&i| has(r.get(i), b"curl")).count() as u64
            }),
            Box::new(|| {
                let mut r = SR::new(&p.s[3]);
                let mut m = HashMap::new();
                for i in 0..p.n {
                    *m.entry(r.get(i).to_vec()).or_default() += 1
                }
                grp(m)
            }),
            Box::new(|| {
                let mut u = Reader::new(&p.i[1]);
                let mut o = Reader::new(&p.s[1].offs);
                idx.iter()
                    .map(|&i| u.i64_at(i) as u64 + (o.u32_at(i + 1) - o.u32_at(i)) as u64)
                    .sum()
            }),
            Box::new(|| {
                let mut t = Reader::new(&p.i[0]);
                (0..p.n)
                    .filter(|&i| {
                        let v = t.i64_at(i);
                        v >= ts_lo && v <= ts_hi
                    })
                    .count() as u64
            }),
            Box::new(|| {
                let mut l = Reader::new(&p.i[4]);
                (0..p.n).map(|i| l.i64_at(i) as u64).sum()
            }),
            Box::new(|| {
                let mut r = SR::new(&p.s[5]);
                (0..p.n)
                    .filter(|&i| r.get(i) == needle_session.as_bytes())
                    .count() as u64
            }),
        ];
        let (t, a): (Vec<f64>, Vec<u64>) = qs.into_iter().map(time).unzip();
        out.push((
            "D plain columns, LZ4 4K pages (decompress to use)".into(),
            mem,
            t,
        ));
        answers.push(a);
    }
    drop(raw_i);
    drop(raw_s);

    // ---- E: packmem ----
    let mut encodings = vec![];
    for hint in [Hint::Memory, Hint::Balanced, Hint::Speed] {
        let e0 = live();
        let t0 = Instant::now();
        let mut names = vec![];
        let mut tc = vec![];
        for (k, c) in INTS.iter().zip(&cols.i) {
            names.push(k.to_string());
            tc.push(Column::Int(PackedInts::encode(c, hint)))
        }
        for (k, c) in STRS.iter().zip(&cols.s) {
            names.push(k.to_string());
            tc.push(Column::Str(PackedStrs::encode(c, hint)))
        }
        let t = Table {
            names,
            cols: tc,
            len: n,
        };
        let enc_ms = t0.elapsed().as_secs_f64() * 1e3;
        let mem = live() - e0;
        let t = &t;
        encodings.push((
            hint,
            enc_ms,
            t.names
                .iter()
                .zip(&t.cols)
                .map(|(n, c)| (n.clone(), c.describe(), c.bytes()))
                .collect::<Vec<_>>(),
        ));
        let qs: Vec<Box<dyn FnMut() -> u64 + '_>> = vec![
            Box::new(|| {
                let mut sel = vec![];
                t.int("status").select_range(404, 404, &mut sel);
                t.int("bytes").sum_at(&sel) as u64
            }),
            Box::new(|| {
                t.str("path")
                    .count_where(|p| p.starts_with(b"/api/v1/search")) as u64
            }),
            Box::new(|| t.str("ua").count_where(|u| has(u, b"curl")) as u64),
            Box::new(|| {
                t.str("country")
                    .group_count()
                    .iter()
                    .map(|(k, c)| {
                        *c as u64 * (k.as_bytes()[0] as u64 * 31 + k.as_bytes()[1] as u64)
                    })
                    .sum()
            }),
            Box::new(|| {
                let (u, p) = (t.int("user_id"), t.str("path"));
                let mut b = vec![];
                idx.iter()
                    .map(|&i| u.get(i) as u64 + p.get(i, &mut b).len() as u64)
                    .sum()
            }),
            Box::new(|| t.int("ts").count_range(ts_lo, ts_hi) as u64),
            Box::new(|| t.int("latency_us").sum() as u64),
            Box::new(|| t.str("session").count_eq(&needle_session) as u64),
        ];
        let (tm, a): (Vec<f64>, Vec<u64>) = qs.into_iter().map(time).unzip();
        let mem_after = live() - e0;
        eprintln!("packmem {hint:?}: live heap after build {mem} B, after queries {mem_after} B");
        out.push((format!("E packmem ({hint:?})"), mem_after, tm));
        answers.push(a);
    }
    for a in &answers {
        assert_eq!(a, &answers[0], "representations disagree")
    }
    println!(
        "rows={n} file_bytes={file_bytes} raw_columnar_bytes={raw_total} zstd3_4k_pages={z4k} zstd3_64k_blocks={z64k}"
    );
    println!(
        "answers (identical for all representations): {:?}",
        answers[0]
    );
    println!(
        "{:<52} {:>9} | {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8}",
        "representation", "MB", "Q1 ms", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"
    );
    for (name, mem, t) in &out {
        print!("{:<52} {:>9.2} |", name, *mem as f64 / 1e6);
        for x in t {
            print!(" {:>8.4}", x)
        }
        println!()
    }
    for (h, ms, cols) in &encodings {
        println!("-- {h:?}: encoded in {ms:.0} ms");
        for (c, d, b) in cols {
            println!(
                "   {:<12} {:<24} {:>10} B  {:>6.2} bits/row",
                c,
                d,
                b,
                *b as f64 * 8.0 / n as f64
            )
        }
    }
}
