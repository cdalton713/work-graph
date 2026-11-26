//! Calendar, week-date, and clock forms accepted by the reference CLI.
use super::repr_str;
use chrono::{NaiveDate, Weekday};
use regex::Regex;
use std::sync::LazyLock;

static DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?P<year>[0-9]{4})(?:(?P<calendar>-[0-9]{2}-[0-9]{2}|[0-9]{4})|(?P<week>-W[0-9]{2}(?:-[1-7])?|W[0-9]{2}[1-7]?))").unwrap()
});
static CLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{2})(?:(?::([0-9]{2})(?::([0-9]{2}))?)|(?:([0-9]{2})([0-9]{2})?))?(?:[.,]([0-9]+))?$").unwrap()
});

struct Clock {
    hour: i64,
    minute: i64,
    second: i64,
    micro: i64,
}
impl Clock {
    fn parse(s: &str) -> Option<Self> {
        let c = CLOCK.captures(s)?;
        let number = |index| c.get(index).map_or(0, |m| m.as_str().parse().unwrap());
        let fraction = c.get(6).map_or("", |m| m.as_str());
        let digits = &fraction[..fraction.len().min(6)];
        let micro = digits.parse::<i64>().unwrap_or(0) * 10i64.pow(6 - digits.len() as u32);
        Some(Self {
            hour: number(1),
            minute: number(2) + number(4),
            second: number(3) + number(5),
            micro,
        })
    }
    fn micros(&self) -> i64 {
        ((self.hour * 60 + self.minute) * 60 + self.second) * 1_000_000 + self.micro
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timestamp {
    pub micros: i64,
    pub offset: Option<i64>,
}
pub fn parse(input: &str) -> Result<Timestamp, String> {
    let input = input.replace('Z', "+00:00");
    let invalid = || format!("Invalid isoformat string: {}", repr_str(&input));
    let c = DATE.captures(&input).ok_or_else(invalid)?;
    let year = c["year"].parse().unwrap();
    let date = if let Some(m) = c.name("calendar") {
        let digits = m.as_str().replace('-', "");
        let month = digits[..2].parse().unwrap();
        let day = digits[2..].parse().unwrap();
        if !(1..=12).contains(&month) {
            return Err("month must be in 1..12".into());
        }
        NaiveDate::from_ymd_opt(year, month, day).ok_or("day is out of range for month")?
    } else {
        let digits = c["week"]
            .trim_start_matches('-')
            .trim_start_matches('W')
            .replace('-', "");
        let week = digits[..2].parse().unwrap();
        let weekday = digits.as_bytes().get(2).map_or(0, |d| d - b'1');
        NaiveDate::from_isoywd_opt(year, week, Weekday::try_from(weekday).unwrap())
            .ok_or_else(invalid)?
    };
    if year == 0 {
        return Err("year 0 is out of range".into());
    }
    let remainder = &input[c.get(0).unwrap().end()..];
    let midnight = date
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_micros();
    if remainder.is_empty() {
        return Ok(Timestamp {
            micros: midnight,
            offset: None,
        });
    }
    let clock = &remainder[remainder.chars().next().unwrap().len_utf8()..];
    let (clock, offset) = match clock.find(['+', '-']) {
        None => (clock, None),
        Some(i) => {
            let offset = Clock::parse(&clock[i + 1..]).ok_or_else(invalid)?;
            let value = if offset.hour == 0 && offset.minute == 0 && offset.second == 0 {
                0
            } else {
                offset.micros()
            };
            let signed = if clock.as_bytes()[i] == b'-' {
                -value
            } else {
                value
            };
            if value >= 86_400_000_000 {
                let days = signed.div_euclid(86_400_000_000);
                let seconds = signed.div_euclid(1_000_000).rem_euclid(86400);
                let micros = signed.rem_euclid(1_000_000);
                let mut parts = vec![format!("days={days}")];
                if seconds != 0 {
                    parts.push(format!("seconds={seconds}"))
                }
                if micros != 0 {
                    parts.push(format!("microseconds={micros}"))
                }
                return Err(format!(
                    "offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not datetime.timedelta({}).",
                    parts.join(", ")
                ));
            }
            (&clock[..i], Some(signed))
        }
    };
    let t = Clock::parse(clock).ok_or_else(invalid)?;
    for (value, max, name) in [
        (t.hour, 23, "hour"),
        (t.minute, 59, "minute"),
        (t.second, 59, "second"),
    ] {
        if value > max {
            return Err(format!("{name} must be in 0..{max}"));
        }
    }
    Ok(Timestamp {
        micros: midnight + t.micros() - offset.unwrap_or(0),
        offset,
    })
}

pub fn since(s: &str, now_micros: i64) -> Result<i64, String> {
    let s = s.trim();
    if let Ok(t) = parse(s) {
        return Ok(t.micros);
    }
    let mut left = s;
    let mut delta = 0i64;
    while !left.is_empty() {
        let n = left.bytes().take_while(u8::is_ascii_digit).count();
        let unit = left.as_bytes().get(n);
        let factor = match unit {
            Some(b'w') => 604800,
            Some(b'd') => 86400,
            Some(b'h') => 3600,
            Some(b'm') => 60,
            Some(b's') => 1,
            _ => break,
        };
        let Ok(v) = left[..n].parse::<i64>() else {
            break;
        };
        delta = delta.saturating_add(v.saturating_mul(factor));
        left = &left[n + 1..];
        if left.is_empty() {
            return Ok(now_micros.saturating_sub(delta.saturating_mul(1_000_000)));
        }
    }
    Err(format!(
        "invalid --since {}: give a duration such as 2h or 3d, or a time such as 2026-01-01T09:00:00Z",
        repr_str(s)
    ))
}
