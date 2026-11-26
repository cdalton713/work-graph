"""Run the reference and preview in separate, private copies of a synthetic effort."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parents[1] / "skills/work-graph/scripts/wg.py"
BINARY = Path(sys.argv[1]).resolve()


def write(path, data):
    path.write_text(json.dumps(data))


def snapshot(root):
    result = {}
    for path in sorted(root.iterdir()):
        if path.is_file():
            data = path.read_bytes()
            if path.name == "journal.jsonl":
                data = re.sub(rb'("time": ")\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', rb'\1<time>', data)
            result[path.name] = (stat.S_IMODE(path.stat().st_mode), data)
    return result


class Pair:
    def __init__(self, root):
        self.dirs = [root / "reference", root / "native"]
        for directory in self.dirs:
            shutil.copytree(HERE / "fixture", directory)
        self.bin = root / "bin"
        self.bin.mkdir()
        gh = self.bin / "gh"
        gh.write_text("""#!/bin/sh
echo "$@" >> calls
case "$5" in
headRefOid) echo '{"headRefOid":"abc"}' ;;
reviews,comments) echo '{"reviews":[{"body":"checked"}],"comments":[{"body":"@claude-thorough"}]}' ;;
*) exit 1 ;;
esac
""")
        gh.chmod(0o755)
        git = self.bin / "git"
        git.write_text("#!/bin/sh\necho 'src/[note'\n")
        git.chmod(0o755)

    def compare(self, *args):
        observed = []
        for root, command in zip(self.dirs, ([sys.executable, "-I", str(SCRIPT)], [str(BINARY)])):
            result = subprocess.run(
                [*command, *args], cwd=root, capture_output=True,
                env={"PATH": str(self.bin), "HOME": str(root), "WG_CONFIG": "config",
                     "COLUMNS": "80", "NO_COLOR": "1", "LC_ALL": "C", "WG_LINK": "off"},
            )
            observed.append((result.returncode, result.stdout, result.stderr, snapshot(root)))
        for field, a, b in zip(("exit", "stdout", "stderr", "files"), *observed):
            assert a == b, (args, field, a, b)

    def journal(self, entries):
        for root in self.dirs:
            (root / "journal.jsonl").write_text("".join(json.dumps(e) + "\n" for e in entries))


def input_cases(pair):
    for s in ["2026-01-01T09:00Z", "20260101T0900+00", "2026-W01-4 09Z",
              "20260101T090000,123456789Z", "bogus", "2026-01-01", "2026-01-01T10:00+01:00"]:
        pair.compare("run", "set", ".", "merge", "soak_until=" + s)
    for d in pair.dirs:
        shutil.copyfile(HERE / "fixture/journal.jsonl", d / "journal.jsonl")
    for s in ["2026-01-01T09:00", " 2h", "1d12h ", "20260101", "bogus"]:
        pair.compare("log", ".", "--since=" + s)
    pair.compare("log", ".", "--tim")
    pair.compare("log", ".", "-n", "0")
    pair.compare("log", ".", "-n", "oops")
    # 3.12 changed argparse to accept this trailing positional. Pin the reviewed
    # 3.11 behavior even on runners with a newer reference interpreter.
    if sys.version_info < (3, 12):
        pair.compare("log", ".", "-n", "1", "a")
    else:
        root = pair.dirs[1]
        before = snapshot(root)
        result = subprocess.run([str(BINARY), "log", ".", "-n", "1", "a"], cwd=root,
                                env={"HOME": str(root), "WG_CONFIG": "config"}, capture_output=True)
        assert result.returncode == 2 and not result.stdout
        assert result.stderr.endswith(b"wg.py: error: unrecognized arguments: a\n")
        assert snapshot(root) == before
    pair.compare("run", "set", ".", "merge", "invalid")


def review_cases(pair):
    def change(*fields):
        pair.compare("run", "set", ".", "merge", *fields)

    pair.compare("run", "set", ".", "@effort", "review_seen=standard")
    change("pr=7", "patch=one", "code_done_head=old", "review_dispatch=job")
    change("review=clean")
    change("code_done_head=abc", "patch=two", "review=accepted")
    change("code_done_head=abc", "review=accepted")
    change("merge_review=requested")
    change("merge_review=clean")
    change("merge_review=requested")
    change("merge_review=requested")
    change("thorough_count=bogus", "merge_review=requested")
    pair.compare("run", "reset", ".", "merge")


def unicode_keymap_hashes(pair):
    for root in pair.dirs:
        path = root / "keymap.json"
        data = json.loads(path.read_bytes())
        data["extra"]["label"] = "café 🎨"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    for args in (("set", ".", "merge", "note=résumé 📝"), ("reset", ".", "merge")):
        pair.compare("run", *args)
        files = [(root / "keymap.json").read_bytes() for root in pair.dirs]
        assert files[0] == files[1]
        assert hashlib.sha256(files[0]).digest() == hashlib.sha256(files[1]).digest()
        assert files[0].isascii()
        result = json.loads(files[0])
        assert result["extra"]["label"] == "café 🎨"
        if args[0] == "set":
            assert result["run"]["nodes"]["merge"]["note"] == "résumé 📝"
        else:
            assert "merge" not in result["run"]["nodes"]


def graph_cases(pair):
    for d in pair.dirs:
        p = json.loads((d / "plan.json").read_text())
        p["phases"] *= 2
        p["nodes"][0].update(title=5, owns=["src/[note"], issue="it's")
        p["effort"]["agents"] = {"worker": {"model": "a\u200bb"}}
        write(d / "plan.json", p)
    pair.compare("check", ".")
    pair.compare("owns", "diff", ".", "a", "main")
    for d in pair.dirs:
        write(d / "config", {"human": "It's"})
    pair.compare("check", ".")


def rebuild_cases(pair):
    def baseline(rows):
        return {"kind": "baseline", "run": rows, "changes": {}, "time": "2020-01-01"}
    for d in pair.dirs:
        p = json.loads((d / "plan.json").read_text())
        p["nodes"][0]["key"] = "1"
        write(d / "plan.json", p)
    pair.journal([baseline({"effort": {"a": "b"}, "nodes": {"1": {"state": "go"}}, "extra": True})])
    pair.compare("run", "rebuild", ".", "--apply")
    pair.journal([baseline({"nodes": {"1": "x"}}), {"time": "2020-01-02", "key": "1", "changes": {"x": [None, 1]}}])
    pair.compare("run", "rebuild", ".", "--apply")
    pair.journal([
        {"time": "2020-01-02", "key": "1", "changes": {"job":[None,"dispatch"],"started_at":[None,""]}},
        {"time": "2020-01-03", "key": "1", "changes": {"started_at":["","yes"]}},
        {"time": "2020-01-02", "key": "1", "changes": {"code_done_head":[None,"abc"],"other":[[],{"k":None}]}},
    ])
    pair.compare("log", ".", "--times")
    pair.compare("log", ".")


for check in (input_cases, review_cases, unicode_keymap_hashes, graph_cases, rebuild_cases):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        check(Pair(root))
