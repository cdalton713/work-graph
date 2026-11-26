"""Compare local native commands with the frozen process and file oracle."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from suite import HERE, SKILL, run_case

expected = json.loads((HERE / "expected.json").read_text())
for name, result in expected.items():
    if not isinstance(result, dict) or name.split()[0] not in {"check", "owns", "contract", "run", "log"}:
        continue
    # Mapped writes require the Linear adapter. The service fixture remains in the full suite.
    if name == "run reset effort a":
        continue
    actual = run_case([sys.argv[1]], name.split())
    if name == "contract":
        result["stdout"] = (SKILL / "contract.json").read_text()
    assert actual == result, (name, actual, result)
