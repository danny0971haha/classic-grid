#!/usr/bin/env python3
"""Report whether Classic's documented Linux seccomp AF_UNIX-only filter can be installed.

Does not weaken or substitute the filter. Exit 0 always; status is in JSON.
"""
from __future__ import annotations

import ctypes
import json
import os
import platform
import shutil
import socket
import sys

result = {
    "schema": "classic-canary-isolation-check/20260908",
    "platform": platform.platform(),
    "system": platform.system(),
    "release": platform.release(),
    "machine": platform.machine(),
    "python": sys.version,
    "libseccomp": {"status": "NOT_RUN", "detail": None},
    "unix_socket": {"status": "NOT_RUN", "detail": None},
    "docker": {"status": "NOT_RUN", "path": None},
    "kernel_isolation": "NOT_RUN",
    "reason": None,
}


def main() -> int:
    docker = shutil.which("docker")
    result["docker"]["path"] = docker
    result["docker"]["status"] = "OBSERVED_AVAILABLE" if docker else "OBSERVED_UNAVAILABLE"

    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.close()
        result["unix_socket"]["status"] = "OBSERVED"
        result["unix_socket"]["detail"] = "AF_UNIX socket() succeeded"
    except OSError as exc:
        result["unix_socket"]["status"] = "BLOCKED"
        result["unix_socket"]["detail"] = str(exc)

    try:
        lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
        result["libseccomp"]["status"] = "OBSERVED"
        result["libseccomp"]["detail"] = f"loaded {lib}"
    except OSError as exc:
        result["libseccomp"]["status"] = "BLOCKED"
        result["libseccomp"]["detail"] = str(exc)

    if result["libseccomp"]["status"] != "OBSERVED":
        result["kernel_isolation"] = "BLOCKED"
        result["reason"] = (
            "libseccomp.so.2 is required by scripts/verify-current-candidate.py "
            "deny_network(); this host cannot install LINUX_SECCOMP_AF_UNIX_ONLY. "
            "No substitute filter was applied."
        )
    elif result["unix_socket"]["status"] != "OBSERVED":
        result["kernel_isolation"] = "BLOCKED"
        result["reason"] = "Unix socket is required for local IPC and is unavailable."
    else:
        result["kernel_isolation"] = "OBSERVED_AVAILABLE"
        result["reason"] = "Filter library present; caller may apply deny_network()."

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
