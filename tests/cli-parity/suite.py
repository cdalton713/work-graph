"""Run public CLI cases against recorded process and file results."""
import difflib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
SKILL = HERE.parents[1] / "skills/work-graph"
REFERENCE = [sys.executable, "-I", str(SKILL / "scripts/wg.py")]


def files(root):
    return {str(p.relative_to(root)): (stat.S_IMODE(p.stat().st_mode), p.read_text())
            for p in root.rglob("*") if p.is_file()}


def run_case(command, args):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory).resolve()
        shutil.copytree(HERE / "fixture", root / "effort")
        for name in ("home", "empty", "bin"):
            (root / name).mkdir()
        # External programs cannot see the local account or repositories.
        for tool in ("git", "gh", "st", "orca", "orca-ide"):
            stub = root / "bin" / tool
            shutil.copyfile(HERE / "tool.sh", stub)
            stub.chmod(0o755)
        env = {"HOME": str(root / "home"), "PATH": str(root / "bin"),
               "WG_CONFIG": str(root / "home/config.json"), "WG_LINK": "off",
               "LC_ALL": "C", "COLUMNS": "80", "NO_COLOR": "1",
               "http_proxy": "http://127.0.0.1:1", "https_proxy": "http://127.0.0.1:1"}
        before = files(root)
        result = subprocess.run(command + args, cwd=root, env=env, input="",
                                capture_output=True, text=True, timeout=15)
        if "Traceback (most recent call last)" in result.stderr:
            raise RuntimeError(f"{args}: {result.stderr}")

        def normalize(value):
            value = value.replace(str(root), "<sandbox>").replace(str(SKILL), "<skill>")
            value = re.sub(r'("time": ")\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', r'\1<time>', value)
            return value.replace("usage: wg.py ", "usage: wg ").replace("wg.py:", "wg:")

        after = files(root)
        changes = {}
        for name in sorted(before.keys() | after.keys()):
            if before.get(name) != after.get(name):
                changes[name] = ([oct(after[name][0]), normalize(after[name][1])]
                                 if name in after else None)
        return {"exit": result.returncode, "stdout": normalize(result.stdout),
                "stderr": normalize(result.stderr), "files": changes}


def main():
    os.umask(0o022)
    record = sys.argv[1:] == ["--record"]
    if len(sys.argv) > 2:
        sys.exit("usage: run.sh [PATH-TO-WG | --record]")
    command = REFERENCE if record or len(sys.argv) == 1 else [str(Path(sys.argv[1]).resolve(strict=True))]
    cases = [line for line in (HERE / "cases.txt").read_text().splitlines()
             if line and not line.startswith("#")]
    for group in ("", "run", "owns"):
        help_result = run_case(command, group.split() + ["--help"])
        choices = re.search(r"\{([\w,-]+)\}", help_result["stdout"])
        paths = [line.split() for line in cases if not group or line.startswith(group + " ")]
        listed = {path[len(group.split())] for path in paths}
        if not choices or set(choices[1].split(",")) != listed:
            sys.exit(f"Update cases.txt for the verbs in {group or 'root'} help:\n{help_result['stdout']}")
    observed = {}
    verbs = {tuple(case.split()[:2] if case.split()[0] in {"owns", "run"} else case.split()[:1])
             for case in cases}
    for verb in sorted(verbs):
        help_result = run_case(command, [*verb, "--help"])
        if help_result["exit"] or help_result["stderr"] or help_result["files"]:
            sys.exit(f"{verb} help failed: {help_result}")
        flags = re.findall(r"(?<![\w-])--[a-z][a-z-]*", help_result["stdout"])
        observed[" ".join(verb) + " --help"] = sorted(set(flags))
    for case in cases:
        result = run_case(command, shlex.split(case))
        if case == "contract":
            if result["stdout"] != (SKILL / "contract.json").read_text():
                sys.exit("contract stdout differs from contract.json, including the node card examples")
            result["stdout"] = "<contract.json>"
        observed[case] = result
    snapshot = HERE / "expected.json"
    actual = json.dumps(observed, indent=2) + "\n"
    if record:
        snapshot.write_text(actual)
    else:
        expected = snapshot.read_text()
        if actual != expected:
            sys.exit("".join(difflib.unified_diff(expected.splitlines(True), actual.splitlines(True),
                                                  fromfile="expected", tofile="actual")))
    print(f"{len(cases)} CLI cases passed")


if __name__ == "__main__":
    main()
