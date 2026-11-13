//! packmem CLI: inspect and query JSON-lines data held in packed, operation-aware form.
use packmem::{Column, Hint, Table};
use std::{fs::File, io::BufReader, time::Instant};

fn usage() -> ! {
    eprintln!(
        "usage:\n  packmem stats <file.jsonl> [--hint memory|balanced|speed]\n  packmem query <file.jsonl> [--hint H] [--eq col=value]... [--prefix col=text]... [--contains col=text]...\n                (--count | --sum col | --group col | --show N)"
    );
    std::process::exit(2)
}

fn intersect(a: &[u32], b: &[u32]) -> Vec<u32> {
    let (mut i, mut j, mut o) = (0, 0, vec![]);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            o.push(a[i]);
            i += 1;
            j += 1
        } else if a[i] < b[j] {
            i += 1
        } else {
            j += 1
        }
    }
    o
}
fn has(h: &[u8], n: &[u8]) -> bool {
    n.is_empty() || h.windows(n.len()).any(|w| w == n)
}

fn main() -> std::io::Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 2 {
        usage()
    }
    let mut hint = Hint::Balanced;
    if let Some(p) = a.iter().position(|x| x == "--hint") {
        hint = match a.get(p + 1).map(|s| s.as_str()) {
            Some("memory") => Hint::Memory,
            Some("speed") => Hint::Speed,
            Some("balanced") => Hint::Balanced,
            _ => usage(),
        }
    }
    let t0 = Instant::now();
    let t = Table::from_jsonl(BufReader::new(File::open(&a[1])?), hint)?;
    let load = t0.elapsed();
    let file_bytes = std::fs::metadata(&a[1])?.len() as f64;
    match a[0].as_str() {
        "stats" => {
            println!(
                "{} rows, {} columns, hint={:?}, loaded in {:.2?}",
                t.len,
                t.cols.len(),
                hint,
                load
            );
            println!(
                "{:<14} {:<26} {:>12} {:>10}",
                "column", "encoding", "bytes", "bits/row"
            );
            for (n, c) in t.names.iter().zip(&t.cols) {
                println!(
                    "{:<14} {:<26} {:>12} {:>10.2}",
                    n,
                    c.describe(),
                    c.bytes(),
                    c.bytes() as f64 * 8.0 / t.len.max(1) as f64
                )
            }
            println!(
                "total packed: {:.2} MB  (source file {:.2} MB, {:.1}x smaller)",
                t.bytes() as f64 / 1e6,
                file_bytes / 1e6,
                file_bytes / t.bytes() as f64
            );
        }
        "query" => {
            let mut sel: Option<Vec<u32>> = None;
            let mut i = 2;
            let mut action: Option<(String, String)> = None;
            let q0 = Instant::now();
            while i < a.len() {
                let k = a[i].as_str();
                let arg = a.get(i + 1).cloned().unwrap_or_default();
                match k {
                    "--hint" => i += 2,
                    "--eq" | "--prefix" | "--contains" => {
                        let (c, v) = arg.split_once('=').unwrap_or_else(|| usage());
                        let mut s = vec![];
                        match t.col(c) {
                            Some(Column::Int(col)) if k == "--eq" => {
                                let x: i64 = v.parse().unwrap_or_else(|_| usage());
                                col.select_range(x, x, &mut s)
                            }
                            Some(Column::Str(col)) => {
                                let vb = v.as_bytes();
                                match k {
                                    "--eq" => col.select_where(|x| x == vb, &mut s),
                                    "--prefix" => col.select_where(|x| x.starts_with(vb), &mut s),
                                    _ => col.select_where(|x| has(x, vb), &mut s),
                                }
                            }
                            _ => {
                                eprintln!("bad filter {k} {arg}");
                                usage()
                            }
                        }
                        sel = Some(match sel {
                            None => s,
                            Some(p) => intersect(&p, &s),
                        });
                        i += 2
                    }
                    "--count" => {
                        action = Some(("count".into(), String::new()));
                        i += 1
                    }
                    "--sum" | "--group" | "--show" => {
                        action = Some((k[2..].to_string(), arg));
                        i += 2
                    }
                    _ => usage(),
                }
            }
            let sel: Vec<u32> = sel.unwrap_or_else(|| (0..t.len as u32).collect());
            match action {
                Some((k, _)) if k == "count" => println!("{}", sel.len()),
                Some((k, c)) if k == "sum" => println!("{}", t.int(&c).sum_at(&sel)),
                Some((k, c)) if k == "show" => {
                    for &r in sel.iter().take(c.parse().unwrap_or(5)) {
                        println!("{}", t.row_json(r as usize))
                    }
                }
                Some((k, c)) if k == "group" => {
                    let mut m = std::collections::HashMap::<String, usize>::new();
                    match t.col(&c) {
                        Some(Column::Str(col)) => {
                            if sel.len() == t.len {
                                for (g, n) in col.group_count() {
                                    m.insert(g, n);
                                }
                            } else {
                                for &r in &sel {
                                    *m.entry(col.get_string(r as usize)).or_default() += 1
                                }
                            }
                        }
                        Some(Column::Int(col)) => {
                            for &r in &sel {
                                *m.entry(col.get(r as usize).to_string()).or_default() += 1
                            }
                        }
                        None => usage(),
                    }
                    let mut v: Vec<_> = m.into_iter().collect();
                    v.sort_by(|a, b| b.1.cmp(&a.1));
                    for (g, n) in v.iter().take(20) {
                        println!("{n:>10}  {g}")
                    }
                }
                _ => usage(),
            }
            eprintln!(
                "[query {:.2?} over {} rows; load {:.2?}]",
                q0.elapsed(),
                t.len,
                load
            );
        }
        // hidden: keep the table resident so its memory can be inspected from outside
        "hold" => {
            #[cfg(all(target_os = "linux", target_env = "gnu"))]
            {
                unsafe extern "C" {
                    fn malloc_trim(pad: usize) -> i32;
                }
                unsafe {
                    malloc_trim(0);
                }
            }
            println!("ready");
            std::thread::sleep(std::time::Duration::from_secs(600));
            std::hint::black_box(&t);
        }
        _ => usage(),
    }
    Ok(())
}
