use http::{HeaderValue, Request, Response};
use serde_json::json;
use std::{cell::RefCell, collections::VecDeque, time::Duration};
use wg::{
    ConfigProvider, Credential, CredentialProvider, HttpTransport,
    linear::{Client, Timing},
};

struct Fixture {
    replies: RefCell<VecDeque<Response<Vec<u8>>>>,
    waits: RefCell<Vec<Duration>>,
    requests: RefCell<Vec<serde_json::Value>>,
}

impl ConfigProvider for Fixture {
    type Settings = ();
    type Error = String;
    fn resolve(&self, workspace: &str) -> Result<(), String> {
        assert_eq!(workspace, "sample");
        Ok(())
    }
}
impl CredentialProvider for Fixture {
    type Error = String;
    fn credential(&self, workspace: &str, service: &str) -> Result<Option<Credential>, String> {
        assert_eq!((workspace, service), ("sample", "linear"));
        Ok(Some(Credential::new(HeaderValue::from_static(
            "sample-key",
        ))))
    }
}
impl HttpTransport for Fixture {
    type Error = String;
    fn send(&self, req: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
        assert_eq!(req.headers()["authorization"], "sample-key");
        self.requests
            .borrow_mut()
            .push(serde_json::from_slice(req.body()).unwrap());
        self.replies
            .borrow_mut()
            .pop_front()
            .ok_or("unexpected request".into())
    }
}
impl Timing for Fixture {
    fn now(&self) -> f64 {
        100.0
    }
    fn jitter(&self) -> f64 {
        0.0
    }
    fn sleep(&self, delay: Duration) {
        self.waits.borrow_mut().push(delay);
    }
}
#[test]
fn retries_refused_mutations_and_transient_queries_only() {
    for (doc, status, body, retry) in [
        ("mutation { write }", 429, json!({}), true),
        (
            "fragment F on Team {id} mutation { write }",
            503,
            json!({}),
            false,
        ),
        ("query { read }", 503, json!({}), true),
        (
            "mutation { write }",
            200,
            json!({"errors":[{"extensions":{"code":"RATELIMITED"},"path":["write"]}]}),
            false,
        ),
    ] {
        let failed = Response::builder()
            .status(status)
            .header("retry-after", "2")
            .body(body.to_string().into_bytes())
            .unwrap();
        let success = Response::new(br#"{"data":{"id":"fixture"}}"#.to_vec());
        let fixture = Fixture {
            replies: RefCell::new([failed, success].into()),
            waits: RefCell::default(),
            requests: RefCell::default(),
        };
        let mut client = Client::connect("sample", &fixture, &fixture, &fixture, &fixture).unwrap();
        let result = client.request(doc, json!({}));
        if retry {
            assert_eq!(result.unwrap(), json!({"id":"fixture"}));
            assert_eq!(
                fixture.waits.borrow().as_slice(),
                &[Duration::from_secs_f64(if status == 429 {
                    2.0
                } else {
                    0.5
                })]
            );
        } else {
            assert!(result.is_err());
            assert_eq!(fixture.replies.borrow().len(), 1);
        }
    }
}

#[test]
fn public_setup_matches_the_python_oracle() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/cli-parity/linear_setup.py");
    let result = std::process::Command::new("python3")
        .arg("-I")
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_wg"))
        .status()
        .unwrap();
    assert!(result.success());
}

fn fixture(replies: impl IntoIterator<Item = Response<Vec<u8>>>) -> Fixture {
    Fixture {
        replies: RefCell::new(replies.into_iter().collect()),
        waits: Default::default(),
        requests: Default::default(),
    }
}

#[test]
fn pagination_forwards_each_cursor_and_preserves_filters() {
    let pages = [(1, true, Some("second")), (2, false, None)].map(|(id, more, cursor)| {
        Response::new(
            json!({"data":{"team":{"labels":{"nodes":[{"id":id}],
            "pageInfo":{"hasNextPage":more,"endCursor":cursor}}}}})
            .to_string()
            .into_bytes(),
        )
    });
    let fixture = fixture(pages);
    let mut client = Client::connect("sample", &fixture, &fixture, &fixture, &fixture).unwrap();
    let rows = client.pages("query($id:String!,$after:String){team(id:$id){labels(first:100,after:$after){nodes{id} pageInfo{hasNextPage endCursor}}}}",json!({"id":"example"}),"/team/labels").unwrap();
    assert_eq!(rows, [json!({"id":1}), json!({"id":2})]);
    let calls = fixture.requests.borrow();
    assert_eq!(calls[0]["variables"], json!({"id":"example","after":null}));
    assert_eq!(
        calls[1]["variables"],
        json!({"id":"example","after":"second"})
    );
}

#[test]
fn complexity_refusals_wait_for_the_latest_exhausted_limit() {
    for (reset, expected_attempts) in [(106, 2), (165, 1)] {
        let refusal = Response::builder()
            .status(400)
            .header("retry-after", "2")
            .header("x-complexity", "90")
            .header("x-ratelimit-endpoint-complexity-remaining", "89")
            .header("x-ratelimit-endpoint-complexity-reset", reset.to_string())
            .body(
                json!({"errors":[{"extensions":{"code":"RATELIMITED"}}]})
                    .to_string()
                    .into_bytes(),
            )
            .unwrap();
        let fixture = fixture([
            refusal,
            Response::new(br#"{"data":{"updated":true}}"#.to_vec()),
        ]);
        let mut client = Client::connect("sample", &fixture, &fixture, &fixture, &fixture).unwrap();
        let result = client.request("mutation { update }", json!({}));
        assert_eq!(client.rate_limits["endpoint-complexity-remaining"], "89");
        assert_eq!(fixture.requests.borrow().len(), expected_attempts);
        if expected_attempts == 2 {
            assert_eq!(result.unwrap(), json!({"updated":true}));
            assert_eq!(*fixture.waits.borrow(), [Duration::from_secs(6)]);
        } else {
            assert!(result.unwrap_err().contains("65 s"));
            assert!(fixture.waits.borrow().is_empty());
        }
    }
}

#[test]
fn connection_loss_stops_mutations_and_bounds_read_retries() {
    for (doc, tries) in [("mutation { update }", 1), ("{ read }", 4)] {
        let fixture = fixture([]);
        let mut client = Client::connect("sample", &fixture, &fixture, &fixture, &fixture).unwrap();
        assert!(
            client
                .request(doc, json!({}))
                .unwrap_err()
                .contains("request failed")
        );
        assert_eq!(fixture.requests.borrow().len(), tries);
        if tries == 4 {
            assert_eq!(
                *fixture.waits.borrow(),
                [500, 1000, 2000].map(Duration::from_millis)
            );
        }
    }
}
