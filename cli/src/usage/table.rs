use super::sum;
use crate::local::time;
use chrono::DateTime;
use serde_json::Value;

fn short(n: u64) -> String {
    for (size, unit, next) in [
        (1_000_000_000, "B", ""),
        (1_000_000, "M", "B"),
        (1000, "K", "M"),
    ] {
        if n >= size {
            let value = format!("{:.1}", n as f64 / size as f64);
            if value == "1000.0" && !next.is_empty() {
                return format!("1.0{next}");
            }
            return format!("{value}{unit}");
        }
    }
    n.to_string()
}
fn count(row: &Value, k: &str) -> String {
    short(row[k].as_u64().unwrap_or(0))
}

pub(super) fn print(rows: &[Value], roles: &Value, total: &Value, all: bool) {
    if rows.is_empty() {
        println!("no session transcript of this effort");
        return;
    }
    let mut table = vec![
        [
            "role", "node", "agent", "model", "calls", "fresh", "c.write", "c.read", "output",
            "max ctx", "start", "first", "last",
        ]
        .map(str::to_owned)
        .to_vec(),
    ];
    let limit = if all { rows.len() } else { rows.len().min(15) };
    for s in &rows[..limit] {
        let mut cells = ["role", "key", "agent", "model"]
            .map(|k| s[k].as_str().unwrap_or("-").to_owned())
            .to_vec();
        cells.push(s["calls"].to_string());
        cells.extend(
            [
                "fresh",
                "cache_write",
                "cache_read",
                "output",
                "max_context",
                "start_context",
            ]
            .map(|k| count(s, k)),
        );
        cells.extend(["first", "last"].map(|k| {
            s[k].as_str()
                .and_then(|s| time::parse(s).ok())
                .and_then(|t| DateTime::from_timestamp_micros(t.micros + t.offset.unwrap_or(0)))
                .map_or_else(|| "-".to_owned(), |t| t.format("%m-%d %H:%M").to_string())
        }));
        table.push(cells);
    }
    let widths: Vec<_> = (0..table[0].len())
        .map(|i| table.iter().map(|r| r[i].chars().count()).max().unwrap())
        .collect();
    for row in table {
        let line = row
            .iter()
            .zip(&widths)
            .map(|(cell, width)| format!("{cell:<width$}"))
            .collect::<Vec<_>>()
            .join("  ");
        println!("{}", line.trim_end());
    }
    if limit < rows.len() {
        let rest = sum(rows[limit..].iter());
        println!(
            "and {} more sessions: input {}, output {}",
            rest["sessions"],
            count(&rest, "input"),
            count(&rest, "output")
        );
    }
    println!();
    for role in ["coordinator", "worker", "other", "total"] {
        let part = if role == "total" { total } else { &roles[role] };
        if part["sessions"] == 0 {
            continue;
        }
        println!(
            "{role:<12} {:>4} sessions  {:>6} calls  input {} (fresh {}, cache write {}, cache read {})  output {}",
            part["sessions"].as_u64().unwrap(),
            part["calls"].as_u64().unwrap(),
            count(part, "input"),
            count(part, "fresh"),
            count(part, "cache_write"),
            count(part, "cache_read"),
            count(part, "output")
        );
    }
}
