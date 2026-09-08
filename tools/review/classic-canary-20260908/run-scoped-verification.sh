#!/bin/sh
# Explicit arguments, fresh output and machine-readable settlement; no shell errexit toggles.
set -eu
exec python3 "$(dirname "$0")/scoped-driver.py" "$@"
