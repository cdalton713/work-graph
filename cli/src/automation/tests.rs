use super::*;
use serde_json::json;
use std::collections::VecDeque;

#[derive(Default)]
struct Service {
    refreshes: VecDeque<Result<Refresh, String>>,
    arrivals: VecDeque<Option<Value>>,
    received: Vec<Vec<Value>>,
    events: Vec<String>,
}

impl Coordinator for Service {
    fn receive(&mut self, interval: Duration) -> Result<Option<Value>, String> {
        assert_eq!(interval, Duration::from_secs(60));
        Ok(self.arrivals.pop_front().expect("unexpected wait"))
    }
    fn refresh(&mut self, messages: &[Value]) -> Result<Refresh, String> {
        self.received.push(messages.to_vec());
        self.refreshes.pop_front().expect("extra refresh")
    }
    fn report(&mut self, _: &Refresh, finished: bool) -> Result<(), String> {
        self.events.push(format!("report {finished}"));
        Ok(())
    }
    fn acknowledge(&mut self, ids: &[String]) {
        self.events.push(format!("ack {}", ids.join(",")));
    }
}

fn idle() -> Refresh {
    Refresh {
        complete: false,
        actionable: false,
        claims_unavailable: false,
        settled: vec![],
    }
}

#[test]
fn waits_through_read_error_and_timeout_until_an_answer_is_printed() {
    let change = json!({"type":"changed","id":"a"});
    let answer = json!({"type":"answer","id":"b"});
    let mut service = Service::default();
    service.refreshes.extend([
        Err("read failed".into()),
        Ok(Refresh {
            settled: vec!["a".into()],
            ..idle()
        }),
        Ok(idle()),
        Ok(Refresh {
            actionable: true,
            settled: vec!["b".into()],
            ..idle()
        }),
    ]);
    let interval = Duration::from_secs(60);
    service.arrivals = VecDeque::from([None, Some(change.clone()), Some(answer.clone())]);
    let mut warnings = Vec::new();
    next(
        &mut service,
        true,
        interval,
        vec![change.clone(), change.clone()],
        &mut warnings,
    )
    .unwrap();
    assert_eq!(warnings, b"warn next: read failed\n");
    assert_eq!(
        service.received,
        [vec![change.clone()], vec![change], vec![], vec![answer]]
    );
    assert_eq!(
        service.events,
        [
            "report false",
            "ack a",
            "ack a",
            "report false",
            "report true",
            "ack b"
        ]
    );
}

#[test]
fn single_read_and_terminal_states_exit_without_sleeping() {
    for (wait, refresh) in [
        (false, idle()),
        (
            true,
            Refresh {
                complete: true,
                ..idle()
            },
        ),
        (
            true,
            Refresh {
                claims_unavailable: true,
                ..idle()
            },
        ),
    ] {
        let mut service = Service::default();
        service.refreshes.push_back(Ok(refresh));
        next(
            &mut service,
            wait,
            Duration::from_secs(1),
            vec![],
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(service.events, ["report true"]);
    }
}

#[test]
fn one_shot_errors_exit_without_retry() {
    let mut service = Service::default();
    service.refreshes.push_back(Err("snapshot failed".into()));
    let result = next(
        &mut service,
        false,
        Duration::from_secs(1),
        vec![],
        &mut Vec::new(),
    );
    assert_eq!(result, Err("snapshot failed".into()));
}
