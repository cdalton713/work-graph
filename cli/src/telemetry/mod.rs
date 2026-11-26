//! Opt-in CLI error reporting. Only the fields constructed here enter an envelope.

use reqwest::blocking::Client;
use sentry_types::Dsn;
use sentry_types::protocol::latest::{Envelope, Event, Level};
use std::{env, panic, process::ExitCode, sync::mpsc, thread, time::Duration};

const FLUSH_TIMEOUT: Duration = Duration::from_millis(500);
const VERBS: &[&str] = &[
    "usage", "setup", "login", "logout", "join", "leave", "share", "pull", "check", "owns", "log",
    "run", "contract", "config",
];

#[derive(Clone)]
struct Reporter {
    dsn: Dsn,
    verb: &'static str,
}

impl Reporter {
    fn configured() -> Option<Self> {
        let dsn = env::var("WG_SENTRY_DSN").ok()?.parse().ok()?;
        let arg = env::args_os().nth(1);
        let verb = VERBS
            .iter()
            .copied()
            .find(|verb| arg.as_deref() == Some(verb.as_ref()));
        Some(Self {
            dsn,
            verb: verb.unwrap_or("unknown"),
        })
    }

    fn report(&self, message: &'static str) {
        let reporter = self.clone();
        let (sent, flushed) = mpsc::channel();
        // DNS and TLS setup must also fit within the command's exit deadline.
        if thread::Builder::new()
            .spawn(move || {
                let _ = reporter.send(message);
                let _ = sent.send(());
            })
            .is_ok()
        {
            let _ = flushed.recv_timeout(FLUSH_TIMEOUT);
        }
    }

    fn send(&self, message: &'static str) -> Result<(), Box<dyn std::error::Error>> {
        let event = Event {
            release: Some(env!("CARGO_PKG_VERSION").into()),
            platform: "native".into(),
            message: Some(message.into()),
            level: Level::Fatal,
            tags: [("command".into(), self.verb.into())].into(),
            ..Default::default()
        };
        let mut body = Vec::new();
        Envelope::from(event).to_writer(&mut body)?;
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(FLUSH_TIMEOUT)
            .build()?
            .post(self.dsn.envelope_api_url())
            .header(
                "X-Sentry-Auth",
                format!(
                    "Sentry sentry_version=7, sentry_key={}",
                    self.dsn.public_key()
                ),
            )
            .header("Content-Type", "application/x-sentry-envelope")
            .body(body)
            .send()?;
        Ok(())
    }
}

pub fn run(dispatch: impl FnOnce() -> ExitCode) -> ExitCode {
    let Some(reporter) = Reporter::configured() else {
        return dispatch();
    };
    let previous = panic::take_hook();
    let panic_reporter = reporter.clone();
    panic::set_hook(Box::new(move |info| {
        panic_reporter.report("Command panicked");
        previous(info);
    }));
    let status = dispatch();
    if status != ExitCode::SUCCESS {
        reporter.report("Command failed");
    }
    status
}
