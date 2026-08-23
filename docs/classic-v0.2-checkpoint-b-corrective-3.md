# Classic Grid v0.2 — Checkpoint B Corrective 3

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE CANDIDATE / INDEPENDENT REVIEW REQUIRED  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/classic-grid`  
**Implementation branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`  
**Rejected base SHA:** `fca48c53799cf069247131d6f25e47a67707154e`  
**Rejected base tree:** `b2bd91a9bdd92658f83f6fa93a2957979948f352`  
**Current gate:** Checkpoint B remains REJECT. This change is Corrective 3 only.

This document does **not** declare Checkpoint B PASS. CI success is not a gate verdict.

```text
CHECKPOINT_B=REJECT
CHECKPOINT_C_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH_AUTHORIZED=NO
```

## 1. Root causes

Corrective 2 bound physical flatten identity and per-attempt verification barriers, but the halt path could still flatten while cancel authority was unproven, treat opposite-side sized orders as safe, lose retry-attempt identity after a transport throw, infer `NOT_SENT` from message regex, and accept temporally impossible snapshots.

| ID | Root cause |
|---|---|
| C3-R1 | Cancel ACK / UNKNOWN / REJECTED / partial did not require a new post-barrier authoritative snapshot proving targeted unsafe owned orders were gone before flatten. |
| C3-R2 | `isOwnedRiskIncreasingOrder()` used per-order remaining qty versus current position. At `targetAbsPositionQty=0`, every owned non-reduce-only open order can recreate exposure after flatten. |
| C3-R3 | `submitPhysical()` rethrew after allocating the current attempt. The outer catch could leave `flatten` pointing at the previous attempt. |
| C3-R4 | Physical ACK was accepted without a project-owned identity/normalization boundary. Message regex could promote `LEASE_MISSING` / `NOT_SENT` after transport entry. `ALREADY_FLAT_POSITION` was returned as a physical ACK. |
| C3-R5 | `verifyFlattenSnapshot()` trusted `observedAt` against the barrier and did not reject future evidence or require finite local `capturedAtMs >= verificationBarrierAtMs`. |
| C3-R6 | Several halt-failure reasons existed only in transient `errors` / console text, not as stable durable halt reasons. |

## 2. Exact changed files

| File | Why |
|---|---|
| `src/experimentReduction.ts` | Cancel attempt context + post-cancel reconciliation; aggregate unsafe-order targeting; `normalizeReductionResult()`; `submitPhysical()` always returns a bound result; snapshot temporal fence; durable audit reasons |
| `src/venues/extended.ts` | Post-transport flatten receipts/errors pass through `normalizeReductionResult()` |
| `test/experiment-v02-reduction.test.ts` | C3-1..C3-19; B3/B16 fixtures supply a post-cancel live-position snapshot so flatten is still exercised |
| `test/helpers/reduction.ts` | Offline branded `LOCAL_TRANSPORT_NOT_SENT` helper and ACK factory |
| `docs/classic-v0.2-checkpoint-b-corrective-3.md` | This evidence note |

No Checkpoint C execution journal, fill provenance, planner dedup, deployment, live allowlist, vendor, or grid-geometry change is included.

`src/venues/types.ts` was inspected and not modified.

## 3. Final semantics

### Cancel before flatten

Each cancel transport records an independent `CancelAttemptContext`:

```text
requestStartedAtMs
verificationBarrierAtMs
incidentId
leaseGeneration
targetedExchangeOrderIds
```

Cancel return or throw records the post-call barrier. If any experiment-owned unsafe order was targeted, flatten transport is withheld until a **new** authoritative snapshot proves:

- local `capturedAtMs` is finite and `>=` the cancel barrier;
- lease generation matches;
- observation ID and source generation are non-empty;
- the observation was not previously consumed;
- every targeted unsafe owned order is absent;
- no other owned non-reduce-only open order remains.

Cancel ACK is not absence proof. UNKNOWN / REJECTED / partial may continue to flatten only when that independent snapshot proves absence. Otherwise:

```text
flattenCalls=0
lifecycle=HALTED_UNFLAT or HALT_FAILED
reseedAllowed=false
```

Successful cancel reconciliation may recompute flatten side/qty from the **latest** authoritative position.

### Unsafe owned orders at target zero

Full-flatten hard halt uses `targetAbsPositionQty=0`. Every experiment-owned open order that is not strictly `reduceOnly === true` is a cancel target. Missing, false, or otherwise non-proven `reduceOnly` is unsafe. Venue-proven reduce-only orders remain excluded and cannot authorize new exposure or `RUNNING`.

### Retry throw identity

`submitPhysical()` never rethrows after the transport boundary. An unclassified throw after entry normalizes to:

```text
outcome=UNKNOWN
```

and retains attempt, requested client order ID, side, quantity, `requestStartedAtMs`, and `verificationBarrierAtMs`. After retry-attempt UNKNOWN:

- no third mutation;
- exactly one authoritative reconciliation of that retry attempt;
- `HALTED_FLAT` only from a new post-barrier snapshot;
- returned `flatten` points at the retry attempt, not the previous one.

### Result normalization

`normalizeReductionResult(request, rawResultOrError)` is the project-owned boundary.

Physical ACK requires all of:

```text
raw outcome == ACK
requestedClientOrderId == request.clientOrderId
submittedExternalId == request.clientOrderId
```

Otherwise:

```text
outcome=UNKNOWN
reasonCode=REDUCTION_IDENTITY_MISMATCH
```

`undefined` / `null` / non-object / unknown outcome / malformed result → `UNKNOWN` / `REDUCTION_RESULT_MALFORMED`.

`NOT_SENT` requires `{ kind: "LOCAL_TRANSPORT_NOT_SENT", transportCalled: false, stage: "LEASE" | "PREFLIGHT" }` or a structured pre-transport result that did not enter venue write. Message regex is no longer used.

`REJECTED` requires a structured venue-rejection discriminator or an explicit structured `outcome=REJECTED` result. Parser / SDK / network / timeout / unclassified exceptions are `UNKNOWN`.

`ALREADY_FLAT_POSITION` is a local no-op: `outcome=NOT_SENT`, `physicalAttempt=0`. It is not a physical venue ACK.

### Snapshot temporal proof

`MAX_CLOCK_SKEW_MS = 2000` is fixed and tested. It is not enlarged from fixtures.

`verifyFlattenSnapshot()` / cancel reconciliation require:

```text
capturedAtMs is finite
capturedAtMs >= verificationBarrierAtMs
capturedAtMs <= nowMs + MAX_CLOCK_SKEW_MS
observedAt is parseable
observedAt <= nowMs + MAX_CLOCK_SKEW_MS
```

Remote/server time cannot replace the local post-call capture barrier. Cached / pre-write / stale / replayed observations remain rejected. Lease is asserted before the read, after the read, and before final persist.

### Stable audit reasons

Final halt `errors` and durable `haltReasons` distinguish at least:

```text
CANCEL_RECONCILIATION_UNPROVEN
UNSAFE_OWNED_ORDER_REMAINS
FLATTEN_ATTEMPT_UNKNOWN
REDUCTION_IDENTITY_MISMATCH
REDUCTION_RESULT_MALFORMED
FUTURE_OBSERVATION
REDUCTION_OBSERVATION_REPLAY
SNAPSHOT_FENCE_MISMATCH
```

## 4. Test matrix

| ID | Assertion |
|---|---|
| C3-1 | Cancel UNKNOWN + remaining dangerous order → `flattenCalls=0` |
| C3-2 | Cancel REJECTED + fresh snapshot proves absence → flatten from latest position |
| C3-3 | Cancel ACK without absence proof → `flattenCalls=0` |
| C3-4 | Pre-cancel / cached snapshot cannot authorize flatten |
| C3-5 | Long 1 + sell 0.6 + sell 0.6 non-reduce-only → both cancel targets |
| C3-6 | Long 1 + sell 0.4 non-reduce-only → cancel before full flatten |
| C3-7 | Venue-proven reduce-only remains excluded and does not authorize new exposure |
| C3-8 | Retry attempt 2 throw after transport → attempt 2 UNKNOWN + one reconciliation + no attempt 3 |
| C3-9 | Attempt 2 UNKNOWN + new post-barrier flat snapshot → `HALTED_FLAT` |
| C3-10 | Attempt 2 UNKNOWN + replayed snapshot → not `HALTED_FLAT` |
| C3-11 | ACK missing `submittedExternalId` → UNKNOWN |
| C3-12 | ACK mismatched `submittedExternalId` → UNKNOWN |
| C3-13 | Malformed / undefined result → UNKNOWN |
| C3-14 | Message-only `LEASE_MISSING` after transport entry → UNKNOWN |
| C3-15 | Branded pre-call lease failure → NOT_SENT and zero physical flatten calls |
| C3-16 | Future `observedAt` rejected |
| C3-17 | `capturedAtMs` before barrier rejected |
| C3-18 | Lease loss around cancel or flatten reconciliation cannot produce `HALTED_FLAT` |
| C3-19 | Prior B*, BC*, CB2*, C2*, Gate 0, and Checkpoint A tests remain present |

B3 and B16 fixtures now return a post-cancel snapshot that still carries the live position, then a later flat snapshot. Assertions were not relaxed.

## 5. Local command results

```text
git fetch --all --prune
git checkout experiment/classic-v0.2-100u-safety
git pull --ff-only
HEAD before edit = fca48c53799cf069247131d6f25e47a67707154e
TREE before edit = b2bd91a9bdd92658f83f6fa93a2957979948f352
node = v26.5.0
npm = 11.17.0

npm ci                         exit 0
npm run check                  exit 0   (214/214 pass, 0 fail)
node --import tsx --test test/experiment-v02-reduction.test.ts
                               exit 0   (74/74 pass, 0 fail)
git diff --check               exit 0
```

Changed-file secret scan (values not printed):

```text
RULE=GENERIC_API_KEY_ASSIGN PATH=test/helpers/reduction.ts
```

That hit is the pre-existing offline vendor fixture `offline-test-not-a-live-key` plus a documented dummy vendor key used only to construct an offline Extended object. No live credential, token, or environment secret was added.

## 6. Candidate binding

Implementation commit:

```text
IMPLEMENTATION_SHA=e9eda6d622f183d2a60ac16c9f0f2c58e5d479c8
IMPLEMENTATION_TREE=cc9002d5f8dd3caab1be808123217f380ca0f9e2
```

SHA-bind commit and its exact branch-push CI:

```text
BASE_SHA=fca48c53799cf069247131d6f25e47a67707154e
HEAD_SHA=90a450fa35cc3370f19ac6d2bcbdffc59a054ffc
TREE_SHA=7784a71c315ad3d5d872c6346dc2179d5c3403e3
CI_RUN_ID=32633798708
CI_EVENT=push
CI_URL=https://github.com/danny0971haha/classic-grid/actions/runs/32633798708
CI_HEAD_SHA=90a450fa35cc3370f19ac6d2bcbdffc59a054ffc
CI_CONCLUSION=success
CI_JOB=compiler-and-tests
CI_JOB_CONCLUSION=success
```

A later annotation commit may move `HEAD`. Independent review must re-bind to the final pushed SHA and the Actions run that checked out that exact SHA. The handoff block is authoritative for the final pair.

## 7. Stop authorization

```text
CHECKPOINT_C_STARTED=NO
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
DEPLOYMENT=NO
MERGE=NO
FORCE_PUSH=NO
REQUESTED_VERDICT=PASS
```

Independent review decides the verdict. This implementation agent does not declare `CHECKPOINT_B=PASS`.
