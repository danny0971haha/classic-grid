# Classic Grid v0.2 — Checkpoint B Corrective 5

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE CANDIDATE / INDEPENDENT REVIEW REQUIRED  
**Date:** 2026-08-24  
**Repository:** `danny0971haha/classic-grid`  
**Implementation branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`  
**Current gate:** Checkpoint B remains REJECT. This change is Corrective 5 only.

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

## 1. Root cause

Corrective 4 made `venueMutationEntered` caller-owned inside `normalizeReductionResult()`, but the production composition path still normalized twice and treated `submitFlatten()` as proof of venue mutation.

```text
runActualNotionalHardHalt
  -> submitPhysical
    -> createVenueReductionTransport.submitFlatten
      -> ExtendedExecutor.reduceExposure
```

`ExtendedExecutor.reduceExposure` can return a project-owned `NOT_SENT` before `closePosition` because of an inner lease/preflight failure.

`createVenueReductionTransport` then called `normalizeReductionResult` once. That produced a plain `ReductionResult` that no longer carried the project-owned `LOCAL_TRANSPORT_NOT_SENT` brand.

`submitPhysical` then normalized again with `venueMutationEntered=true` merely because the flatten wrapper had been invoked. A genuine pre-mutation:

```text
outcome=NOT_SENT
physicalAttempt=0
```

was therefore degraded to:

```text
outcome=UNKNOWN
physicalAttempt=1
```

Isolated unit tests of `normalizeReductionResult` and `ExtendedExecutor.reduceExposure` could not see this composition bug.

## 2. Exact changed files

| File | Why |
|---|---|
| `src/experimentReduction.ts` | Project-owned `NOT_SENT` brand; preserve provenance across composition; `submitPhysical` no longer assumes mutation from the flatten wrapper |
| `src/venues/extended.ts` | After `closePosition` is entered, vendor `NOT_SENT` claims and thrown brand-like fields normalize to `UNKNOWN` |
| `test/experiment-v02-reduction.test.ts` | C5-1..C5-8 composed production-path cases |
| `docs/classic-v0.2-checkpoint-b-corrective-5.md` | This evidence note |

`src/loop.ts` already wires:

```text
runActualNotionalHardHalt(
  createVenueReductionTransport(
    ExtendedExecutor.reduceExposure(...)
  )
)
```

No loop change was required. `test/helpers/reduction.ts` already delegates to `createLocalTransportNotSent()` and was not modified.

No Checkpoint C execution journal, fill provenance, planner dedup, other venue adapters, frozen v0.2 values, deployment, live allowlist, vendor wholesale import, or grid-geometry change is included.

## 3. Final semantics

### A. Venue-mutation ownership

The layer that actually invokes the venue mutation callable owns provenance:

- whether the actual venue callable was entered
- physical mutation count
- preflight/lease stage
- requested client identity
- submitted external identity
- structured venue rejection evidence

Calling `submitFlatten()` is not proof that `venueMutationEntered=true`.

`createLocalTransportNotSent()` now stamps a non-structural project brand. `isLocalTransportNotSent()` requires that brand. A merely structural `{ kind: "LOCAL_TRANSPORT_NOT_SENT", ... }` object is not trusted.

Normalized genuine `NOT_SENT` results keep the brand so a later composition normalize cannot strip provenance.

### B. Genuine local NOT_SENT

These cases remain:

```text
outcome=NOT_SENT
physicalAttempt=0
venueMutationEntered=false
vendor/closePosition payload count=0
```

including:

1. outer lease check passes, but the transport-inner lease check adjacent to venue mutation fails
2. Extended adapter finds stale lease/request mismatch before `closePosition`
3. project-owned preflight rejects before the venue callable

### C. Post-mutation uncertainty

Once `closePosition` or another venue mutation callable is actually entered:

- raw `NOT_SENT`
- spoofed `LOCAL_TRANSPORT_NOT_SENT`
- thrown branded `NOT_SENT`
- malformed result
- parser/SDK/network/timeout exception

all become, unless stronger structured ACK/REJECTED proof exists:

```text
outcome=UNKNOWN
physicalAttempt=1
venueMutationEntered=true
```

A vendor/SDK object cannot declare that it was not sent after the callable was entered.

### D. ACK identity

ACK still requires:

```text
requestedClientOrderId == request.clientOrderId
submittedExternalId == request.clientOrderId
```

Identity missing/mismatch degrades to `UNKNOWN` / `REDUCTION_IDENTITY_MISMATCH`. `exchangeOrderId` is not mixed with client identity.

### E. Retry and reconciliation

After `UNKNOWN`:

- no blind-submit unrelated retry
- current physical attempt identity is retained
- only one fresh post-barrier authoritative snapshot is used for reconciliation
- `HALTED_FLAT` is forbidden without proven flat
- the process never automatically returns to `RUNNING`

### F. Durable audit

At least these codes remain stable in returned errors or durable `haltReasons`, and restart still fail-closes:

```text
FLATTEN_ATTEMPT_UNKNOWN
REDUCTION_PROVENANCE_UNTRUSTED
REDUCTION_IDENTITY_MISMATCH
REDUCTION_RESULT_MALFORMED
```

## 4. Test matrix

Tests cover the actual composition:

```text
runActualNotionalHardHalt(
  createVenueReductionTransport(
    ExtendedExecutor.reduceExposure(...)
  )
)
```

| ID | Assertion |
|---|---|
| C5-1 | Outer lease passes; transport-inner lease adjacent to venue mutation fails → `NOT_SENT`, `physicalAttempt=0`, `closePosition`/vendor payload count `0` |
| C5-2 | Extended preflight stale lease/request mismatch → `NOT_SENT`, venue mutation count `0` |
| C5-3 | After actual `closePosition`, raw `{ outcome: "NOT_SENT", transportCalled: false }` → `UNKNOWN`, `physicalAttempt=1`, durable `FLATTEN_ATTEMPT_UNKNOWN` or `REDUCTION_PROVENANCE_UNTRUSTED` |
| C5-4 | After actual venue callable, thrown error with `LOCAL_TRANSPORT_NOT_SENT` field → `UNKNOWN`, never `NOT_SENT` |
| C5-5 | Composed ACK: `requestedClientOrderId` and `submittedExternalId` match; `exchangeOrderId` is not mixed with client identity |
| C5-6 | Composed ACK identity missing/mismatch → `UNKNOWN` |
| C5-7 | After `UNKNOWN`, no blind retry; only one fresh authoritative reconciliation; no `HALTED_FLAT` without fresh post-barrier flat proof |
| C5-8 | Gate 0, Checkpoint A, B1-B22, BC*, CB2*, C2*, C3*, C4* tests and assertions remain present and pass |

Prior C4-1..C4-11 remain. Green is not obtained by deleting tests, renaming tests, weakening assertions, adding sleep, or adding fixture-specific special cases.

## 5. Local command results

```text
git fetch --all --prune
git checkout experiment/classic-v0.2-100u-safety
git pull --ff-only
START / BASE after authorized pre-C5 bind:
BASE_SHA=517d15d7c1d9a27c02b583c7d6b7eaea2f4e6967
BASE_TREE=fef0480b661a4743ac90329cb644d3dc3b364e89
node = v26.5.0
npm = 11.17.0

npm ci                         exit 0
npm run check                  exit 0   (233/233 pass, 0 fail)
node --import tsx --test test/experiment-v02-reduction.test.ts
                               exit 0   (93/93 pass, 0 fail)
git diff --check               exit 0
```

Changed-file secret scan (values not printed):

```text
RULE=GENERIC_API_KEY_ASSIGN PATH=src/venues/extended.ts
RULE=PRIVATE_KEY_ASSIGN PATH=src/venues/extended.ts
```

Those hits are pre-existing `process.env` name reads in the Extended adapter. No live credential, token, or environment secret was added. No dummy vendor private key was introduced by this change.

Exact changed files and SHAs are bound in section 6 after the implementation commits.


## 6. Candidate binding

Implementation commits:

```text
FIX_SHA=327ce4cc45a26f7d6e463ea22bbc1ceb87567b00
FIX_TREE=6a2ce2687effec9f09fe1b38f72d834d164a5b19
TEST_SHA=14ed72d3391e5a3ae7a9537e64ff160030cdebf2
TEST_TREE=b5fe5ed9ddb24898b979ea61af8fd362ea6a320c
```

SHA-bind commit and its exact branch-push CI:

```text
BASE_SHA=517d15d7c1d9a27c02b583c7d6b7eaea2f4e6967
BASE_TREE=fef0480b661a4743ac90329cb644d3dc3b364e89
HEAD_SHA=76529c2d885a2272d27cfe1136eed97dac7cd60b
TREE_SHA=904fc0752a6bf393116b4c0d898bf69ceae99bb2
EXACT_CHANGED_FILES=
  docs/classic-v0.2-checkpoint-b-corrective-5.md
  src/experimentReduction.ts
  src/venues/extended.ts
  test/experiment-v02-reduction.test.ts
DIFF_STAT=4 files changed, 803 insertions(+), 37 deletions(-)
TEST_COMMANDS_AND_TOTALS=
  npm ci                                              exit 0
  npm run check                                       exit 0  233/233 pass
  node --import tsx --test test/experiment-v02-reduction.test.ts
                                                      exit 0  93/93 pass
  git diff --check                                    exit 0
CI_RUN_ID=32652937872
CI_EVENT=push
CI_URL=https://github.com/danny0971haha/classic-grid/actions/runs/32652937872
CI_HEAD_SHA=76529c2d885a2272d27cfe1136eed97dac7cd60b
CI_CONCLUSION=success
CI_JOB=compiler-and-tests
CI_JOB_CONCLUSION=success
```

A later annotation commit may move `HEAD`. Independent review must re-bind to the final pushed SHA and the Actions run that checked out that exact SHA. The handoff block is authoritative for the final pair.


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
