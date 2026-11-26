//! Coordinator polling and page wakeups.
use crate::page::link::Link;
use serde_json::Value;
use std::{collections::HashSet, io::Write, thread, time::Duration};

/// A successful refresh includes the messages applied by the snapshot and publish operations.
pub struct Refresh {
    pub complete: bool,
    pub actionable: bool,
    pub claims_unavailable: bool,
    pub settled: Vec<String>,
}

pub trait Coordinator {
    fn receive(&mut self, interval: Duration) -> Result<Option<Value>, String>;
    fn refresh(&mut self, messages: &[Value]) -> Result<Refresh, String>;
    /// Print and flush the terminal result (or waiting notes) before acknowledging messages.
    fn report(&mut self, result: &Refresh, finished: bool) -> Result<(), String>;
    fn acknowledge(&mut self, ids: &[String]);
}

/// Wait for a page event, or poll on the configured interval for an unlinked effort.
pub fn wait_for_change(
    link: Option<&mut Link>,
    interval: Duration,
) -> Result<Option<Value>, String> {
    match link {
        Some(link) => link.wait(interval),
        None => {
            thread::sleep(interval);
            Ok(None)
        }
    }
}

/// Drive one-shot next, next --wait, or the watch alias. The link handles reconnects.
pub fn next(
    coordinator: &mut impl Coordinator,
    wait: bool,
    interval: Duration,
    initial: Vec<Value>,
    warnings: &mut impl Write,
) -> Result<(), String> {
    if interval.is_zero() {
        return Err("--interval must be a positive number of seconds".into());
    }
    let mut messages = Vec::new();
    for message in initial {
        enqueue(&mut messages, message);
    }
    let mut handled = HashSet::<String>::new();
    loop {
        match coordinator.refresh(&messages) {
            Ok(result) => {
                let finished =
                    !wait || result.complete || result.actionable || result.claims_unavailable;
                coordinator.report(&result, finished)?;
                if !result.settled.is_empty() {
                    coordinator.acknowledge(&result.settled);
                    handled.extend(result.settled.iter().cloned());
                    messages.retain(|m| !result.settled.iter().any(|id| m["id"] == *id));
                }
                if finished {
                    return Ok(());
                }
            }
            Err(error) if wait => {
                writeln!(warnings, "warn next: {error}").map_err(|e| e.to_string())?
            }
            Err(error) => return Err(error),
        }
        if let Some(message) = coordinator.receive(interval)? {
            if let Some(id) = message["id"].as_str().filter(|id| handled.contains(*id)) {
                coordinator.acknowledge(&[id.to_owned()]);
            } else {
                enqueue(&mut messages, message);
            }
        }
    }
}

fn enqueue(messages: &mut Vec<Value>, message: Value) {
    if let Some(id) = message["id"].as_str() {
        if let Some(previous) = messages.iter_mut().find(|m| m["id"] == id) {
            *previous = message;
        } else {
            messages.push(message);
        }
    }
}

#[cfg(test)]
mod tests;
