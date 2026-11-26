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
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "skills/work-graph/scripts"))
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


def main():
    candidate = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory() as home, fixture_service() as (network, _):
        config = Path(home) / "config.json"
        config.write_text(json.dumps({"workspaces": [{"id": "other", "team": "EX"},
                                                     {"id": "sample", "team": "WG", "key_env": ["FIXTURE_KEY"]}]}))
        env = dict(PATH=os.environ["PATH"], HOME=home, WG_CONFIG=str(config), WG_LINK="off",
                   FIXTURE_KEY="fixture-key", **network)
        expected = exercise([sys.executable, "-I", str(ROOT / "skills/work-graph/scripts/wg.py")], env, config)
        actual = exercise([candidate], env, config)
        for a, e in zip(actual, expected, strict=True):
            assert a == e, (a, e)


if __name__ == "__main__":
    try:
        main()
    finally:
        TEST_CONFIG.unlink()
        TEST_CONFIG.parent.rmdir()
