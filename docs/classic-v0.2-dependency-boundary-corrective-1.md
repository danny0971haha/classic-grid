# Dependency boundary corrective 1

**Date:** 2026-08-26
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-100u-safety`
**Draft PR:** `#3`
**Task:** `CHECKPOINT_F_DEPENDENCY_BOUNDARY_CORRECTIVE_1`

This document does **not** declare independent acceptance, Checkpoint F PASS, live authorization, merge, or deploy.

```text
CHECKPOINT_F_IMPLEMENTATION=ACCEPT
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_2=ACCEPT_AT_EXACT_HEAD
GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=NO
DEPENDENCY_SECURITY_CLEARANCE=NO
EXTENDED_CANARY_DEPENDENCY_BOUNDARY=HISTORICAL_RECORD
CURRENT_REVIEW_CANDIDATE=CHECKPOINT_F_CI_HARDENING_CORRECTIVE_3
LIVE_RELEASE_BLOCKED=YES
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
independentReview=NOT_PERFORMED
gateStatus=NOT_EMITTED
```

## Starting identity

```text
BASE_SHA=514853fd480d915491595fca4a73667087b9e3b9
```

Frozen 100U limits and Checkpoint E/F trading/risk/execution semantics are unchanged.

## Why isolation instead of root remediation

Root `npm audit --omit=dev` remains **14 high / 0 critical / 22 total**. The High rows enter through N1/Solana (`@n1xyz/*`, `@solana/*`, `bigint-buffer`) and Nado/PopDEX (`@nadohq/*`, `axios`, `viem`, nested `ws@8.20.1`). Those packages are still required by legacy venue adapters in the general repository.

Investigation order:

1. Unused direct dependency removal — `@n1xyz/nord-ts`, `@nadohq/client`, `@nadohq/shared`, `viem`, and `ws` all have repository import sites. Not removed from root.
2. Compatible patched versions — vendor `fixAvailable` values include forbidden major downgrades; `viem`/`axios` patches would change frozen venue SDK ABI without tests.
3. Proven overrides — not applied; no ABI suite for nested `ws` or axios interceptors.
4. Lazy adapter loading — insufficient by itself: packages would remain in the root production lockfile.
5. Isolated Extended-canary production package — selected.
6. Full monorepo rewrite — not required once (5) provides an auditable lockfile.

## Design selected

An isolated package at `packages/extended-canary` with its own `package.json` and `package-lock.json`. Production dependencies are only `tsx`, `undici`, and `ws`.

The general CLI still supports every venue via `src/venues/index.ts`. The canary CLI (`src/cli/run-extended-canary.ts`) injects:

- `createExtendedCanaryExecutor` — constructs Extended only; any other venue throws `CANARY_VENUE_UNAVAILABLE:<id>`
- offline official-stats stubs — no N1/Nado/Phoenix/PopDEX SDK import and no outbound stats fetch

`src/loop.ts` no longer statically imports `src/venues/index.ts` or `src/officialStats.ts`. Defaults are loaded only when bindings are omitted. Canary startup therefore does not load unselected venue adapters.

This is safer than a root lockfile rewrite because:

- frozen adapter code is not edited
- root High findings stay visible instead of being suppressed
- the canary artifact can be installed in a clean directory and audited independently

## What this is not

```text
GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=NO
LIVE_RELEASE_BLOCKED=YES
LIVE_EXCHANGE_WRITE=false
PRODUCTION_CREDENTIAL_USED=false
REAL_FUND_TESTING_AUTHORIZED=false
MERGE_AUTHORIZED=false
DEPLOYMENT_AUTHORIZED=false
NEXT_CHECKPOINT_STARTED=NO
```

Root/global production audit High findings remain. The Extended canary isolation in this historical Corrective 1 record is **not** the current review candidate. See `docs/classic-v0.2-checkpoint-f-ci-hardening-corrective-3.md`.
