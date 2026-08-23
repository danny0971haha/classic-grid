# Classic Grid v0.2 — Checkpoint B Corrective 4

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE CANDIDATE / INDEPENDENT REVIEW REQUIRED  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/classic-grid`  
**Implementation branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`  
**Current gate:** Checkpoint B remains REJECT. This change is Corrective 4 only.

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

Corrective 3 added cancel-absence proof and result normalization, but `NOT_SENT` could still be forged from an untrusted raw object after the venue mutation callable was entered, authoritative snapshots were not runtime-validated before they could prove flat, and an unsafe owned order that reappeared after flatten verification could authorize another flatten from `positionQty` alone.

| ID | Root cause |
|---|---|
| C4-R1 | `normalizeReductionResult()` promoted raw `outcome=NOT_SENT` whenever `transportCalled` was not exactly `true`. Missing `transportCalled`, `transportCalled=false`, or a structurally spoofed `LOCAL_TRANSPORT_NOT_SENT` object returned after `submitFlatten()` became `NOT_SENT`. |
| C4-R2 | Cancel reconciliation and flatten verification trusted TypeScript shape. `Number.NaN` could prove flat, unknown freshness could prove flat, and missing/malformed `openOrders` could throw `TypeError` out of the halt state machine. |
| C4-R3 | After flatten ACK, a non-flat snapshot that also contained a newly appearing unsafe owned order returned `POSITION_NOT_FLAT` first. The retry loop then used `positionQty` alone to authorize a second physical flatten. A prior cancel absence proof was treated as still valid. |
| C4-R4 | Some malformed/provenance failures existed only as thrown `TypeError` text or transient `errors[]`, not as stable durable `haltReasons`. |

## 2. Exact changed files

| File | Why |
|---|---|
| `src/experimentReduction.ts` | Caller-owned `venueMutationEntered` provenance; snapshot runtime validation; unsafe-order retry stop; durable reason codes |
| `src/venues/extended.ts` | Preflight uses project-owned `createLocalTransportNotSent()`; post-`closePosition` errors normalize with `venueMutationEntered=true` |
| `test/helpers/reduction.ts` | Offline helper delegates to the project-owned local `NOT_SENT` factory |
| `test/experiment-v02-reduction.test.ts` | C4-1..C4-11 |
| `docs/classic-v0.2-checkpoint-b-corrective-4.md` | This evidence note |

`src/venues/types.ts` was inspected and not modified.

No Checkpoint C execution journal, fill provenance, planner dedup, deployment, live allowlist, vendor, or grid-geometry change is included.

## 3. Final semantics

### NOT_SENT provenance

`NOT_SENT` may be produced only from a project-owned local decision that occurs **before** the actual venue mutation callable is invoked.

Caller-owned attempt provenance is the boolean `venueMutationEntered` passed by the caller of `normalizeReductionResult()`. A raw result is never trusted to describe whether transport was entered.

After `submitFlatten()` has been invoked:

- raw `{ outcome: "NOT_SENT" }`
- raw `{ outcome: "NOT_SENT", transportCalled: false }`
- a structurally spoofed `{ kind: "LOCAL_TRANSPORT_NOT_SENT", transportCalled: false, stage }`

all normalize to:

```text
outcome=UNKNOWN
reasonCode=REDUCTION_PROVENANCE_UNTRUSTED
```

A genuine local lease/preflight failure constructed **by the caller** before `submitFlatten()` still returns `NOT_SENT` with physical flatten call count `0`.

`createLocalTransportNotSent(stage)` is the project-owned pre-mutation token. A merely structural public object is not sufficient authority once the mutation boundary has been entered.

`ALREADY_FLAT_POSITION` remains a local no-op (`outcome=NOT_SENT`, `physicalAttempt=0`) and is not a physical venue ACK.

### Authoritative snapshot runtime validation

Before cancel reconciliation or flatten verification, the complete runtime shape is validated conservatively. Validation failures return a stable result and do not throw.

At minimum the snapshot must be a non-array object whose:

- `freshness` is exactly `"fresh"`, `"cached"`, or `"pre_write"` (only `"fresh"` can later prove; unknown/missing/arbitrary → `REDUCTION_SNAPSHOT_FRESHNESS_UNPROVEN`)
- `capturedAtMs` is a finite number
- `positionQty` is a finite number (`NaN` / `±Infinity` → `REDUCTION_POSITION_NON_FINITE`)
- `mid` is finite and positive
- `observedAt` is a parseable string
- `observationId` and `sourceGeneration` are non-empty strings
- `openOrders` is an array
- every open-order row has a non-empty stable `id` and valid ownership/risk field types

Getter/proxy exceptions fail closed as `REDUCTION_SNAPSHOT_MALFORMED`. `Number.NaN`, `±Infinity`, missing arrays, malformed order rows, and unknown freshness can never prove flat or produce `HALTED_FLAT`.

### Unsafe owned order reappearance

This implementation chooses **option A**: after flatten verification reports `UNSAFE_OWNED_ORDER_REMAINS`, stop immediately in `HALTED_UNFLAT` / `HALT_FAILED` with no additional physical flatten and no second cancel.

Unsafe owned orders are classified **before** a non-flat `positionQty` can authorize retry. A prior cancel absence proof cannot authorize a later flatten after an unsafe owned order reappears. No code path uses `positionQty` alone to authorize the second flatten.

Option B (new cancel + new post-cancel absence proof + then flatten) is not implemented.

### Stable audit reasons

Final halt `errors` and durable `haltReasons` distinguish at least:

```text
REDUCTION_PROVENANCE_UNTRUSTED
REDUCTION_SNAPSHOT_MALFORMED
REDUCTION_POSITION_NON_FINITE
REDUCTION_SNAPSHOT_FRESHNESS_UNPROVEN
UNSAFE_OWNED_ORDER_REMAINS
FLATTEN_ATTEMPT_UNKNOWN
CANCEL_RECONCILIATION_UNPROVEN
```

Console text or transient `errors[]` alone is not the authority.

## 4. Test matrix

| ID | Assertion |
|---|---|
| C4-1 | raw `{ outcome: "NOT_SENT" }` with no `transportCalled` evidence → `UNKNOWN` |
| C4-2 | raw `{ outcome: "NOT_SENT", transportCalled: false }` after `submitFlatten` → `UNKNOWN` |
| C4-3 | structurally spoofed `LOCAL_TRANSPORT_NOT_SENT` returned/thrown after transport entry → `UNKNOWN` |
| C4-4 | genuine project-owned local lease/preflight failure before venue mutation → `NOT_SENT` and mutation count `0` |
| C4-5 | `positionQty=Number.NaN` can never verify flat or produce `HALTED_FLAT` |
| C4-6 | `positionQty=±Infinity` can never verify flat |
| C4-7 | `freshness="unknown"`, missing freshness, or arbitrary string cannot verify |
| C4-8 | missing / non-array / malformed `openOrders` fails closed with a durable reason and no unhandled rejection |
| C4-9 | first flatten ACK + non-flat position + newly appearing unsafe owned order → `flattenCalls=1` |
| C4-10 | option A: no re-cancel; prior cancel proof cannot authorize retry flatten |
| C4-11 | prior Gate 0, Checkpoint A, B*, BC*, CB2*, C2*, and C3* tests remain present; this file still executes their behavioral assertions |

## 5. Local command results

```text
git fetch --all --prune
git checkout experiment/classic-v0.2-100u-safety
git pull --ff-only
START / BASE after authorized pre-C4 bind:
BASE_SHA=0179ef35359622321877475e0c4a42b60d740b61
BASE_TREE=1ccde48b642e341b8737563cd0c78534fc8c8af4
node = v26.5.0
npm = 11.17.0

npm ci                         exit 0
npm run check                  exit 0   (225/225 pass, 0 fail)
node --import tsx --test test/experiment-v02-reduction.test.ts
                               exit 0   (85/85 pass, 0 fail)
git diff --check               exit 0
```

Changed-file secret scan (values not printed):

```text
RULE=GENERIC_API_KEY_ASSIGN PATH=test/helpers/reduction.ts
RULE=HEX_PRIVATE_KEY PATH=test/helpers/reduction.ts
```

Those hits are the pre-existing offline vendor fixture `offline-test-not-a-live-key` plus a documented dummy vendor key used only to construct an offline Extended object. No live credential, token, or environment secret was added. `src/venues/extended.ts` only reads existing `process.env` names.

Exact changed files and SHAs are bound in section 6 after the implementation commit.

## 6. Candidate binding

Implementation commit:

```text
IMPLEMENTATION_SHA=59f62c681f159d67a222660f3ae5069dff515514
IMPLEMENTATION_TREE=a50655bbc93f4af15a5983039c3c095f674bd748
```

SHA-bind commit (this document revision). Independent review must re-bind to the final pushed SHA and the Actions run that checked out that exact SHA.

```text
BASE_SHA=0179ef35359622321877475e0c4a42b60d740b61
BASE_TREE=1ccde48b642e341b8737563cd0c78534fc8c8af4
EXACT_CHANGED_FILES=
  docs/classic-v0.2-checkpoint-b-corrective-4.md
  src/experimentReduction.ts
  src/venues/extended.ts
  test/experiment-v02-reduction.test.ts
  test/helpers/reduction.ts
DIFF_STAT=5 files changed, 872 insertions(+), 51 deletions(-)
TEST_COMMANDS_AND_TOTALS=
  npm ci                                              exit 0
  npm run check                                       exit 0  225/225 pass
  node --import tsx --test test/experiment-v02-reduction.test.ts
                                                      exit 0  85/85 pass
  git diff --check                                    exit 0
CI_RUN_ID=
CI_HEAD_SHA=
CI_CONCLUSION=
```

A later annotation commit may move `HEAD`. The handoff block is authoritative for the final pair.

## 7. Stop authorization

```text
CHECKPOINT_B_SELF_DECLARED_PASS=NO
REQUESTED_VERDICT=PASS
CHECKPOINT_C_STARTED=NO
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
DEPLOYMENT=NO
MERGE=NO
FORCE_PUSH=NO
```

Independent review decides the verdict. This implementation agent does not declare `CHECKPOINT_B=PASS`.
