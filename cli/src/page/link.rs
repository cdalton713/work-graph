//! A coordinator drives this blocking connection with send and wait.
use super::{Result, Settings, auth};
use crate::Credential;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::ErrorKind,
    net::{TcpStream, ToSocketAddrs},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{Error, Message, WebSocket, client::IntoClientRequest, stream::MaybeTlsStream};

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

pub struct Link {
    url: url::Url,
    credential: Option<Credential>,
    project: String,
    session: String,
    hello: Value,
    replay: BTreeMap<String, Value>,
    socket: Option<Socket>,
    retry_at: Instant,
    opened: Instant,
    quick_closes: u32,
    grace: Option<Instant>,
    delay: u64,
}
impl Link {
    /// The caller obtains the credential for this page and membership with its scoped provider.
    pub fn new(
        settings: &Settings,
        page: &str,
        workspace: &str,
        project: &str,
        session: &str,
        hello: Value,
        credential: Option<Credential>,
    ) -> Result<Self> {
        let mut url = auth::validated_url(page.trim_end_matches('/'), settings)?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| "invalid WebSocket URL")?;
        url.path_segments_mut()
            .map_err(|_| "invalid link path")?
            .pop_if_empty()
            .extend(["api", "link"]);
        url.query_pairs_mut().extend_pairs([
            ("role", "coordinator"),
            ("workspace", workspace),
            ("project", project),
        ]);
        let now = Instant::now();
        Ok(Self {
            url,
            credential,
            project: project.into(),
            session: session.into(),
            hello,
            replay: BTreeMap::new(),
            socket: None,
            retry_at: now,
            opened: now,
            quick_closes: 0,
            grace: None,
            delay: 1,
        })
    }
    fn frame(&self, kind: &str, payload: &Value) -> Message {
        let ticks = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Message::text(json!({"v":1,"type":kind,"id":format!("{}-{ticks}",self.session),
            "project":{"workspace":"","id":self.project},"at":chrono::Utc::now().to_rfc3339(),"payload":payload}).to_string())
    }
    fn open(&self, deadline: Instant) -> Result<Socket> {
        let host = self
            .url
            .host_str()
            .ok_or("invalid link host")?
            .trim_matches(['[', ']']);
        let port = self
            .url
            .port_or_known_default()
            .ok_or("invalid link port")?;
        let addresses: Vec<_> = (host, port)
            .to_socket_addrs()
            .map_err(|_| "cannot resolve link host")?
            .collect();
        for attempt in 0..4 {
            let stream = addresses
                .iter()
                .find_map(|addr| {
                    TcpStream::connect_timeout(
                        addr,
                        deadline.saturating_duration_since(Instant::now()),
                    )
                    .ok()
                })
                .ok_or("link connection failed")?;
            let budget = deadline
                .checked_duration_since(Instant::now())
                .ok_or("link timed out")?;
            stream
                .set_read_timeout(Some(budget))
                .and_then(|_| stream.set_write_timeout(Some(budget)))
                .map_err(|_| "cannot set link timeout")?;
            let mut req = self
                .url
                .as_str()
                .into_client_request()
                .map_err(|_| "invalid link URL")?;
            if let Some(value) = &self.credential {
                req.headers_mut()
                    .insert("Authorization", value.clone().into_header());
            }
            let config =
                tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(1 << 22));
            let mut ws = match tungstenite::client_tls_with_config(req, stream, Some(config), None)
            {
                Ok((ws, _)) => ws,
                Err(tungstenite::HandshakeError::Failure(Error::Http(r))) => {
                    let pause = super::retry_delay(r.headers());
                    if r.status().as_u16() == 503
                        && attempt < 3
                        && Instant::now() + pause < deadline
                    {
                        thread::sleep(pause);
                        continue;
                    }
                    return Err(format!("link answered HTTP {}", r.status().as_u16()));
                }
                Err(_) => return Err("link handshake failed".into()),
            };
            ws.send(self.frame("hello", &self.hello))
                .map_err(|_| "cannot send hello")?;
            for (kind, data) in &self.replay {
                ws.send(self.frame(kind, data))
                    .map_err(|_| "cannot replay link state")?;
            }
            return Ok(ws);
        }
        unreachable!()
    }
    fn connect(&mut self, deadline: Instant) -> Result<()> {
        if self.socket.is_some() {
            return Ok(());
        }
        let now = Instant::now();
        if now < self.retry_at {
            return Err("link reconnect pending".into());
        }
        match self.open(deadline.min(now + Duration::from_secs(10))) {
            Ok(ws) => {
                self.opened = Instant::now();
                self.socket = Some(ws);
                self.grace = None;
                Ok(())
            }
            Err(e) => {
                let now = Instant::now();
                self.retry_at = if let Some(end) = self.grace.filter(|end| *end > now) {
                    let retry = (now + Duration::from_secs(self.delay)).min(end);
                    self.delay = (self.delay * 2).min(5);
                    retry
                } else {
                    self.quick_closes = 0;
                    now + Duration::from_secs(30)
                };
                Err(e)
            }
        }
    }
    fn disconnected(&mut self, planned: bool) {
        self.socket = None;
        let now = Instant::now();
        if planned {
            self.quick_closes = if self.opened.elapsed() < Duration::from_secs(10) {
                (self.quick_closes + 1).min(7)
            } else {
                0
            };
            let delay = if self.quick_closes < 2 {
                0
            } else {
                (1u64 << (self.quick_closes - 2)).min(30)
            };
            self.retry_at = now + Duration::from_secs(delay);
            self.grace = Some(self.retry_at + Duration::from_secs(15));
            self.delay = 1;
        } else {
            self.quick_closes = 0;
            self.retry_at = now + Duration::from_secs(5);
        }
    }
    pub fn send(&mut self, kind: &str, payload: Value) -> Result<()> {
        let fresh = self.socket.is_none();
        let replayed = matches!(kind, "state" | "asks" | "progress");
        if replayed {
            self.replay.insert(kind.into(), payload.clone());
        }
        self.connect(Instant::now() + Duration::from_secs(10))?;
        if !(fresh && replayed) {
            let msg = self.frame(kind, &payload);
            if self
                .socket
                .as_mut()
                .ok_or("link closed")?
                .send(msg)
                .is_err()
            {
                self.disconnected(false);
                return Err("link send failed".into());
            }
        }
        Ok(())
    }
    pub fn wait(&mut self, timeout: Duration) -> Result<Option<Value>> {
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            if self.socket.is_none() && self.retry_at > Instant::now() {
                thread::sleep(
                    self.retry_at
                        .min(end)
                        .saturating_duration_since(Instant::now()),
                );
                continue;
            }
            self.connect(end)?;
            let ws = self.socket.as_mut().ok_or("link closed")?;
            let stream = match ws.get_ref() {
                MaybeTlsStream::Plain(stream) => stream,
                MaybeTlsStream::Rustls(tls) => &tls.sock,
                _ => return Err("unsupported link transport".into()),
            };
            let Some(left) = end.checked_duration_since(Instant::now()) else {
                break;
            };
            stream
                .set_read_timeout(Some(left))
                .map_err(|_| "cannot set link timeout")?;
            match ws.read() {
                Ok(Message::Text(msg)) => {
                    if let Ok(value) = serde_json::from_str::<Value>(&msg)
                        && value["v"] == 1
                    {
                        return Ok(Some(value));
                    }
                }
                Ok(Message::Close(reason)) => {
                    let planned = reason.is_some_and(|f| matches!(u16::from(f.code), 1012 | 4001));
                    let _ = ws.flush();
                    self.disconnected(planned);
                }
                Ok(Message::Ping(_)) => ws.flush().map_err(|_| "cannot send pong")?,
                Ok(_) => {}
                Err(Error::Io(e))
                    if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) =>
                {
                    return Ok(None);
                }
                Err(_) => self.disconnected(false),
            }
        }
        Ok(None)
    }
}
