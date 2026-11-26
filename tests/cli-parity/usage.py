"""Compare both usage commands on the same synthetic transcripts."""
from pathlib import Path
from statistics import median
import resource
import subprocess
import sys
import time
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / "skills/work-graph/scripts"
sys.path.insert(0, str(SCRIPTS))
from test_wg import UsageTests


def run(command):
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.perf_counter()
    result = subprocess.run(command, capture_output=True)
    elapsed = time.perf_counter() - start
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime
    return (result.returncode, result.stdout, result.stderr), (cpu, elapsed)


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
        cases = [["--json"]] * 7 if benchmark else [
            [], ["--json"], ["--all"], ["--since", stamp, "--json"],
            ["--json", "--since=2026-01-01T11:15:00Z"], ["--since", "invalid"]]
        for flags in cases:
            args = ["usage", str(case.d), *flags]
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
    binary = sys.argv[1]
    benchmark = "--benchmark" in sys.argv[2:]
    compare(binary, benchmark)
    if not benchmark:
        class PreviewUsageTests(UsageTests):
            def call(self, fn, argv, code=0):
                result = subprocess.run([binary, *argv[1:]], capture_output=True, text=True)
                self.assertEqual(result.returncode, code, result.stderr)
                return result.stdout, result.stderr

        suite = unittest.defaultTestLoader.loadTestsFromTestCase(PreviewUsageTests)
        if not unittest.TextTestRunner().run(suite).wasSuccessful():
            sys.exit(1)
