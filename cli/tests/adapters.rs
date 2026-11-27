use http::{HeaderValue, Request, Response, StatusCode, Uri, header::AUTHORIZATION};
use std::convert::Infallible;
use wg::{ConfigProvider, Credential, CredentialProvider, HttpTransport};

struct Fixture;

impl ConfigProvider for Fixture {
    type Settings = Uri;
    type Error = &'static str;

    fn resolve(&self, workspace: &str) -> Result<Uri, Self::Error> {
        match workspace {
            "sample" => Ok(Uri::from_static("/sample/status")),
            _ => Err("unknown workspace"),
        }
    }
}

impl CredentialProvider for Fixture {
    type Error = Infallible;

    fn credential(&self, workspace: &str, service: &str) -> Result<Option<Credential>, Infallible> {
        Ok((workspace == "sample" && service == "page")
            .then(|| Credential::new(HeaderValue::from_static("fixture-token"))))
    }
}

impl HttpTransport for Fixture {
    type Error = Infallible;

    fn send(&self, request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, Infallible> {
        assert_eq!(request.uri().path(), "/sample/status");
        assert_eq!(request.headers()[AUTHORIZATION], "fixture-token");
        assert!(!format!("{request:?}").contains("fixture-token"));
        Ok(Response::builder().status(429).body(Vec::new()).unwrap())
    }
}

#[test]
fn adapter_can_use_fixture_providers_and_inspect_http_failures() {
    let config: &dyn ConfigProvider<Settings = Uri, Error = &'static str> = &Fixture;
    let credentials: &dyn CredentialProvider<Error = Infallible> = &Fixture;
    let transport: &dyn HttpTransport<Error = Infallible> = &Fixture;
    assert!(credentials.credential("other", "page").unwrap().is_none());
    assert!(credentials.credential("sample", "other").unwrap().is_none());

    let credential = credentials.credential("sample", "page").unwrap().unwrap();
    assert!(!format!("{credential:?}").contains("fixture-token"));
    let request = Request::get(config.resolve("sample").unwrap())
        .header(AUTHORIZATION, credential.into_header())
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        transport.send(request).unwrap().status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}
