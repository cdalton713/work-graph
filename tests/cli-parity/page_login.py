"""Run the compiled login with a private CA and with an unrelated trust anchor."""
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
from threading import Thread
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import suite
from services import Handler


def openssl(directory, *args):
    subprocess.run(["openssl", *args], cwd=directory, check=True, capture_output=True)


def ca(directory, name):
    config = directory / f"{name}.cnf"
    config.write_text(f"""[req]
distinguished_name = dn
prompt = no
x509_extensions = ca
[dn]
CN = {name}
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign
""")
    openssl(directory, "req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-days", "1", "-config", str(config), "-keyout", f"{name}.key", "-out", f"{name}.pem")


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], ssl.SSLError):
            super().handle_error(request, client_address)


@contextmanager
def service(directory):
    server = Server(("127.0.0.1", 0), Handler)
    server.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.context.load_cert_chain(directory / "page.pem", directory / "page.key")
    server.events = []
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        yield {"https_proxy": f"http://127.0.0.1:{server.server_port}",
               "SSL_CERT_FILE": str(directory / "trusted.pem")}, server.events
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def main(candidate):
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        ca(directory, "trusted")
        ca(directory, "unrelated")
        extensions = directory / "extensions.cnf"
        extensions.write_text("basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n"
                              "subjectAltName=DNS:page.invalid\nkeyUsage=digitalSignature,keyEncipherment\n")
        openssl(directory, "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=page.invalid",
                "-keyout", "page.key", "-out", "page.csr")
        openssl(directory, "x509", "-req", "-in", "page.csr", "-CA", "trusted.pem", "-CAkey", "trusted.key",
                "-set_serial", "2", "-days", "1", "-extfile", str(extensions), "-out", "page.pem")
        case = "service | login https://page.invalid --token-stdin"
        args = case.split()[2:]
        with patch.object(suite, "fixture_service", lambda: service(directory)):
            actual = suite.run_case([candidate], args, service=True)
        assert actual == json.loads((suite.HERE / "expected.json").read_text())[case], actual
        with service(directory) as (env, events):
            home = directory / "home"
            home.mkdir()
            result = subprocess.run([candidate, *args], input="fixture-token\n", capture_output=True, text=True,
                                    timeout=15, env=env | {"HOME": str(home), "SSL_CERT_FILE": str(directory / "unrelated.pem")})
            assert result.returncode == 2 and not result.stdout and not events
            assert list(home.iterdir()) == []


if __name__ == "__main__":
    main(sys.argv[1])
