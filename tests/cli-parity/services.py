"""Loopback HTTPS fixture. Answer the two fixture hosts without forwarding traffic."""
import json
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import ssl
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_CONNECT(self):
        if self.path not in {"api.linear.app:443", "page.invalid:443"}:
            self.send_error(403)
            return
        self.send_response_only(200)
        self.end_headers()
        with self.server.context.wrap_socket(self.connection, server_side=True) as secure:
            Handler(secure, self.client_address, self.server)

    def reply(self, data):
        payload = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        pages = {"/api/config": {"auth": True},
                 "/api/status": {"workspaces": [{"id": "default", "name": "Example"}]}}
        if self.headers.get("Host") != "page.invalid" or self.path not in pages:
            self.send_error(404)
        elif self.headers.get("Authorization") != "Bearer fixture-token":
            self.send_error(401)
        else:
            self.server.events.append(["GET", self.path])
            self.reply(pages[self.path])

    def do_POST(self):
        if self.headers.get("Host") != "api.linear.app" or self.path != "/graphql":
            self.send_error(404)
            return
        if self.headers.get("Authorization") != "fixture-key":
            self.send_error(401)
            return
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        variables = request["variables"]
        query = request["query"]
        if "commentCreate(" in query:
            self.server.events.append(["commentCreate", variables["i"]])
            data = {"commentCreate": {"success": True, "comment": {"id": "new-card"}}}
        elif "project(" in query and "labels(" in query:
            self.server.events.append(["project.labels", variables["id"]])
            labels = [{"name": "supervised", "parent": {"name": "autonomy"}}]
            data = {"project": {"labels": {"nodes": labels}}}
        else:
            self.send_error(400)
            return
        self.reply({"data": data})


@contextmanager
def fixture_service():
    with TemporaryDirectory() as temp:
        cert = Path(temp) / "cert.pem"
        key = Path(temp) / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-days", "1", "-subj", "/CN=parity fixture",
                        "-addext", "subjectAltName=DNS:api.linear.app,DNS:page.invalid",
                        "-addext", "basicConstraints=critical,CA:TRUE",
                        "-addext", "keyUsage=critical,digitalSignature,keyCertSign",
                        "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            server.context = context
            server.events = []
            thread = Thread(target=server.serve_forever)
            thread.start()
            try:
                proxy = f"http://127.0.0.1:{server.server_port}"
                yield {"https_proxy": proxy, "SSL_CERT_FILE": str(cert),
                       "LINEAR_DEFAULT_API_KEY": "fixture-key"}, server.events
            finally:
                server.shutdown()
                thread.join()
