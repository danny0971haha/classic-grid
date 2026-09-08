#!/bin/sh
# Split Classic Extended-canary verification: registry/audit vs offline isolation.
# Does not modify runtime, adapters, locks, or audit baselines.
set -eu

TARGET_ROOT="${TARGET_ROOT:-/private/tmp/classic-grid-pr12-canary-20260908}"
EVIDENCE_ROOT="${EVIDENCE_ROOT:-/private/tmp/classic-grid-canary-review-20260908}"
OUT="${OUT:-$EVIDENCE_ROOT/docs/evidence/classic-canary-review-20260908}"
TOOL_DIR="$EVIDENCE_ROOT/tools/review/classic-canary-20260908"
LOG_DIR="$OUT/logs"
mkdir -p "$LOG_DIR" "$OUT/registry" "$OUT/offline" "$OUT/tests" "$OUT/empty-home"
export TARGET_ROOT

log_cmd() {
  name="$1"
  shift
  start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log="$LOG_DIR/${name}.log"
  meta="$LOG_DIR/${name}.meta.json"
  set +e
  "$@" >"$log" 2>&1
  code=$?
  set -e
  end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 -c 'import json,sys; json.dump({"name":sys.argv[1],"command":sys.argv[6:],"exitCode":int(sys.argv[2]),"started_at_utc":sys.argv[3],"ended_at_utc":sys.argv[4],"log":"logs/"+sys.argv[1]+".log"}, open(sys.argv[5],"w"), indent=2); open(sys.argv[5],"a").write("\n")' \
    "$name" "$code" "$start" "$end" "$meta" "$@"
  echo "$name exit $code"
  return "$code"
}

export HOME="$OUT/empty-home"
unset LIVE_CONFIRM EXTENDED_API_KEY EXTENDED_VAULT EXTENDED_VAULT_ID \
  EXTENDED_STARK_PRIVATE_KEY EXTENDED_STARK_PUBLIC_KEY NPM_TOKEN NODE_AUTH_TOKEN \
  EXTENDED_TESTNET_API_KEY EXTENDED_TESTNET_STARK_PRIVATE_KEY || true

{
  echo "target_root=$TARGET_ROOT"
  echo -n "target_head="; git -C "$TARGET_ROOT" rev-parse HEAD
  echo -n "target_tree="; git -C "$TARGET_ROOT" rev-parse 'HEAD^{tree}'
  echo "target_status_porcelain=$(git -C "$TARGET_ROOT" status --porcelain --untracked-files=all | wc -l | tr -d ' ')"
  echo "node=$(node -v)"
  echo "npm=$(npm -v)"
  echo "python=$(python3 --version)"
  echo "uname=$(uname -a)"
  echo "ci_node_pin=v22.23.2"
  echo "host_node_is_not_ci_pin=YES"
} >"$OUT/target-identity.txt"

python3 "$TOOL_DIR/check-isolation.py" >"$OUT/offline/isolation-check.json"

# Attempt the real wrapper. Do not install a weaker filter if this fails.
set +e
(
  cd "$TARGET_ROOT"
  python3 scripts/verify-current-candidate.py
) >"$OUT/offline/verify-current-candidate.json" 2>"$OUT/logs/00-verify-current-candidate.log"
wrap_code=$?
set -e
python3 -c 'import json,sys; json.dump({"name":"00-verify-current-candidate","exitCode":int(sys.argv[1]),"log":"logs/00-verify-current-candidate.log"}, open(sys.argv[2],"w"), indent=2)' \
  "$wrap_code" "$LOG_DIR/00-verify-current-candidate.meta.json"
echo "00-verify-current-candidate exit $wrap_code"

cd "$TARGET_ROOT"
set +e
log_cmd 01-root-npm-ci npm ci --no-fund --ignore-scripts
set -e

# Review tooling lives in the evidence worktree; resolve packages from the target install.
if [ ! -e "$EVIDENCE_ROOT/node_modules" ]; then
  ln -s "$TARGET_ROOT/node_modules" "$EVIDENCE_ROOT/node_modules"
fi

set +e
log_cmd 02-test-security-canary-subset node --import tsx --test \
  test/security/extended-canary-boundary.test.ts \
  test/security/source-policy.test.ts \
  test/security/canary-manifest-strict.test.ts \
  test/security/canary-artifact-content.test.ts
set -e

set +e
log_cmd 03-registry-phase node --import tsx "$TOOL_DIR/run-registry-phase.ts" \
  --target-root "$TARGET_ROOT" --out-dir "$OUT/registry"
set -e

if [ -f "$OUT/registry/install-dirs.json" ]; then
  TAR_INSTALL="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tarballInstallDir"])' "$OUT/registry/install-dirs.json")"
  export CANARY_LOCKFILE="$TARGET_ROOT/packages/extended-canary/package-lock.json"
  export CANARY_TAR_LIST="$OUT/registry/tarball-list.txt"
  export CANARY_INSTALL_DIR="$TAR_INSTALL"
  unset CANARY_LOAD_LOG || true
  python3 "$TOOL_DIR/scan-extra-boundaries.py" "$OUT/registry" >"$OUT/logs/04-extra-boundary-pre-probe.log" || true
  set +e
  log_cmd 05-userspace-probe node --import tsx "$TOOL_DIR/run-userspace-probe.ts" \
    --target-root "$TARGET_ROOT" --install-dir "$TAR_INSTALL" --out-dir "$OUT/offline"
  set -e
  if [ -f "$OUT/offline/probe-module-graph.json" ]; then
    export CANARY_LOAD_LOG="$OUT/offline/probe-module-graph.json"
    python3 "$TOOL_DIR/scan-extra-boundaries.py" "$OUT" >"$OUT/logs/06-extra-boundary-post-probe.log" || true
    cp -f "$OUT/extra-boundary-scan.json" "$OUT/registry/extra-boundary-scan-post-probe.json" 2>/dev/null || true
  fi
fi

date -u +%Y-%m-%dT%H:%M:%SZ >"$OUT/driver-finished.txt"
echo "scoped verification driver finished"
