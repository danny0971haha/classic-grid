#!/usr/bin/env python3
"""Scan canary lockfile, tarball listing, installed graph, and load log for extra forbidden items.

This does not replace scripts/security forbidden-specifiers.ts. It adds toml,
@n1xyz/*, @coral-xyz/anchor, src/venues/n1.ts, and src/officialStats.ts checks.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

EXTRA_NAMES = ("toml", "@coral-xyz/anchor")
EXTRA_PREFIXES = ("@n1xyz/", "@n1xyz\\", "node_modules/@n1xyz/")
EXTRA_SOURCES = ("src/venues/n1.ts", "src/officialStats.ts", "src/venues/n1.js", "src/officialStats.js")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def walk_installed_names(node_modules: Path) -> list[str]:
    names: set[str] = set()
    if not node_modules.is_dir() or node_modules.is_symlink():
        raise ValueError("CANARY_INSTALLED_GRAPH_REQUIRED")

    def walk(directory: Path) -> None:
        if not directory.exists():
            return
        entries = list(directory.iterdir())
        for entry in entries:
            if entry.name == ".bin":
                continue
            if entry.is_symlink():
                raise ValueError("CANARY_INSTALLED_SYMLINK:" + str(entry))
            if entry.name.startswith("@") and entry.is_dir():
                walk(entry)
                continue
            pkg = entry / "package.json"
            if entry.is_dir() and not pkg.is_file():
                raise ValueError("CANARY_PACKAGE_METADATA_REQUIRED:" + str(entry))
            if entry.is_dir() and pkg.is_file():
                data = json.loads(pkg.read_text(encoding="utf-8"))
                name = data.get("name")
                if not isinstance(name, str) or not name:
                    raise ValueError("CANARY_PACKAGE_NAME_REQUIRED")
                names.add(name)
                walk(entry / "node_modules")

    walk(node_modules)
    if not names:
        raise ValueError("CANARY_INSTALLED_GRAPH_EMPTY")
    return sorted(names)


def hits_in_text(text: str) -> list[str]:
    found = []
    lower = text
    for name in EXTRA_NAMES:
        if f"node_modules/{name}" in lower or f'"name": "{name}"' in lower or f'"{name}"' in lower:
            found.append(name)
    for prefix in ("@n1xyz/",):
        if prefix in lower:
            found.append(prefix.rstrip("/"))
    for src in EXTRA_SOURCES:
        if src in lower:
            found.append(src)
    return sorted(set(found))


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: scan-extra-boundaries.py <evidence-dir>", file=sys.stderr)
        return 2
    evidence = Path(sys.argv[1])
    lockfile = Path(os.environ["CANARY_LOCKFILE"])
    tar_list = Path(os.environ["CANARY_TAR_LIST"])
    install_dir = Path(os.environ["CANARY_INSTALL_DIR"])
    load_log = Path(os.environ.get("CANARY_LOAD_LOG", ""))

    lock_raw = lockfile.read_text(encoding="utf-8")
    lock_obj = json.loads(lock_raw)
    packages = lock_obj.get("packages")
    if not isinstance(packages, dict) or not packages:
        raise ValueError("CANARY_LOCK_PACKAGES_REQUIRED")
    lock_keys = sorted(packages)
    lock_names = []
    for key, meta in packages.items():
        name = (meta or {}).get("name")
        if isinstance(name, str):
            lock_names.append(name)
        elif key.startswith("node_modules/"):
            lock_names.append(key[len("node_modules/") :])
    lock_names = sorted(set(lock_names))

    tar_names = [line.strip() for line in tar_list.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not tar_names:
        raise ValueError("CANARY_TAR_LIST_REQUIRED")
    if "CANARY_LOAD_LOG" in os.environ and (not load_log.is_file() or not load_log.read_text().strip()):
        raise ValueError("CANARY_LOAD_LOG_REQUIRED")
    installed = walk_installed_names(install_dir / "node_modules")

    loaded_specifiers: list[str] = []
    if load_log.is_file():
        rows = json.loads(load_log.read_text(encoding="utf-8"))
        if not isinstance(rows, list) or not rows:
            raise ValueError("CANARY_LOAD_GRAPH_REQUIRED")
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("specifier"), str) or not isinstance(row.get("resolvedURL"), str):
                raise ValueError("CANARY_LOAD_GRAPH_MALFORMED")
            loaded_specifiers.extend([row["specifier"], row["resolvedURL"]])

    if "CANARY_LOAD_LOG" in os.environ and not loaded_specifiers:
        raise ValueError("CANARY_LOAD_GRAPH_EMPTY")

    def match_names(items: list[str]) -> list[str]:
        found = []
        for item in items:
            if re.search(r"(?:^|/)node_modules/(toml|@coral-xyz/anchor)(?:/|$)", item):
                found.append(item)
            if item in EXTRA_NAMES or item == "toml" or item == "@coral-xyz/anchor":
                found.append(item)
            if item.startswith("@n1xyz/") or item == "@n1xyz/nord-ts" or item == "@n1xyz/proton":
                found.append(item)
            for src in EXTRA_SOURCES:
                if item == src or item.endswith("/" + src) or item.endswith("\\" + src):
                    found.append(src)
            if "toml" in item.split("/")[-1:] and item.endswith("toml"):
                if item == "toml" or item.endswith("/toml") or "/toml/" in item:
                    found.append("toml")
        return sorted(set(found))

    payload = {
        "schema": "classic-canary-extra-boundary-scan/20260908",
        "lockfile_package_keys": lock_keys,
        "lockfile_package_key_count": len(lock_keys),
        "lockfile_names": lock_names,
        "installed_names": installed,
        "tarball_entries": tar_names,
        "tarball_entry_count": len(tar_names),
        "loaded_specifier_count": len(loaded_specifiers),
        "hits": {
            "lockfile_text": hits_in_text(lock_raw),
            "lockfile_names": match_names(lock_names),
            "installed_names": match_names(installed),
            "tarball_entries": match_names(tar_names) + [n for n in tar_names if any(src in n for src in EXTRA_SOURCES)],
            "loaded_specifiers": match_names(loaded_specifiers),
            "loaded_text": hits_in_text("\n".join(loaded_specifiers)),
        },
    }
    extra_tar = [n for n in tar_names if any(src in n.replace("\\", "/") for src in EXTRA_SOURCES)]
    payload["hits"]["tarball_entries"] = sorted(set(payload["hits"]["tarball_entries"] + extra_tar))
    out = evidence / "extra-boundary-scan.json"
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    json.dump({"wrote": str(out), "hits": payload["hits"]}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 1 if any(payload["hits"].values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
