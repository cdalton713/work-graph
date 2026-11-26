"""Run public CLI cases against recorded process and file results."""
from contextlib import nullcontext
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
# run.sh starts Python in isolated mode. Load only the sibling test fixture.
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
from services import fixture_service

SKILL = HERE.parents[1] / "skills/work-graph"
REFERENCE = [sys.executable, "-I", str(SKILL / "scripts/wg.py")]


def files(root):
    entries = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            data = {"link": os.readlink(path)}
        elif path.is_dir():
            data = {"directory": True}
        else:
            content = path.read_bytes()
            try:
                data = content.decode("utf-8")
            except UnicodeDecodeError:
                data = {"hex": content.hex()}
        entries[str(path.relative_to(root))] = (stat.S_IMODE(path.lstat().st_mode), data)
    return entries


def run_case(command, args, service=False):
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
               "no_proxy": "unused.invalid",
               "http_proxy": "http://127.0.0.1:1", "https_proxy": "http://127.0.0.1:1"}
        env["WG_UI_DIR"] = str(root / "empty")
        if args == ["doctor", "effort"]:
            env["WG_UI_URL"] = "https://page.invalid"
        before = files(root)
        with fixture_service() if service else nullcontext(({}, [])) as (settings, events):
            try:
                result = subprocess.run(command + args, cwd=root, env=env | settings,
                                        input="fixture-token\n" if service else "",
                                        capture_output=True, text=True, timeout=15)
            except subprocess.TimeoutExpired:
                sys.exit(f"Timed out after 15 seconds: wg {shlex.join(args)}")
        if "Traceback (most recent call last)" in result.stderr:
            raise RuntimeError(f"{args}: {result.stderr}")

        def normalize(value):
            if not isinstance(value, str):
                return value
            value = value.replace(str(root), "<sandbox>").replace(str(SKILL), "<skill>")
            value = re.sub(r'("time": ")\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', r'\1<time>', value)
            return value

        after = files(root)
        changes = {}
        for name in sorted(before.keys() | after.keys()):
            if before.get(name) != after.get(name):
                changes[name] = ([oct(after[name][0]), normalize(after[name][1])]
                                 if name in after else None)
        stderr = normalize(result.stderr)
        if stderr.startswith("usage: "):
            # argparse wraps only the synopsis. Keep every argument and the full error.
            stderr = re.sub(r"^usage: [^\n]*(?:\n[ \t]+[^\n]*)*",
                            lambda match: re.sub(r"\n[ \t]+", " ", match[0]), stderr)
            stderr = re.sub(r"(?m)^(usage: )?wg\.py(?=[ :])", r"\1wg", stderr)
        stdout = normalize(result.stdout)
        if args == ["doctor", "effort"]:
            # Runtime, installed modules and OS checks vary. Compare the effort diagnosis.
            stdout = "".join(line for line in stdout.splitlines(True)
                             if re.match(r"^(?:ok|warn|FAIL) (?:plan|keymap|worktrees):", line))
        observed = {"exit": result.returncode, "stdout": stdout, "stderr": stderr, "files": changes}
        if service:
            if result.returncode or not events:
                sys.exit(f"fixture service case {args} failed: {observed}")
            observed["requests"] = events
        return observed


def help_flags(help_text):
    options = [line.strip().split("  ")[0] for line in help_text.splitlines()
               if re.match(r"^\s+-", line)]
    flags = re.findall(r"(?<![\w-])(?:--[a-z][a-z-]*|-[A-Za-z]\b)", " ".join(options))
    return sorted(set(flags))


def main():
    os.umask(0o022)
    record = sys.argv[1:] == ["--record"]
    if len(sys.argv) > 2:
        sys.exit("usage: run.sh [PATH-TO-WG | --record]")
    command = REFERENCE
    if len(sys.argv) == 2 and not record:
        candidate = Path(sys.argv[1]).absolute()
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            sys.exit(f"Candidate must be an executable file: {candidate}")
        command = [str(candidate)]
    cases = [line for line in (HERE / "cases.txt").read_text().splitlines()
             if line and not line.startswith("#")]
    commands = [case.removeprefix("service | ") for case in cases]
    for group in ("", "run", "owns"):
        help_result = run_case(command, group.split() + ["--help"])
        choices = re.search(r"\{([\w,-]+)\}", help_result["stdout"])
        paths = [line.split() for line in commands if not group or line.startswith(group + " ")]
        listed = {path[len(group.split())] for path in paths}
        roots = set(choices[1].split(",")) if choices else set()
        if not group and command != REFERENCE and "update" in roots:
            roots.remove("update")
            for control in ("status", "rollback"):
                result = run_case(command, ["update", control, "--help"])
                if result["exit"] or result["stderr"] or result["files"] or f"wg update {control}" not in result["stdout"]:
                    sys.exit(f"Native update {control} help failed: {result}")
        if not choices or roots != listed:
            sys.exit(f"Update cases.txt for the verbs in {group or 'root'} help:\n{help_result['stdout']}")
    observed = {}
    verbs = {tuple(case.split()[:2] if case.split()[0] in {"owns", "run"} else case.split()[:1])
             for case in commands}
    for verb in sorted(verbs):
        help_result = run_case(command, [*verb, "--help"])
        if help_result["exit"] or help_result["stderr"] or help_result["files"]:
            sys.exit(f"{verb} help failed: {help_result}")
        observed[" ".join(verb) + " --help"] = help_flags(help_result["stdout"])
    for case in cases:
        args = shlex.split(case.removeprefix("service | "))
        result = run_case(command, args, case.startswith("service | "))
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
