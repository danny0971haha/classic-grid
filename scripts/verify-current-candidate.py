"""Local evidence only. Linux/Python 3/libseccomp; no credential or network fallback."""
import argparse
import ctypes
import errno
import hashlib
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FROZEN = "990a790706e17b52e04d0d1957505cdad5d45862"
FROZEN_TREE = "c544b6e9d8f8e33a59d12a7d6e1eeeecd0c6cbb8"


def deny_network():
    """Inherited kernel filter: prohibit Internet/packet sockets, retain local IPC."""
    lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                    ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]

    class Compare(ctypes.Structure):
        _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                    ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]

    ctx = lib.seccomp_init(0x7FFF0000)
    if not ctx:
        raise RuntimeError("NETWORK_ISOLATION_UNAVAILABLE")
    try:
        # Permit AF_UNIX only, including for descendants and native modules.
        for syscall in (b"socket", b"socketpair"):
            number = lib.seccomp_syscall_resolve_name(syscall)
            if number < 0 or lib.seccomp_rule_add(
                    ctx, 0x00050000 | errno.EPERM, number, 1,
                    Compare(0, 1, 1, 0)) != 0:  # SCMP_CMP_NE, AF_UNIX
                raise RuntimeError("NETWORK_FILTER_FAILED")
        if lib.seccomp_load(ctx) != 0:
            raise RuntimeError("NETWORK_ISOLATION_UNAVAILABLE")
    finally:
        lib.seccomp_release(ctx)


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True,
                                   env={"PATH": os.environ["PATH"],
                                        "GIT_NO_LAZY_FETCH": "1"}).strip()


def run_steps(steps, environment, log_dir):
    log_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for index, command in enumerate(steps):
        log = log_dir / f"{index + 1:02d}.log"
        try:
            with log.open("wb") as stream:
                child = subprocess.Popen(command, cwd=ROOT, env=environment,
                                         stdout=stream, stderr=subprocess.STDOUT,
                                         start_new_session=True)
                try:
                    code = child.wait(timeout=600)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    code = 124
        except (OSError, subprocess.TimeoutExpired) as error:
            with log.open("ab") as stream:
                stream.write((type(error).__name__ + "\n").encode())
            code = 124 if isinstance(error, subprocess.TimeoutExpired) else 127
        results.append({"command": command, "exitCode": code,
                        "log": str(log.relative_to(ROOT)),
                        "logSha256": hashlib.sha256(log.read_bytes()).hexdigest()})
        print(f"{' '.join(command)}: exit {code}", file=sys.stderr)
        if code != 0:
            break
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit-json", type=Path,
                        help="Previously captured npm audit JSON; never fetched here")
    args = parser.parse_args()
    summary = {"repository": "classic-grid", "candidate": None,
               "offlineValidationCompleted": False, "liveExchangeWrites": False,
               "testnetWrites": False, "authorizationGranted": False,
               "networkIsolation": None, "checks": [], "blockers": [],
               "notExecuted": ["verify:extended-canary (registry install/audit)"]}
    code = 1
    try:
        deny_network()
        summary["networkIsolation"] = "LINUX_SECCOMP_AF_UNIX_ONLY"
        summary["candidate"] = git("rev-parse", "HEAD")
        summary["candidateTree"] = git("rev-parse", "HEAD^{tree}")
        summary["workingTreeStatus"] = git("status", "--porcelain", "--untracked-files=all")
        if git("rev-parse", FROZEN + "^{tree}") != FROZEN_TREE:
            raise RuntimeError("FROZEN_IDENTITY_MISMATCH")
        if any(p.name != ".env.example" for p in ROOT.glob(".env*")):
            raise RuntimeError("LOCAL_ENV_FILE_PRESENT_USE_CLEAN_CHECKOUT")
        log_dir = ROOT / "artifacts" / "current-candidate"
        log_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="classic-verification-home-") as home:
            env = {"PATH": os.environ["PATH"], "HOME": home, "TMPDIR": home,
                   "GIT_NO_LAZY_FETCH": "1", "npm_config_offline": "true",
                   "npm_config_audit": "false", "npm_config_fund": "false",
                   "npm_config_update_notifier": "false", "npm_config_fetch_retries": "0"}
            steps = [["npm", "run", name] for name in
                     ("typecheck", "test:security", "test", "build",
                      "verify:action-inventory", "pack:extended-canary")]
            summary["checks"] = run_steps(steps, env, log_dir)
            if len(summary["checks"]) != len(steps) or summary["checks"][-1]["exitCode"] != 0:
                summary["blockers"].append("MANDATORY_CHECK_FAILED")
            elif args.audit_json is None or not args.audit_json.is_file():
                summary["blockers"].append("OFFLINE_AUDIT_JSON_REQUIRED")
            else:
                audit = args.audit_json.resolve()
                summary["auditInputSha256"] = hashlib.sha256(audit.read_bytes()).hexdigest()
                summary["auditFreshness"] = "NOT_ESTABLISHED_BY_OFFLINE_VALIDATION"
                audit_results = run_steps([["npm", "run", "audit:security-baseline", "--",
                                           "--audit-json", str(audit)]], env, log_dir / "audit")
                summary["checks"].extend(audit_results)
                if audit_results[-1]["exitCode"]:
                    summary["blockers"].append("OFFLINE_AUDIT_FAILED")
        if git("rev-parse", FROZEN + "^{tree}") != FROZEN_TREE:
            raise RuntimeError("FROZEN_IDENTITY_MISMATCH")
        summary["frozenIdentityPreserved"] = True
        summary["offlineValidationCompleted"] = not summary["blockers"]
        code = 0 if summary["offlineValidationCompleted"] else 1
    except Exception as error:
        summary["blockers"].append(str(error) if isinstance(error, RuntimeError)
                                   else type(error).__name__)
    print(json.dumps(summary, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
