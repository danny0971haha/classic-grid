#!/usr/bin/env python3
"""Apply the TARGET's unchanged filter, exercise it, then run an offline child.

Exit 78 means an environment blocker. No command runs without real kernel/IPC checks.
"""
import argparse
import errno
import importlib.util
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import tempfile


def apply_and_check(target):
    result = {"system": platform.system(), "machine": platform.machine(),
              "kernel_isolation": "NOT_RUN", "checks": []}
    try:
        if platform.system() != "Linux":
            raise RuntimeError("LINUX_REQUIRED")
        spec = importlib.util.spec_from_file_location(
            "target_isolation", target / "scripts/verify-current-candidate.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.deny_network()
        # Full local IPC, not just socket construction.
        with tempfile.TemporaryDirectory(prefix="canary-ipc-") as tmp:
            with socket.socket(socket.AF_UNIX) as server, socket.socket(socket.AF_UNIX) as client:
                server.settimeout(5)
                client.settimeout(5)
                address = str(Path(tmp) / "s")
                server.bind(address)
                server.listen(1)
                client.connect(address)
                peer, _ = server.accept()
                with peer:
                    client.sendall(b"ipc")
                    if peer.recv(3) != b"ipc":
                        raise RuntimeError("AF_UNIX_IPC_FAILED")
        a, b = socket.socketpair(socket.AF_UNIX)
        a.close()
        b.close()
        result["checks"].append("AF_UNIX_BIND_LISTEN_CONNECT_DATA_SOCKETPAIR")
        for family in (socket.AF_INET, socket.AF_INET6, socket.AF_PACKET):
            for operation in (socket.socket, socket.socketpair):
                try:
                    opened = operation(family, socket.SOCK_STREAM)
                except OSError as error:
                    if error.errno != errno.EPERM:
                        raise
                else:
                    for item in opened if isinstance(opened, tuple) else (opened,):
                        item.close()
                    raise RuntimeError("INTERNET_SOCKET_NOT_DENIED")
                result["checks"].append(f"{operation.__name__}:{family.name}:EPERM")
        # Explicit exec inheritance, not only the parent process.
        child = subprocess.run([sys.executable, "-c", "import socket,errno\ntry: socket.socket(socket.AF_INET)\nexcept OSError as e: assert e.errno == errno.EPERM\nelse: raise AssertionError('inherited filter missing')"], check=True)
        result["checks"].append("EXEC_CHILD_AF_INET_EPERM")
        result["kernel_isolation"] = "LINUX_SECCOMP_AF_UNIX_ONLY"
    except Exception as error:
        result.update(kernel_isolation="BLOCKED", reason=f"{type(error).__name__}:{error}")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-root", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    result = apply_and_check(args.target_root)
    args.report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    if result["kernel_isolation"] != "LINUX_SECCOMP_AF_UNIX_ONLY":
        return 78
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        return 0
    env = dict(os.environ, npm_config_offline="true", npm_config_audit="false",
               npm_config_fetch_retries="0", GIT_NO_LAZY_FETCH="1")
    return subprocess.run(command, env=env).returncode


if __name__ == "__main__":
    sys.exit(main())
