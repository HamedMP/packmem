//! A table of packed columns built from flat records (JSON lines).
use crate::{Hint, PackedInts, PackedStrs};
use serde_json::Value;
use std::io::BufRead;

pub enum Column {
    Int(PackedInts),
    Str(PackedStrs),
}
impl Column {
    pub fn bytes(&self) -> usize {
        match self {
            Column::Int(c) => c.bytes(),
            Column::Str(c) => c.bytes(),
        }
    }
    pub fn describe(&self) -> String {
        match self {
            Column::Int(c) => c.describe(),
            Column::Str(c) => c.describe(),
        }
    }
}
pub struct Table {
    pub names: Vec<String>,
    pub cols: Vec<Column>,
    pub len: usize,
}

enum Buf {
    Int(Vec<i64>),
    Str(Vec<String>),
}

impl Table {
    /// Build from JSON lines. Integer fields become int columns; everything else is kept as text.
    /// Prototype limits: flat objects; the first record defines the schema; missing fields read as 0 / "".
    pub fn from_jsonl(r: impl BufRead, hint: Hint) -> std::io::Result<Table> {
        let mut names: Vec<String> = vec![];
        let mut bufs: Vec<Buf> = vec![];
        let mut n = 0usize;
        for line in r.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(&line)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            let obj = v.as_object().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "expected object")
            })?;
            if n == 0 {
                for (k, val) in obj {
                    names.push(k.clone());
                    bufs.push(if val.is_i64() {
                        Buf::Int(vec![])
                    } else {
                        Buf::Str(vec![])
                    })
                }
            }
            for (k, b) in names.iter().zip(bufs.iter_mut()) {
                let val = obj.get(k);
                match b {
                    Buf::Int(x) => x.push(val.and_then(|v| v.as_i64()).unwrap_or(0)),
                    Buf::Str(x) => x.push(match val {
                        Some(Value::String(s)) => s.clone(),
                        Some(o) => o.to_string(),
                        None => String::new(),
                    }),
                }
            }
            n += 1;
        }
        let cols = bufs
            .into_iter()
            .map(|b| match b {
                Buf::Int(x) => Column::Int(PackedInts::encode(&x, hint)),
                Buf::Str(x) => Column::Str(PackedStrs::encode(&x, hint)),
            })
            .collect();
        Ok(Table {
            names,
            cols,
            len: n,
        })
    }
    pub fn col(&self, name: &str) -> Option<&Column> {
        self.names
            .iter()
            .position(|n| n == name)
            .map(|i| &self.cols[i])
    }
    pub fn int(&self, name: &str) -> &PackedInts {
        match self.col(name) {
            Some(Column::Int(c)) => c,
            _ => panic!("no int column {name}"),
        }
    }
    pub fn str(&self, name: &str) -> &PackedStrs {
        match self.col(name) {
            Some(Column::Str(c)) => c,
            _ => panic!("no string column {name}"),
        }
    }
    pub fn bytes(&self) -> usize {
        self.cols.iter().map(|c| c.bytes()).sum()
    }
    /// Reconstruct one record as JSON (point lookup; decodes only this row).
    pub fn row_json(&self, i: usize) -> String {
        let mut m = serde_json::Map::new();
        for (k, c) in self.names.iter().zip(&self.cols) {
            m.insert(
                k.clone(),
                match c {
                    Column::Int(c) => Value::from(c.get(i)),
                    Column::Str(c) => Value::from(c.get_string(i)),
                },
            );
        }
        Value::Object(m).to_string()
    }
}
