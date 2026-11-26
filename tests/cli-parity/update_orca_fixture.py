#!/usr/bin/env python3
"""Read-only Orca adapter for the installed wg agents --install trial."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

home = Path.home()
cmd = sys.argv[1:]
assert cmd[0] == "plugin" and cmd[-1] == "--json" and "--approve" not in cmd


def inspect(folder):
    if cli := os.getenv("FIXTURE_INSPECT_CLI"):
        result = json.loads(subprocess.check_output([cli, "plugin", "inspect", folder, "--json"]))
        assert result["result"]["valid"]
        return result["result"]
    digest = hashlib.sha256()
    for file in sorted(Path(folder).rglob("*")):
        if file.is_file():
            digest.update(str(file.relative_to(folder)).encode() + b"\0")
            digest.update(hashlib.sha256(file.read_bytes()).digest())
    return {"contentHash": digest.hexdigest()}


if cmd[1] == "inspect":
    reply = {"ok": True, "result": inspect(cmd[2])}
else:
    registration = json.loads((home / "registration.json").read_bytes())
    approved = json.loads((home / "approval.json").read_bytes())["local.wg-agents"]
    if cmd[1] == "list":
        reply = {"ok": True, "result": {"plugins": [{"pluginKey": "local.wg-agents",
                 "source": registration, "needsReconsent": registration["contentHash"] != approved}]}}
    else:
        assert cmd[1] in ("install", "update")
        content = inspect(registration["reference"])["contentHash"]
        assert content != approved
        reply = {"ok": False, "error": {"code": "approval_required",
                 "data": {"command": f"orca plugin update local.wg-agents --approve {content}"}}}
print(json.dumps(reply))
