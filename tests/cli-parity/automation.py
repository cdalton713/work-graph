"""Exercise native scheduled commands in a temporary home with recorded process arguments."""
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
BIN = Path(sys.argv[1]).resolve()


def run():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        home = root / "user home"
        tools = root / "bin"
        home.mkdir()
        tools.mkdir()
        effort = root / "sample 'effort'-core"
        shutil.copytree(HERE / "fixture", effort)
        plan = effort / "plan.json"
        data = json.loads(plan.read_text())
        data["effort"]["slug"] = "sample"
        plan.write_text(json.dumps(data))
        calls = root / "calls.jsonl"
        check_tree = root / "check"
        check_tree.mkdir()
        config = home / "config.json"
        config.write_text(json.dumps({"github_user": "fixture"}))
        stub = tools / "orca"
        stub.write_text(f"#!{sys.executable}\n" + """
import os, sys, json
from pathlib import Path
args = sys.argv[1:]
with Path(os.environ["CALLS"]).open("a") as f:
    print(json.dumps(args), file=f)
if args[:2] == ["agent", "installed"]:
    result = {"agents":[{"id":"codex","default":True}]}
elif args[:2] == ["worktree", "show"]:
    result = {"worktree":{"id":"core"}}
elif args[:2] == ["worktree", "list"]:
    result = {"worktrees":[{"id":"repo::core","path":os.environ["PLAN"]}]}
elif args[:2] == ["worktree", "create"]:
    result = {"worktree":{"id":"health","path":os.environ["CHECK"]}}
elif args[:2] == ["automations", "create"]:
    result = {"automation":{"id":"schedule"}}
elif args[:2] in (["automations","edit"],["automations","remove"]):
    result = {}
elif args[:2] == ["automations","show"]:
    result = {"automation":{"enabled":False}}
else:
    sys.exit(1)
print(json.dumps({"ok":True,"result":result}))
""")
        stub.chmod(0o755)
        gh = tools / "gh"
        gh.write_text(f"#!{sys.executable}\n" + """
import os, sys
assert sys.argv[1:] == ["api","--hostname","github.com","user","--jq",".login"]
assert not any(k in os.environ for k in ["GH_TOKEN","GITHUB_TOKEN","GH_CONFIG_DIR"])
assert os.environ["GH_PROMPT_DISABLED"] == "1"
print("fixture")
""")
        gh.chmod(0o755)
        env = {"HOME": str(home), "PATH": str(tools), "WG_CONFIG": str(config),
               "CALLS": str(calls), "ORCA_CLI_COMMAND": str(stub), "PLAN": str(effort),
               "CHECK": str(check_tree), "GH_TOKEN": "fixture", "GH_CONFIG_DIR": "fixture"}

        def cli(*args, code=0):
            result = subprocess.run([BIN, *args], capture_output=True, text=True, env=env,
                                    cwd=root, timeout=10)
            assert result.returncode == code, (args, result)
            return result.stdout

        def events():
            return [json.loads(line) for line in calls.read_text().splitlines()]

        def row():
            return json.loads((effort / "keymap.json").read_text())["run"]["effort"]

        cli("tick", "--install", "--root", effort, "--channel", "none")
        plist = next((home / "Library/LaunchAgents").glob("*.plist"))
        data = plistlib.loads(plist.read_bytes())
        assert data["ProgramArguments"] == [str(BIN), "tick", "--channel", "none", "--root", str(effort)]
        assert data["StartCalendarInterval"] == [{"Minute": i} for i in [0, 15, 30, 45]]
        assert Path(data["StandardOutPath"]).parent.is_dir()
        cli("tick", "--uninstall")
        assert not plist.exists()
        cli("autostart", effort, "--install", "--agent", "codex", "--model", "x", "--effort", "high")
        args = events()[-1]
        precheck = shlex.split(args[args.index("--precheck") + 1])
        assert precheck[-3:] == [str(BIN), "wake", str(effort)]
        assert args[args.index("--trigger") + 1] == "*/5 * * * *"
        assert "--extra-agent-args=--model x -c model_reasoning_effort=high" in args
        assert row()["autostart"] == "schedule"
        cli("autostart", effort, "--install")
        assert events()[-1][:3] == ["automations", "edit", "schedule"]
        assert "autostart_configured" not in row()
        assert "disabled" in cli("autostart", effort)
        cli("autostart", effort, "--uninstall")
        assert "autostart" not in row()
        assert cli("health", effort) == "health off; no check yet\n"
        cli("health", effort, "--install")
        args = events()[-1]
        assert shlex.split(args[args.index("--precheck") + 1])[-4:] == [str(BIN), "health", str(effort), "--due"]
        assert args[args.index("--trigger") + 1] == "0 * * * *"
        assert row()["health_worktree"] == str(check_tree)
        cli("health", effort, "--uninstall")
        assert "health_automation" not in row() and row()["health_worktree"] == str(check_tree)
        cli("health", effort, "--due", "--install", code=2)
        cli("watch", effort, "--interval", "-1", code=2)


if __name__ == "__main__":
    run()
