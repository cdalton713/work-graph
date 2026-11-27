"""Compare setup output, mutations and configuration against the Python command."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "reference"))
from services import Handler, fixture_service
from test_wg import SetupTests, TEST_CONFIG


def exercise(command, env, config):
    fake = SetupTests()
    fake.setUp()
    before = config.read_bytes()

    def post(handler):
        if (handler.headers.get("Authorization") != "fixture-key" or
                handler.headers.get("Host") != "api.linear.app" or handler.path != "/graphql"):
            handler.send_error(403)
            return
        body = json.loads(handler.rfile.read(int(handler.headers["Content-Length"])))
        data = fake.linear(body["query"], body["variables"])
        handler.reply({"data": data})

    results = []
    with patch.object(Handler, "do_POST", post):
        for scenario in ("dry", "absent parent", "wrong created parent", "apply", "repeat", "existing mismatch"):
            fake.writes.clear()
            if scenario == "existing mismatch":
                fake.team["parent"] = None
            if scenario == "apply":
                fake.setUp()
            if scenario == "wrong created parent":
                fake.created_parent = None
            args = ["setup", "--workspace", "sample", "--name", "Fixture", "--private",
                    "--parent", "absent" if scenario == "absent parent" else "root"]
            if scenario != "dry":
                args.append("--apply")
            run = subprocess.run(command + args, env=env, capture_output=True, text=True, timeout=45)
            expected_code = 2 if scenario in ("absent parent", "wrong created parent") else 0
            assert run.returncode == expected_code, (scenario, run.stderr)
            assert config.read_bytes() == before
            results.append((scenario, run.stdout, run.stderr, list(fake.writes)))
    return results


def check_routing(command, env, config):
    # Stop on the first team lookup. Record the credential and team actually sent.
    requests = []

    def lookup(handler):
        body = json.loads(handler.rfile.read(int(handler.headers["Content-Length"])))
        requests.append((handler.headers.get("Authorization"), body["variables"]["k"]))
        handler.reply({"data": {"teams": {"nodes": []}}})

    first = {"id": "first-id", "team": "ONE", "key_env": ["KEY_A", "KEY_B"]}
    config.write_text(json.dumps({"workspaces": [first, {"id": "other", "team": "TWO"}]}))
    key_path = Path(env["HOME"]) / ".config/work-graph/first-id-linear-api-key"
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_text(" file-key\n")
    key_path.chmod(0o644)
    with patch.object(Handler, "do_POST", lookup):
        for credentials, args, expected in [
            ({"LINEAR_FIRST_ID_API_KEY": " primary ", "KEY_A": "a"}, [], ("primary", "ONE")),
            ({"KEY_A": "a", "KEY_B": "b"}, [], ("a", "ONE")),
            ({"KEY_A": " ", "KEY_B": "b"}, [], ("b", "ONE")),
            ({}, [], ("file-key", "ONE")),
            ({"LINEAR_API_KEY": "global"}, ["--workspace", "other"], ("global", "TWO")),
        ]:
            requests.clear()
            run = subprocess.run(command + ["setup", "--apply", *args], env=env | credentials,
                                 capture_output=True, text=True, timeout=10)
            assert run.returncode == 2 and "needs a name" in run.stderr, run.stderr
            assert requests == [expected], requests
            assert ("set mode 600" in run.stderr) == (expected[0] == "file-key"), run.stderr

        key_path.unlink()
        for args, message in [([], "no Linear key for first-id: set LINEAR_FIRST_ID_API_KEY"),
                              (["--workspace", "absent"], "unknown workspace absent")]:
            requests.clear()
            run = subprocess.run(command + ["setup", *args], env=env, capture_output=True, text=True, timeout=10)
            assert run.returncode == 2 and message in run.stderr and not requests, run.stderr


def check_rejected_inputs(command, env, config):
    requests = []

    def unexpected(handler):
        requests.append(handler.path)
        handler.send_error(403)

    with patch.object(Handler, "do_POST", unexpected):
        for data, args, message in [
            ([], [], "config must be a JSON object"),
            ({"human": "Wrong!"}, [], "human must be a name"),
            ({"workspaces": {}}, [], "workspaces must be an array"),
            ({}, ["--private", "--no-private"], "cannot be used together"),
            ({}, ["--no-private", "--private"], "cannot be used together"),
            ({}, ["--parent", "-h"], "expected one argument"),
        ]:
            config.write_text(json.dumps(data))
            run = subprocess.run(command + ["setup", "--apply", "--team", "WG", *args], env=env,
                                 capture_output=True, text=True, timeout=10)
            assert run.returncode and message in run.stderr and not requests, (run.stderr, requests)


def main():
    candidate = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory() as home, fixture_service() as (network, _):
        config = Path(home) / "config.json"
        config.write_text(json.dumps({"workspaces": [{"id": "other", "team": "EX"},
                                                     {"id": "sample", "team": "WG", "key_env": ["FIXTURE_KEY"], "team_labels": 0}]}))
        env = dict(PATH=os.environ["PATH"], HOME=home, WG_CONFIG=str(config), WG_LINK="off",
                   FIXTURE_KEY="fixture-key", **network)
        expected = exercise([sys.executable, "-I", str(HERE / "reference/wg.py")], env, config)
        actual = exercise([candidate], env, config)
        for a, e in zip(actual, expected, strict=True):
            assert a == e, (a, e)
        for command in ([sys.executable, "-I", str(HERE / "reference/wg.py")], [candidate]):
            check_routing(command, env, config)
        check_rejected_inputs([candidate], env, config)


if __name__ == "__main__":
    try:
        main()
    finally:
        TEST_CONFIG.unlink()
        TEST_CONFIG.parent.rmdir()
