"""Compare both usage commands on the same synthetic transcripts."""
from pathlib import Path
from statistics import median
import json
import os
import re
import select
import socket
import resource
import subprocess
import sys
import time
import unittest

SCRIPTS = Path(__file__).resolve().parent / "reference"
sys.path.insert(0, str(SCRIPTS))
from test_wg import UsageTests


def run(command):
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.perf_counter()
    result = subprocess.run(command, capture_output=True)
    elapsed = time.perf_counter() - start
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime
    stderr = result.stderr
    if stderr.startswith(b"usage: "):
        # argparse wraps the synopsis differently in Python 3.13.
        stderr = re.sub(rb"\n[ \t]+", b" ", stderr)
    return (result.returncode, result.stdout, stderr), (cpu, elapsed)


def compare(binary, benchmark):
    case = UsageTests()
    try:
        case.setUp()
        case.fixtures()
        stamp = "2026-01-01T14:00:00Z"
        if benchmark:
            case.claude(case.worker, "large", "worker", [
                (f"large-{i}", stamp, 100, 20, 10, 5) for i in range(50000)])
            case.codex(case.worker, "large", "worker", [
                (stamp, i * 100, i * 20, i * 5, 100) for i in range(50000)])
        reference = [sys.executable, "-I", str(SCRIPTS / "wg.py")]
        times = [[], []]
        args = ["usage", str(case.d)]
        if benchmark:
            cases = [args + ["--json"]] * 7
        else:
            boundary = "2026-01-01T11:15:00.123456Z"
            case.claude(case.worker, "fraction", "worker", [
                ("before", "2026-01-01T11:15:00.123455Z", 1, 0, 0, 1),
                ("at", boundary, 2, 0, 0, 1)])
            case.codex(case.worker, "offset", "worker", [
                ("20260101T134500.123455+0230", 5, 0, 1, 5),
                ("20260101T134500.123456+0230", 15, 0, 2, 10)])
            cases = [args + flags for flags in (
                [], ["--json"], ["--all"], ["--json", "--since=2026-01-01T11:15:00Z"],
                ["--js", "--al", "--sin=2026-01-01"], ["--help"], ["-h"],
                ["--bogus"], ["--since"], ["--since", "--json"], ["--all=value"])]
            cases += [args + ["--json", "--since", value] for value in (
                stamp, boundary, "2026-01-01T11:15Z", "2026-01-01T11:15", "2026-01-01T11",
                "2026-01-01T11:15:00+0000", "20260101T111500Z", "20260101T134500+0230",
                "1d12h", " 2h ", "0h", "2w3d4h5m6s", "invalid", "2026-02-30", "2026-01-01T24:01")]
            cases += [["usage"], ["usage", "--js", "--", str(case.d)]]
        for args in cases:
            expected, timing = run(reference + args)
            times[0].append(timing)
            actual, timing = run([binary, *args])
            times[1].append(timing)
            assert actual == expected, (actual, expected)
        if benchmark:
            for label, samples in zip(("python", "rust"), times):
                cpu, wall = map(median, zip(*samples))
                print(f"{label} median CPU {cpu:.4f}s elapsed {wall:.4f}s")
    finally:
        case.doCleanups()


if __name__ == "__main__":
    binary = str(Path(sys.argv[1]).resolve())
    benchmark = "--benchmark" in sys.argv[2:]
    compare(binary, benchmark)
    if not benchmark:
        class PreviewUsageTests(UsageTests):
            def call(self, fn, argv, code=0):
                result = subprocess.run([binary, *argv[1:]], capture_output=True, text=True)
                self.assertEqual(result.returncode, code, result.stderr)
                return result.stdout, result.stderr

            def test_short_count_moves_up_a_unit_at_1000(self):
                counts = [999, 98_600, 999_949, 999_999, 999_999_999, 1_500_000_000]
                for i, count in enumerate(counts):
                    self.claude(self.worker, f"session-{i}", "ordinary", [
                        (f"call-{i}", "2026-01-01T10:00:00Z", count, 0, 0, 1)])
                result = subprocess.check_output([binary, "usage", str(self.d)], text=True)
                fresh = [line.split()[5] for line in result.splitlines()[1:7]]
                self.assertEqual(fresh, ["1.5B", "1.0B", "1.0M", "999.9K", "98.6K", "999"])

            def test_reads_no_network_and_writes_nothing(self):
                self.fixtures()
                def snapshot():
                    return {p: p.stat().st_mtime_ns for root in (self.d, self.home)
                            for p in [root, *root.rglob("*")]}
                before = snapshot()
                with socket.create_server(("127.0.0.1", 0)) as proxy:
                    url = f"http://127.0.0.1:{proxy.getsockname()[1]}"
                    env = os.environ | {key: url for key in
                                        ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")}
                    env.update(no_proxy="", NO_PROXY="")
                    output = subprocess.check_output([binary, "usage", str(self.d), "--json"],
                                                     env=env, timeout=10)
                    self.assertGreater(json.loads(output)["total"]["calls"], 0)
                    self.assertFalse(select.select([proxy], [], [], 0)[0])
                self.assertEqual(snapshot(), before)

        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from suite import HERE, run_case
        name = "usage effort --json --all"
        recorded = json.loads((HERE / "expected.json").read_text())[name]
        assert run_case([binary], name.split()) == recorded

        suite = unittest.defaultTestLoader.loadTestsFromTestCase(PreviewUsageTests)
        if not unittest.TextTestRunner().run(suite).wasSuccessful():
            sys.exit(1)
