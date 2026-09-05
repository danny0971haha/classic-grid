import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "verify-current-candidate.py"
spec = importlib.util.spec_from_file_location("verification", SOURCE)
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)


class VerificationTests(unittest.TestCase):
    def test_fail_fast_retains_exit_and_does_not_run_followup(self):
        with tempfile.TemporaryDirectory(dir=verification.ROOT) as tmp:
            results = verification.run_steps([
                [sys.executable, "-c", "raise SystemExit(7)"],
                [sys.executable, "-c", "raise SystemExit(0)"],
            ], {"PATH": os.environ["PATH"]}, Path(tmp))
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["exitCode"], 7)
            self.assertEqual(len(results[0]["logSha256"]), 64)

    def test_kernel_filter_blocks_internet_in_descendant(self):
        code = f'''import runpy,subprocess,sys
v=runpy.run_path({str(SOURCE)!r});v['deny_network']()
r=subprocess.run([sys.executable,'-c',"import socket; socket.socket(socket.AF_INET, socket.SOCK_STREAM)"],capture_output=True)
assert r.returncode != 0
assert b'Operation not permitted' in r.stderr
'''
        result = subprocess.run([sys.executable, "-c", code], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_missing_executable_is_failure(self):
        with tempfile.TemporaryDirectory(dir=verification.ROOT) as tmp:
            results = verification.run_steps([["/nonexistent/classic-validator"]],
                                            {}, Path(tmp))
            self.assertEqual(results[0]["exitCode"], 127)


if __name__ == "__main__":
    unittest.main()
