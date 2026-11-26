//! A coordinator drives this blocking connection with send and wait.
use super::{Result, Settings, auth};
use crate::Credential;
use futures_util::{SinkExt, StreamExt};
use reqwest_websocket::{Message, RequestBuilderExt, WebSocket};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    runtime::{Builder, Runtime},
    time::timeout,
};

const OPEN_TIMEOUT: Duration = Duration::from_secs(3);

pub struct Link {
    url: url::Url,
    credential: Option<Credential>,
    project: String,
    session: String,
    hello: Value,
    replay: BTreeMap<String, Value>,
    socket: Option<WebSocket>,
    runtime: Runtime,
    http: reqwest::Client,
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
            runtime: Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| "cannot start link runtime")?,
            http: super::http_builder()?
                .http1_only()
                .build()
                .map_err(|_| "cannot initialize link transport")?,
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
        Message::Text(json!({"v":1,"type":kind,"id":format!("{}-{ticks}",self.session),
            "project":{"workspace":"","id":self.project},"at":chrono::Utc::now().to_rfc3339(),"payload":payload}).to_string())
    }
    async fn handshake(&self) -> Result<WebSocket> {
        for attempt in 0..4 {
            let mut request = self.http.get(self.url.clone());
            if let Some(token) = &self.credential {
                request = request.header("Authorization", token.clone().into_header());
            }
            let config =
                tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(1 << 22));
            let response = request
                .upgrade()
                .web_socket_config(config)
                .send()
                .await
                .map_err(|_| "link connection failed")?;
            if response.status().as_u16() == 503 && attempt < 3 {
                let pause = super::retry_delay(response.headers());
                drop(response);
                tokio::time::sleep(pause).await;
                continue;
            }
            if response.status().as_u16() != 101 {
                return Err(format!("link answered HTTP {}", response.status().as_u16()));
            }
            return response
                .into_websocket()
                .await
                .map_err(|_| "link handshake failed".into());
        }
        unreachable!()
    }
    /// Upgrade and disconnect before registering a coordinator session.
    pub(crate) fn probe(&self) -> Result<()> {
        self.runtime.block_on(async {
            timeout(OPEN_TIMEOUT, async {
                let socket = self.handshake().await?;
                socket
                    .close(reqwest_websocket::CloseCode::Normal, None)
                    .await
                    .map_err(|_| "link close failed".to_string())
            })
            .await
            .map_err(|_| "link handshake timed out")?
        })
    }
    async fn open(&self) -> Result<WebSocket> {
        let mut ws = self.handshake().await?;
        ws.send(self.frame("hello", &self.hello))
            .await
            .map_err(|_| "cannot send hello")?;
        for (kind, data) in &self.replay {
            ws.send(self.frame(kind, data))
                .await
                .map_err(|_| "cannot replay link state")?;
        }
        Ok(ws)
    }

    /// A sender opens a separate short-lived connection. Only the coordinator sends hello.
    /// A false return means the server did not answer a requested reply poll.
    pub fn send_agents(
        &self,
        payload: Value,
        deliver: impl FnOnce(&Value) -> Value,
    ) -> Result<bool> {
        let end = tokio::time::Instant::now() + Duration::from_secs(9);
        let mut socket = self.runtime.block_on(async {
            timeout(Duration::from_secs(5), self.handshake())
                .await
                .map_err(|_| "agents handshake timed out")?
        })?;
        let send = |ws: &mut WebSocket, msg: Message| {
            self.runtime.block_on(async {
                tokio::time::timeout_at(end, ws.send(msg))
                    .await
                    .map_err(|_| "agents send timed out")?
                    .map_err(|_| "agents send failed")
            })
        };
        send(&mut socket, self.frame("agents", &payload))?;
        if payload["replies"] != true {
            return Ok(true);
        }
        let received = self.runtime.block_on(async {
            timeout(Duration::from_secs(2), async {
                while let Some(frame) = socket.next().await {
                    match frame.map_err(|_| "agents receive failed")? {
                        Message::Text(text) => {
                            return serde_json::from_str::<Value>(&text)
                                .map_err(|_| "invalid agent-reply frame");
                        }
                        Message::Ping(_) => {
                            socket.flush().await.map_err(|_| "agents pong failed")?
                        }
                        Message::Close { .. } => break,
                        _ => (),
                    }
                }
                Err("agents connection closed")
            })
            .await
        });
        let Ok(received) = received else {
            return Ok(false);
        };
        let msg = received?;
        if msg["v"] == 1
            && msg["type"] == "agent-reply"
            && msg["project"]["id"] == self.project
            && msg["payload"]["id"]
                .as_str()
                .is_some_and(|id| (1..=200).contains(&id.chars().count()))
        {
            let outcome = deliver(&msg["payload"]);
            send(&mut socket, self.frame("agent-reply-result", &outcome))?;
        }
        Ok(true)
    }
    fn connect(&mut self) -> Result<()> {
        if self.socket.is_some() {
            return Ok(());
        }
        let now = Instant::now();
        if now < self.retry_at {
            return Err("link reconnect pending".into());
        }
        let opened = self
            .runtime
            .block_on(async { timeout(OPEN_TIMEOUT, self.open()).await })
            .unwrap_or_else(|_| Err("link timed out".into()));
        match opened {
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
        self.connect()?;
        if !(fresh && replayed) {
            let msg = self.frame(kind, &payload);
            let ws = self.socket.as_mut().ok_or("link closed")?;
            if !matches!(
                self.runtime
                    .block_on(async { timeout(OPEN_TIMEOUT, ws.send(msg)).await }),
                Ok(Ok(()))
            ) {
                self.disconnected(false);
                return Err("link send failed".into());
            }
        }
        Ok(())
    }
    /// Read the backlog sent in response to hello before computing one-shot decisions.
    pub(crate) fn initial_messages(&mut self) -> Result<Vec<Value>> {
        let mut messages = Vec::new();
        if self.connect().is_ok() {
            let deadline = Instant::now() + Duration::from_millis(100);
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                match self.wait(left.min(Duration::from_millis(50)))? {
                    Some(m) => messages.push(m),
                    None => break,
                }
            }
        }
        Ok(messages)
    }
    pub fn wait(&mut self, duration: Duration) -> Result<Option<Value>> {
        let end = Instant::now() + duration;
        while Instant::now() < end {
            if self.socket.is_none() && self.retry_at > Instant::now() {
                thread::sleep(
                    self.retry_at
                        .min(end)
                        .saturating_duration_since(Instant::now()),
                );
                continue;
            }
            // A short polling interval must not shorten the handshake or start a false backoff.
            if self.connect().is_err() {
                continue;
            }
            let ws = self.socket.as_mut().expect("connected link");
            let Some(left) = end.checked_duration_since(Instant::now()) else {
                break;
            };
            match self
                .runtime
                .block_on(async { timeout(left, ws.next()).await })
            {
                Err(_) => break,
                Ok(Some(Ok(Message::Text(text)))) => {
                    if let Ok(value) = serde_json::from_str::<Value>(&text)
                        && value["v"] == 1
                    {
                        return Ok(Some(value));
                    }
                }
                Ok(Some(Ok(Message::Close { code, .. }))) => {
                    self.disconnected(matches!(u16::from(code), 1012 | 4001))
                }
                Ok(Some(Ok(Message::Ping(_)))) => {
                    if !matches!(
                        self.runtime
                            .block_on(async { timeout(left, ws.flush()).await }),
                        Ok(Ok(()))
                    ) {
                        self.disconnected(false);
                    }
                }
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_)) | None) => self.disconnected(false),
            }
        }
        Ok(None)
    }
}
