#!/bin/sh
set -eu
suite=$(cd "$(dirname "$0")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/entry"
ln -s "$suite/reference/wg.py" "$fixture/entry/wg"
python3 - "$fixture" <<'PY'
from pathlib import Path
import shlex
import sys

root = Path(sys.argv[1])
wrapper = root / "wg"
wrapper.write_text("#!/bin/sh\nexec " + shlex.join([sys.executable, "-I", str(root / "entry/wg")]) + ' "$@"\n')
wrapper.chmod(0o755)
PY
sh "$suite/run.sh" --python-candidate "$fixture/wg"
