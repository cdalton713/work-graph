#!/usr/bin/env python3
"""Synthetic Orca provider. Persist exactly the source and approval wg submits."""
import hashlib
import json
from pathlib import Path
import sys

home = Path.home()
registration = home / "registration.json"
permission = home / "permission.json"
key = "fixture.wg-agents"
group, op, *args, fmt = sys.argv[1:]
assert (group, fmt) == ("plugin", "--json")


def fingerprint(folder):
    digest = hashlib.sha256()
    for file in sorted(Path(folder).rglob("*")):
        if file.is_file():
            digest.update(str(file.relative_to(folder)).encode() + b"\0")
            digest.update(hashlib.sha256(file.read_bytes()).digest())
    return digest.hexdigest()


source = json.loads(registration.read_bytes()) if registration.exists() else None
if op == "list":
    result = {"plugins": [{"pluginKey": key, "source": source}] if source else []}
elif op == "inspect":
    result = {"contentHash": fingerprint(args[0])}
else:
    assert op in ("install", "update")
    if op == "update":
        assert args[0] == key
    folder = args[0] if op == "install" else source["reference"]
    content = fingerprint(folder)
    if args[1:] != ["--approve", content]:
        print(json.dumps({"ok": False, "error": {"code": "approval_required",
              "data": {"command": f"orca plugin {op} {args[0]} --approve {content}"}}}))
        sys.exit(1)
    registration.write_text(json.dumps({"reference": folder, "contentHash": content}))
    permission.write_text(content)
    result = {"pluginKey": key, "version": json.loads((Path(folder)/"orca-plugin.json").read_bytes())["version"]}
print(json.dumps({"ok": True, "result": result}))
