"""Check the recorded public exit codes, output, help flags and disk changes."""
import json
from pathlib import Path
import re
import shlex
import sys

here = Path(__file__).resolve().parent
sys.path.insert(0, str(here))
from suite import run_case

binary = str(Path(sys.argv[1]).resolve())
cases = json.loads((here / "expected.json").read_text())
for name, expected in cases.items():
    args = shlex.split(name)
    if args[0] not in {"next", "watch", "agents", "wake", "health", "tick", "autostart"}:
        continue
    observed = run_case([binary], args)
    if args[-1] == "--help":
        assert observed["exit"] == 0 and not observed["stderr"] and not observed["files"], observed
        lines = [s.strip().split("  ")[0] for s in observed["stdout"].splitlines() if s.startswith("  -")]
        observed = sorted(set(re.findall(r"(?<![\w-])(?:--[a-z][a-z-]*|-[A-Za-z]\b)", " ".join(lines))))
    assert observed == expected, (name, observed, expected)
