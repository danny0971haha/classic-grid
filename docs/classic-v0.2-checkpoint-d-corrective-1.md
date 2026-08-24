# Classic Grid v0.2 — Checkpoint D Corrective 1

**Status:** CHECKPOINT_D_CORRECTIVE_1_REVIEW_CANDIDATE / INDEPENDENT REVIEW REQUIRED  
**Date:** 2026-08-24  
**Repository:** `danny0971haha/classic-grid`  
**Branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`  
**Current task:** `CHECKPOINT_D_CORRECTIVE_1`

This document does **not** declare Checkpoint D PASS. CI success is not a gate verdict. The implementation agent must not self-declare PASS.

```text
CHECKPOINT=D_CORRECTIVE_1
REQUESTED_GATE=CHECKPOINT_D_CORRECTIVE_1_REVIEW
CHECKPOINT_C=PASS
ACCEPTED_CHECKPOINT_C_HEAD=13a96e12b7fc29485cb46fe471fb3cf5c0604404
ACCEPTED_CHECKPOINT_C_TREE=b019ef52da1d14051781ecd63334def0dfc6463c
REJECTED_CHECKPOINT_D_HEAD=ab673cadc8a12afb3051c5bbeb8ca53545de27f6
REJECTED_CHECKPOINT_D_TREE=1b49f2a6d08f8ddd4521bb799fc737a1774955c7
CHECKPOINT_D=REVIEW_CANDIDATE
CHECKPOINT_D_CORRECTIVE_1=REVIEW_CANDIDATE
CHECKPOINT_D_SELF_DECLARED_PASS=NO
CHECKPOINT_E_SELF_DECLARED_PASS=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
```

## Binding

```text
EXPECTED_START_HEAD=ab673cadc8a12afb3051c5bbeb8ca53545de27f6
EXPECTED_START_TREE=1b49f2a6d08f8ddd4521bb799fc737a1774955c7
IMPLEMENTATION_HEAD=161a62aadd1227acd7b2e5264baf1adc1167a37c
IMPLEMENTATION_TREE=39dc032b8ced106f7955329644dfaddd4a94c056
PRIOR_TEST_TOTAL=301
PRIOR_TEST_PASS=301
PRIOR_TEST_FAIL=0
PRIOR_TEST_SKIP=0
```

Current-byte check at start: HEAD and TREE matched `EXPECTED_START_*`. Working tree was clean. Branch was ff-only with `origin/experiment/classic-v0.2-100u-safety`. No reset and no force-push.

Local toolchain at start: Node v26.5.0 / npm 11.17.0. GitHub Actions must prove Node v22.23.2 / npm 10.9.8.

## BLOCKER_DISPOSITION

```text
BLOCKER_ID=D-CORR1-BLOCKER-01
BLOCKER=CANCEL_INTENT_PREMATURELY_FREES_MAX_OPEN_ORDER_CAPACITY
DISPOSITION=FIXED_IN_CANDIDATE

BLOCKER_ID=D-CORR1-BLOCKER-02
BLOCKER=CROSS_MARKET_OWNED_ORDER_CANCEL_USES_WRONG_MARKET
DISPOSITION=FIXED_IN_CANDIDATE

BLOCKER_ID=D-CORR1-BLOCKER-03
BLOCKER=UNLOCATABLE_AMBIGUITY_DOES_NOT_SUPPRESS_NEW_RISK
DISPOSITION=FIXED_IN_CANDIDATE
```

### D-CORR1-BLOCKER-01

The rejected planner subtracted `emittedCancelIds` from `remainingOnVenue` before computing place slots. Cancel intent, cancel submit, and cancel ACK are not authoritative absence.

Corrective 1 counts every currently visible snapshot observation, including survivors, planned cancels, malformed/stale owned orders, unowned orders, ambiguous/conflicting observations, and cancel candidates beyond `maxWrites`. Capacity is:

```text
currentSnapshotVenueCount = unresolvedVenueCount + collapsedObservations
capacityAfterAuthoritativeSnapshot = max(0, maxOpenOrders - currentSnapshotVenueCount)
```

`capacityAfterAuthoritativeSnapshot` does not increase in the same cycle because a cancel intent was emitted. A later authoritative snapshot that no longer contains the order is the only release.

### D-CORR1-BLOCKER-02

Cross-market owned observations were classified as `MALFORMED_OWNED` and cancelled with `{ market: p.market }`.

This corrective uses fail-closed Option A:

```text
CROSS_MARKET_OWNED_ORDER
-> never cancel from this per-market planner
-> never claim
-> never enter nextActive
-> emit stable CROSS_MARKET_OWNED_ORDER diagnostic
-> plannerDisposition = RISK_INCREASE_BLOCKED
-> zero new place intents
```

Cross-market cancel transport is not added in this checkpoint.

### D-CORR1-BLOCKER-03

Ambiguous / same-ID conflict / cross-market / unlocatable malformed owned observations now set an explicit production-consumed disposition:

```ts
type PlannerDisposition =
  | "CLEAR"
  | "CANCEL_ONLY_RECONCILIATION"
  | "RISK_INCREASE_BLOCKED";
```

`loop.ts` calls `applyPlannerIntentGate(planFromFillsAndSeed(...))`. Any disposition other than `CLEAR` retains only cancel intents. Independently proven-safe owned malformed/stale cancels may still emit. Unowned/manual orders are never cancelled or claimed; they still occupy venue capacity. Locatable unowned orders block their slot. Unlocatable unowned orders that may belong to the current market set `RISK_INCREASE_BLOCKED`.

## Required planner fields

`planFromFillsAndSeed()` now returns explicit fields:

```text
currentSnapshotVenueCount
plannedCancelCount
capacityAfterAuthoritativeSnapshot
plannerDisposition
riskIncreaseBlocked
```

Preserved Checkpoint D invariants: logical slot = market + anchorEpoch + side + levelIndex; opaque-string comparator; permutation independence; same-ID collapse / conflict; deterministic survivor and cancel order; cancel before place; disappearance is not FILL; `filled=[]`; `completedRungs=0`; no unowned cancellation; no inferred execution.

## D corrective matrix

| ID | Case | Result |
|---|---|---|
| D-C1-01 | `maxOpenOrders ==` visible count; duplicate cancel emitted | zero place |
| D-C1-02 | `maxOpenOrders ==` visible count + 1 | one pre-existing hole only |
| D-C1-03 | later snapshot omits cancelled order | capacity released only then |
| D-C1-04 | cancel REJECTED/UNKNOWN modeled as still-visible order | capacity unchanged |
| D-C1-05 | cancel candidate beyond `maxWrites` | still counted; slot blocked |
| D-C1-06 | cross-market owned | zero cancel/claim/place; `CROSS_MARKET_OWNED_ORDER` |
| D-C1-07 | cross-market owned | never cancel with `p.market` |
| D-C1-08 | unlocatable ambiguous owned | `RISK_INCREASE_BLOCKED`; zero place |
| D-C1-09 | unlocatable same-ID conflict | zero place globally |
| D-C1-10 | real `planFromFillsAndSeed()` result through loop gate | proven-safe cancel survives; place = 0 |
| D-C1-11 | permutations after new fields | byte-identical |
| D-C1-12 | D-01..D-21, C-C16..C-C24, prior suite | remain and are not weakened |

## FILES_CHANGED

Allowed paths only:

| File | Why |
|---|---|
| `src/grid.ts` | snapshot capacity; Option A cross-market; disposition |
| `src/types.ts` | `PlannerDisposition`, `CROSS_MARKET_OWNED` |
| `src/loop.ts` | consume `applyPlannerIntentGate` |
| `test/experiment-v02-planner-dedup.test.ts` | D-09 fail-closed; serialize new fields |
| `test/experiment-v02-planner-dedup-corrective-1.test.ts` | D-C1-01..D-C1-12 |
| `package.json` | register corrective tests |
| `docs/classic-v0.2-checkpoint-d-corrective-1.md` | this evidence note |

Unchanged on purpose:

```text
src/venues/extendedAccountStream.ts
Checkpoint C cursor persistence protocol
execution journal authority
risk thresholds
Checkpoint B reduction/flatten semantics
runtime lease implementation
vendor/**
dashboard mutation endpoints
deployment/service files
live authorization
capital/leverage/grid envelope
dependency versions
```

## COMMANDS_AND_EXIT_CODES

| Command | Exit |
|---|---|
| `git status --short` (start) | 0, empty |
| `git branch --show-current` | 0, `experiment/classic-v0.2-100u-safety` |
| `git rev-parse HEAD` (start) | 0, `ab673cadc8a12afb3051c5bbeb8ca53545de27f6` |
| `git rev-parse HEAD^{tree}` (start) | 0, `1b49f2a6d08f8ddd4521bb799fc737a1774955c7` |
| `node --version` (local) | 0, `v26.5.0` |
| `npm --version` (local) | 0, `11.17.0` |
| `npm ci` | 0 (printed 22 vulnerabilities; not hidden) |
| `npm run typecheck` | 0 |
| focused D + D-C1 tests | 0 |
| `npm run check` | 0 |
| `npm audit --json` | 1 (inventory only; no upgrade and no `--force`) |
| `git diff --check` | 0 |

## TEST_TOTAL_PASS_FAIL_SKIP

Focused:

```text
tests 33
pass 33
fail 0
skipped 0
```

Full `npm run check` node:test runner (excludes `grid.test.ts` script, which printed `grid.test.ts OK`):

```text
tests 313
pass 313
fail 0
cancelled 0
skipped 0
todo 0
```

Prior node:test total was 301. This corrective adds D-C1-01..D-C1-12 (12 tests). `301 + 12 = 313`. Gate 0, A, B, C, C-C16..C-C24, and D-01..D-21 remain and were not weakened.

## AUDIT_SUMMARY

`npm audit --json` (audit report version 2). **Not fixed in this checkpoint.** Warnings are not hidden.

```text
vulnerabilities: 22 (0 info, 0 low, 8 moderate, 14 high, 0 critical)
dependency counts reported by audit: prod=302, dev=0, optional=31, peer=33, total=364
```

Inventory is unchanged versus the accepted Checkpoint C / rejected Checkpoint D baseline. No `npm audit fix` and no `npm audit fix --force` were run. No dependency was added.

## SECRET_SCAN

Changed paths only. Rule names, no values:

```text
src/grid.ts — no credential/private-key matches
src/types.ts — no matches
src/loop.ts — no matches
test/experiment-v02-planner-dedup.test.ts — asserts absence of LIVE_CONFIRM / API_SECRET / PRIVATE_KEY
test/experiment-v02-planner-dedup-corrective-1.test.ts — no secrets
package.json — no matches
docs/classic-v0.2-checkpoint-d-corrective-1.md — no secrets
```

## KNOWN_LIMITATIONS

- This note does not declare Checkpoint D PASS.
- Checkpoint E, if started after this Stage 1 hard gate, remains a separate review candidate.
- Execution records still do not advance planner completed-rung or `plan.filled`.
- `plan.filled=[]` and `completedRungs=0` remain required; disappearance is not FILL.
- Directory-fsync SIGKILL proof for Checkpoint C remains Ubuntu CI.
- Local verification used Node v26.5.0 / npm 11.17.0. CI pin is Node v22.23.2 / npm 10.9.8.
- No production credentials. No live exchange write. No real-fund testing.
- 22 npm audit findings remain open on purpose.
- Planner produces `CLEAR` or `RISK_INCREASE_BLOCKED`. `CANCEL_ONLY_RECONCILIATION` is part of the audited type and is treated as non-`CLEAR` by `applyPlannerIntentGate`.
- Upstream `beibei030/classic-grid@e26ab196e01245ad70d0eb41e1b7ffc64249cd44` was not cherry-picked.

## Independent review

The independent reviewer owns `PASS`, `REJECT`, or `BLOCKED`.

```text
CHECKPOINT_D_SELF_DECLARED_PASS=NO
CHECKPOINT_D_CORRECTIVE_1=REVIEW_CANDIDATE
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
```
