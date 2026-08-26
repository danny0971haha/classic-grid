# Classic Grid v0.2 — Checkpoint A Execution Contract

**Status:** AUTHORIZED AFTER INDEPENDENT GATE 0 PASS
**Date:** 2026-08-22
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-100u-safety`
**Accepted Gate 0 candidate:** `4ecec3edb897cfd4dfeef165cc4e39b80914cdc0`
**Gate 0 CI:** `32576765490` — success, 125/125 tests
**Parent contract:** `docs/classic-v0.2-implementation-contract.md`

## 1. Authorization

Implement **Checkpoint A only — versioned v0.2 configuration**.

```text
GATE_0=PASS
CHECKPOINT_A_AUTHORIZED=YES
CHECKPOINT_B_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

After Checkpoint A is implemented and evidenced, stop for independent review. Do not begin Checkpoint B.

## 2. Start procedure

Run from a clean checkout:

```bash
git fetch --all --prune
git checkout experiment/classic-v0.2-100u-safety
git pull --ff-only
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
node --version
npm --version
```

Read completely before editing:

```text
docs/classic-v0.2-implementation-contract.md
docs/experiment-spec-v0.2-100u-safety.md
docs/classic-v0.2-checkpoint-a-execution.md
```

The implementation agent must use the actual pulled HEAD as its checkpoint base and report it. Do not assume a stale SHA from chat.

## 3. Goal

Add an explicit versioned experiment configuration profile for v0.2 without mutating historical v0.1 behavior or non-experiment behavior.

Supported versions must be modeled explicitly, at minimum:

```ts
type ExperimentSpecVersion = "0.1.0" | "0.2.0";
```

Do not replace v0.1 constants in place. Resolve experiment configuration from a version-specific frozen profile.

## 4. Frozen v0.2 profile

When the selected version is `0.2.0`, resolve exactly:

```text
EXPERIMENT_SPEC_VERSION=0.2.0
capitalUsd=100
leverage=5
marginFraction=0.30
marginBudgetUsd=30
maxGrossNotionalUsd=150
gridCount=10
halfBandPct=0.03
dailyLossUsd=5
maxDrawdownUsd=10
boundaryBufferPct=0.01
venue engineering target=extended
market engineering target=BTC
tick target=15 seconds
```

Arithmetic invariant:

```text
100 * 0.30 * 5 = 150
```

This profile is an engineering configuration only. It is not live authorization.

## 5. Version selection and fail-closed semantics

Required behavior:

1. Existing v0.1 configuration behavior must remain compatible with historical v0.1 tests and PR #1.
2. Non-experiment defaults must remain unchanged.
3. `EXPERIMENT_SPEC_VERSION=0.2.0` selects the v0.2 profile.
4. An unsupported, malformed, or ambiguous experiment spec version while `EXPERIMENT_MODE=1` must fail closed with a stable error; it must not silently fall back to another version.
5. If preserving absent-version behavior is required for v0.1 compatibility, document and test that behavior explicitly; do not let an absent version silently select v0.2.
6. Environment overrides must not allow the frozen v0.2 safety envelope to drift in any path that could later be treated as the v0.2 canary profile.
7. Do not add a v0.2 live allowlist in Checkpoint A.
8. Any attempted v0.2 live start must remain rejected even when `DRY_RUN=0` and `LIVE_CONFIRM=YES` are supplied.

## 6. Compatibility requirements

Tests must prove all of the following independently:

```text
v0.1 experiment behavior unchanged
non-experiment behavior unchanged
v0.2 exact frozen values
v0.2 exact 30U margin budget
v0.2 exact 150U planned notional arithmetic
unsupported version rejected
malformed version rejected
v0.2 live mode rejected
single-venue/single-market experiment restriction preserved
legacy venue-specific defaults unchanged outside experiment mode
```

Do not delete, weaken, skip, or rewrite historical safety tests merely to make the new profile pass.

## 7. Scope

Initially allowed production paths:

```text
.env.example
src/config.ts
src/types.ts                 # only if a type boundary genuinely requires it
```

Allowed test/support paths:

```text
test/experiment-config.test.ts
test/experiment-v02-config.test.ts
test/helpers/env.ts
```

`package.json` may be changed only if needed to register a new focused test file.

Documentation may be changed only for Checkpoint A evidence. Do not modify the authoritative numerical contract to match implementation.

If another production path is required, stop with:

```text
BLOCKED_SCOPE_CHANGE_REQUIRED
```

and identify the exact path and invariant.

## 8. Explicitly prohibited

Do not modify or implement:

```text
src/experimentRisk.ts
src/experimentKillSwitch.ts
src/runtimeLease.ts
src/loop.ts
src/grid.ts
src/venues/**
vendor/**
dashboard mutation behavior
actual-notional reduction/flatten
execution journal/FILL provenance
planner deduplication
strategy optimization
profitability tuning
deployment/service files
```

Also prohibited:

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USE=NO
DEPLOYMENT=NO
MERGE=NO
FORCE_PUSH=NO
CHECKPOINT_B_STARTED=NO
RISK_THRESHOLD_REDUCTION=NO
TEST_WEAKENING=NO
```

Checkpoint A must not modify venue write behavior.

## 9. Mandatory focused tests

Use stable case IDs for at least:

```text
A1  v0.2 resolves 100U capital
A2  v0.2 resolves 5x leverage for every experiment grid configuration
A3  v0.2 resolves 0.30 margin fraction and exact 30U margin budget
A4  v0.2 resolves 10 grid levels
A5  v0.2 resolves 0.03 / ±3% half-band
A6  v0.2 resolves 150U max gross notional
A7  v0.2 resolves 5U daily-loss threshold
A8  v0.2 resolves 10U drawdown threshold
A9  v0.2 resolves 0.01 boundary buffer
A10 unsupported/malformed spec version fails closed
A11 historical v0.1 values and behavior remain unchanged
A12 non-experiment defaults remain unchanged
A13 v0.2 `DRY_RUN=0` + `LIVE_CONFIRM=YES` is still rejected
A14 single venue / single market restriction remains enforced
A15 v0.2 full-grid sizing arithmetic cannot exceed 150U from the frozen profile
```

No real exchange/network call is required or authorized.

## 10. Validation

Run at minimum:

```bash
node --version
npm --version
npm ci
npm run check
node --import tsx --test test/experiment-v02-config.test.ts
git diff --check
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
```

If the focused tests are integrated into an existing test file, run that exact focused file instead and report why.

Run a changed-file secret scan. Never print secret values.

## 11. Handoff evidence

After implementation, push bounded commits only to:

```text
experiment/classic-v0.2-100u-safety
```

Then stop and return:

```text
CHECKPOINT=A
STATUS=<READY_FOR_REVIEW|BLOCKED>
REPOSITORY=danny0971haha/classic-grid
BRANCH=experiment/classic-v0.2-100u-safety
BASE_SHA=<actual pulled checkpoint base>
HEAD_SHA=<candidate>
TREE_SHA=<candidate tree>

COMMITS:
<exact list>

CHANGED_FILES:
<exact list>

DIFF_STAT:
<exact output>

TESTS:
<commands, exit codes, totals>

CONFIG_EVIDENCE:
<v0.1 compatibility, v0.2 frozen profile, legacy compatibility, live rejection>

ARTIFACTS:
<patch URL/path, bytes/LF/SHA-256 if produced>

PROHIBITED_ACTION_ATTESTATION:
LIVE_EXCHANGE_WRITE=NO
DEPLOYMENT=NO
MERGE=NO
CHECKPOINT_B_STARTED=NO

KNOWN_LIMITATIONS:
<explicit list>

REQUESTED_VERDICT=<PASS|REJECT|BLOCKED>
```

The implementation agent must not self-declare Checkpoint A PASS. Stop after handoff.
