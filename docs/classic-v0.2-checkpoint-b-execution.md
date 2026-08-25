# Classic Grid v0.2 — Checkpoint B Execution Contract

**Status:** AUTHORIZED AFTER INDEPENDENT CHECKPOINT A PASS
**Date:** 2026-08-23
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-100u-safety`
**Accepted Checkpoint A candidate:** `0ebd16161ed2e72f365c1378a7ca1b8533413414`
**Checkpoint A CI:** `32582704477` — success, `140/140` tests
**Parent contract:** `docs/classic-v0.2-implementation-contract.md`

## 1. Authorization

Implement **Checkpoint B only — actual-notional hard halt plus verified full flatten**.

```text
GATE_0=PASS
CHECKPOINT_A=PASS
CHECKPOINT_B_AUTHORIZED=YES
CHECKPOINT_C_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

Stop after Checkpoint B implementation and evidence. Do not begin Checkpoint C.

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

Use the actual pulled HEAD as `BASE_SHA`.

Read completely before editing:

```text
docs/classic-v0.2-implementation-contract.md
docs/experiment-spec-v0.2-100u-safety.md
docs/classic-v0.2-checkpoint-b-execution.md
```

## 3. Binding safety decision

For v0.2:

```text
ACTUAL_NOTIONAL_CAP (>150U)
=
HARD HALT
+
ACTIVE FULL FLATTEN
+
FRESH AUTHORITATIVE SNAPSHOT VERIFICATION
```

The following are not accepted substitutes:

```text
cancel-only
reduceOnly flag without a reduction write
submit ACK treated as flat
cached/stale snapshot treated as proof
position later falling below cap followed by automatic reseed
```

`150.00U` is not a breach. Any value strictly above `150.00U`, after the existing calculation tolerance contract, is a breach.

Partial reduction back to the cap is outside this checkpoint. The v0.2 safe minimum is full flatten to zero within an explicit quantity tolerance.

## 4. Distinguish planned and actual notional

Required semantics:

- `PLANNED_NOTIONAL_CAP` may block placements and retain only safe cancellation/reconciliation work.
- `ACTUAL_NOTIONAL_CAP` must set `halt=true`, preserve/mint the incident `haltId`, and enter the halt/reduction lifecycle.
- The actual-position breach must never degrade into the existing cancel-only `filterRiskIncreasingIntents()` behavior.
- Once the actual-position incident exists, the process remains non-running even if a later snapshot is below 150U or flat.

## 5. Required lifecycle

Equivalent names are allowed, but observable state must distinguish:

```text
NORMAL
HALTING
CANCELLING_OWNED_RISK
REDUCING_EXPOSURE
HALTED_UNFLAT
HALTED_FLAT
HALT_FAILED
```

For an actual-position breach:

1. assert the current runtime lease;
2. mint or preserve one incident `haltId`;
3. latch halt in memory before any further normal planner action;
4. persist and verify `HALTING` when durable authority remains available;
5. block all new placements, reseeding, and normal planner-state advancement;
6. cancel experiment-owned risk-increasing orders only;
7. reconcile cancellation ambiguity; never assume cancellation from an ACK alone when the venue contract does not prove final absence;
8. invoke a dedicated exposure-reduction/full-flatten capability;
9. fetch a fresh authoritative post-write snapshot;
10. verify both:
    - absolute position is within the explicit flat tolerance;
    - no experiment-owned risk-increasing open order remains;
11. persist `HALTED_FLAT`, `HALTED_UNFLAT`, or `HALT_FAILED` with the same incident `haltId`;
12. remain halted until a later separately reviewed manual acknowledgement and restart/reconciliation path succeeds.

A successful flatten must never automatically return the process to `RUNNING`.

## 6. Dedicated reduction boundary

Do not encode flattening as a normal grid `place` intent.

Introduce or refine an explicit project-owned boundary, for example:

```ts
type ReductionWriteOutcome = "ACK" | "REJECTED" | "UNKNOWN" | "NOT_SENT";

type ReductionRequest = {
  market: string;
  targetAbsPositionQty: 0;
  incidentId: string;
  leaseGeneration: string;
};

type ReductionResult = {
  outcome: ReductionWriteOutcome;
  exchangeOrderId?: string;
  clientOrderId?: string;
  reasonCode?: string;
};
```

Names may differ, but semantics must prove:

- request identity is bound to the halt incident;
- stale lease generation cannot transmit;
- the write is venue-native reduce-only/close-only;
- the write cannot increase absolute exposure for either long or short inventory;
- retry after `UNKNOWN` does not create an unrelated second mutation;
- `ACK` means only the method-specific venue acknowledgement, not verified flat state;
- `REJECTED`, `UNKNOWN`, and `NOT_SENT` remain distinct.

The existing Extended vendor `closePosition(marketId, sizeBase?)` primitive may be adapted through the project-owned boundary, but no wholesale third-party commit import is authorized.

## 7. Lease and persistence rules

Immediately before every cancellation or reduction transport boundary:

```text
current runtime lease must be asserted
```

Required behavior:

- lease loss before cancellation -> no cancellation write;
- lease loss after cancellation but before flatten -> no flatten write and remain halted;
- lease loss after flatten submit -> fresh reconciliation only; never assume success;
- stale owner cannot submit or verify reduction after a newer fencing generation exists;
- persistence failure does not authorize normal trading;
- persistence failure may still allow explicitly fenced emergency risk-reducing actions;
- unresolved persistence/session state must block restart reseeding.

Reuse the accepted Gate 0 durable ACK/session/fencing invariants. Do not weaken or bypass them.

## 8. Snapshot verification

A reduction is verified only from a **fresh authoritative snapshot obtained after the relevant mutation attempt**.

The verifier must reject:

```text
cached snapshot
pre-write snapshot
missing observation time
stale observation
ambiguous source generation
position outside flat tolerance
remaining owned risk-increasing order
unowned/ambiguous order incorrectly treated as safely cancelled
```

Define the flat quantity tolerance explicitly and conservatively. It must not be chosen from the observed position merely to make a test pass.

`HALTED_FLAT` requires all verification conditions. Otherwise persist `HALTED_UNFLAT` or `HALT_FAILED` and remain non-running.

## 9. Scope

Initially allowed production paths:

```text
src/types.ts
src/experimentRisk.ts
src/experimentKillSwitch.ts
src/loop.ts
src/venues/types.ts
src/venues/extended.ts
src/experimentReduction.ts       # optional new bounded module
```

`src/runtimeLease.ts` may be changed only if an existing fencing seam is demonstrably insufficient; if so, explain the exact invariant in the evidence packet and keep the change minimal.

Allowed tests/support:

```text
test/experiment-risk.test.ts
test/experiment-killswitch.test.ts
test/experiment-v02-reduction.test.ts
test/fixtures/**
test/helpers/**
```

`package.json` may change only to register focused tests.

If another production path is required, stop with:

```text
BLOCKED_SCOPE_CHANGE_REQUIRED
```

and identify the exact path and invariant.

## 10. Explicitly prohibited

Do not implement or modify:

```text
Checkpoint C execution journal / FILL provenance
Checkpoint D planner deduplication
Checkpoint E integrated campaign
other venue adapters
strategy profitability or grid geometry
v0.2 frozen configuration values
dashboard trading controls
deployment/service files
live allowlist
```

Also prohibited:

```text
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
PRODUCTION_API_KEY_USE=NO
DEPLOYMENT=NO
MERGE=NO
FORCE_PUSH=NO
CHECKPOINT_C_STARTED=NO
RISK_THRESHOLD_REDUCTION=NO
TEST_WEAKENING=NO
```

All write behavior must be exercised through dry-run/test doubles only. Do not contact a real venue.

## 11. Mandatory focused tests

Use stable IDs covering at least:

```text
B1  actual notional exactly 150.00U does not breach
B2  actual notional >150.00U hard-halts
B3  actual breach invokes active flatten, not cancel-only
B4  long position selects only exposure-reducing direction
B5  short position selects only exposure-reducing direction
B6  reduction rounding cannot increase absolute exposure
B7  incident haltId is preserved through HALTING -> HALTED_UNFLAT/HALTED_FLAT
B8  cancellation failure remains halted
B9  cancellation UNKNOWN requires reconciliation and remains halted
B10 flatten REJECTED remains halted
B11 flatten UNKNOWN remains halted and is not blindly retried with unrelated identity
B12 flatten ACK without fresh snapshot is not verified
B13 fresh snapshot still non-flat -> retry boundedly or HALTED_UNFLAT
B14 stale/pre-write snapshot cannot produce HALTED_FLAT
B15 flat snapshot with remaining owned risk-increasing order cannot produce HALTED_FLAT
B16 verified flat + no owned risk-increasing orders -> HALTED_FLAT, never RUNNING
B17 lease loss before cancel -> NOT_SENT/no transport
B18 lease loss between cancel and flatten -> no flatten transport, remain halted
B19 persistence failure still permits only fenced emergency reduction
B20 restart at every lifecycle stage cannot reseed
B21 successful flatten never auto-clears the halt
B22 stale owner cannot mutate after fencing generation turnover
```

Use test doubles and fresh process reloads where restart/durable claims are made.

## 12. Validation

Run at minimum:

```bash
node --version
npm --version
npm ci
npm run check
node --import tsx --test test/experiment-v02-reduction.test.ts
git diff --check
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
```

Run a changed-file secret scan. Never print credential values.

Report exact test totals and exit codes. Green CI alone is insufficient without the focused lifecycle evidence.

## 13. Handoff

Push bounded commits only to:

```text
experiment/classic-v0.2-100u-safety
```

Then stop and return:

```text
CHECKPOINT=B
STATUS=<READY_FOR_REVIEW|BLOCKED>
REPOSITORY=danny0971haha/classic-grid
BRANCH=experiment/classic-v0.2-100u-safety
BASE_SHA=<actual pulled base>
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

REDUCTION_EVIDENCE:
<threshold, long/short direction, outcome semantics, identity, lease fencing>

SNAPSHOT_VERIFICATION_EVIDENCE:
<freshness, flat tolerance, owned-order absence, final halt state>

RESTART_FAULT_MATRIX:
<case | lifecycle point | observed durable/runtime state | reseed blocked>

ARTIFACTS:
<patch path/URL, bytes, LF count, SHA-256>

PROHIBITED_ACTION_ATTESTATION:
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
DEPLOYMENT=NO
MERGE=NO
CHECKPOINT_C_STARTED=NO

KNOWN_LIMITATIONS:
<explicit list>

REQUESTED_VERDICT=<PASS|REJECT|BLOCKED>
```

The implementation agent must not self-declare Checkpoint B PASS. Stop after handoff.
