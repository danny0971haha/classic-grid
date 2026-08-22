# Classic Grid v0.2 — Checkpoint B Corrective 1

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE / CHECKPOINT B REJECTED  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/classic-grid`  
**Implementation branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`  
**Rejected candidate:** `d2a48abe3f49f516a5678dd9119665ac23027671`  
**Rejected candidate tree:** `2b9aa30162c7c54d54bffec3adb7d653e9e0faab`  
**CI evidence:** run `32586238616` succeeded with `162/162` tests, but green CI does not prove the missing authority/fencing invariants.

## 1. Independent decision

```text
CHECKPOINT_B=REJECT
CHECKPOINT_C_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

The candidate adds a substantial hard-halt/full-flatten lifecycle and a broad dry-run test matrix. It is not accepted because the current bytes can mutate durable halt state before proving the active runtime lease, can prefer stale caller identity over newer durable authority, and can locally promote a generic snapshot into apparent authoritative post-write evidence.

Implement only this corrective, then stop for independent review.

## 2. Blocking findings

### CG-B-R1 — Durable mutation occurs before mandatory active-lease proof

`runActualNotionalHardHalt()` builds state and calls `persistPhase("HALTING", ...)` before its first `tryAssertLease(p.assertLeaseCurrent)` check. The only write-time fence is an optional caller-supplied `persistOptions.assertLeaseCurrent`.

The current B22 test proves that transport calls are suppressed, but it accepts any durable non-`RUNNING` result. A stale owner can therefore change durable bytes and still satisfy the test.

The normal loop also persists the evaluated risk state before dispatching into the dedicated actual-notional reducer, without an immediately preceding lease assertion at that mutation boundary.

Required correction:

- active lease authority must be a mandatory part of the reduction operation, not optional wiring;
- assert the current lease before every authoritative durable state mutation, including the first `HALTING` write, all final-state writes, and any pre-dispatch risk-state write in the loop;
- pass the same mandatory authority into `persistRiskState()` so the assertion is repeated at the actual write/rename boundary;
- after lease loss, a stale owner may return an in-memory fail-closed result and request reconciliation, but it must not change newer durable bytes;
- tests must compare exact durable generation/hash/bytes before and after a stale-owner attempt.

### CG-B-R2 — Caller memory can override newer durable halt authority

The current reducer spreads caller `state` over the freshly loaded durable state, prefers caller `haltId`, and prefers the old durable `leaseGeneration` over the current active generation.

This permits a stale caller object to replace or regress a newer durable incident identity, reasons, status, scope, or lease binding.

Required correction:

- inspect the authoritative durable primary/backup pair and treat it as write authority;
- caller state is evidence only and must never overwrite a newer durable generation or halt incident;
- bind the reduction transition to the exact durable predecessor generation/hash;
- reject/reconcile if the predecessor changes between inspection and commit;
- preserve a current durable halt incident when one exists;
- when the active owner advances to lease generation `gN`, every new Checkpoint B durable transition must be committed under `gN`, not under the predecessor runtime's stale generation;
- a stale caller halt ID must not erase a newer halt ID.

### CG-B-R3 — Generic snapshots are locally promoted into authoritative evidence

`createVenueReductionTransport().fetchFreshSnapshot()` currently takes a generic `VenueSnapshot` and locally manufactures:

```text
observationId=random UUID
sourceGeneration=derived local string
freshness="fresh"
leaseGeneration=request input
```

Those fields do not prove that the venue observation was authoritative, post-write, generation-consistent, or freshly produced by the strict observation barrier.

The verifier also accepts a missing snapshot lease generation because it rejects only when both expected and observed generations are present and unequal.

Required correction:

- the adapter/strict observation layer must produce the authoritative observation identity, source generation/cursor, observed-at time, freshness disposition, and lease generation;
- the reduction wrapper must not synthesize or upgrade those fields;
- a generic/cached `VenueSnapshot` is insufficient to produce `HALTED_FLAT`;
- when an expected lease generation is supplied, the snapshot must contain the exact matching generation; missing is a failure;
- observation provenance must be tied to the actual post-mutation read and must be replay/refresh distinguishable from pre-write data.

### CG-B-R4 — Lease is not re-proved around post-write verification

After flatten submission, the reducer fetches and accepts snapshots without asserting lease authority immediately before the read and again after the response before accepting/finalizing the result.

Required correction:

- assert the current lease immediately before requesting each authoritative snapshot;
- assert it again after the snapshot returns and before accepting verification or persisting a final state;
- lease loss after flatten submission means reconciliation only; it must never produce `HALTED_FLAT` from that stale owner;
- final persistence must repeat the active-lease assertion at the write boundary.

### CG-B-R5 — Bounded retry reuses stale initial quantity

After a fresh snapshot remains non-flat, the retry path resubmits the original request derived from the initial position. It does not recompute direction and quantity from the latest authoritative position.

Required correction:

- an `UNKNOWN` submit must not be blindly retried; reconcile the same mutation identity first;
- after an unambiguous completed attempt plus a fresh non-flat observation, derive the next exposure-reducing side and bounded quantity from that latest observation;
- a genuinely new reduction attempt must use deterministic attempt identity derived from incident plus attempt sequence, unless the venue primitive is a proven idempotent full-close operation whose contract safely ignores quantity;
- never reuse one client order ID with materially different request bytes;
- every retry must remain reduce-only and must not exceed current absolute position.

### CG-B-R6 — Cancellation classification is not conservative across zero

The current direction-only helper treats, for example, sell orders during a long position as non-risk-increasing. A sufficiently large non-reduce-only sell order can cross flat and create short exposure.

Required correction:

For a hard-flatten incident, either:

1. cancel every experiment-owned non-reduce-only order; or
2. prove from side, remaining quantity, current position, and venue reduce-only semantics that an order cannot increase absolute exposure or cross through zero.

Do not classify solely from side and current position sign. Final flat verification must apply the same conservative ownership/exposure rule.

### CG-B-R7 — Extended reduction boundary does not independently enforce the request contract

The adapter boundary receives incident, lease, side, and quantity fields, but the actual Extended implementation must prove that it honors/reconciles those fields rather than treating them as decorative metadata.

Required correction:

- reject a stale lease generation at the adapter boundary;
- prove long/short exposure-reducing side;
- prove quantity cannot exceed current absolute position after venue normalization;
- retain deterministic incident/attempt identity where the venue supports client IDs;
- expose `ACK`, `REJECTED`, `UNKNOWN`, and `NOT_SENT` without guessing;
- if the vendor `closePosition` primitive is used as a true full-close operation, document and test that contract explicitly.

## 3. Mandatory corrective tests

Add stable case IDs covering at least:

```text
BC1 stale lease before HALTING -> durable primary/backup bytes and generation remain unchanged
BC2 stale caller haltId cannot overwrite a newer durable halt incident
BC3 accepted HALTING/final writes are bound to the current active lease generation
BC4 predecessor generation/hash changes before commit -> no stale mutation
BC5 lease lost after flatten ACK but before snapshot -> never HALTED_FLAT
BC6 lease lost after snapshot response but before final persist -> no stale final mutation
BC7 missing snapshot lease generation/provenance -> verification rejected
BC8 generic or cached snapshot cannot be locally promoted to authoritative fresh evidence
BC9 fresh non-flat retry recalculates side/quantity from latest position and uses safe deterministic attempt identity
BC10 UNKNOWN flatten does not create a blind second mutation
BC11 opposite-side oversized owned non-reduce-only order is cancelled or blocks HALTED_FLAT
BC12 loop-level risk-state persistence is fenced at its actual write boundary
BC13 Extended reduction rejects stale lease/request mismatch and cannot increase absolute exposure
BC14 all prior B1-B22 and Gate 0 tests remain green without weakening assertions
```

For BC1/BC2/BC4/BC6, inspect fresh-process durable bytes and report primary/backup hashes or envelope generation before and after the attempted stale mutation.

## 4. Scope

Allowed production paths:

```text
src/experimentReduction.ts
src/experimentRisk.ts
src/loop.ts
src/types.ts
src/venues/types.ts
src/venues/extended.ts
src/venues/extendedObservation.ts     # authoritative metadata only if required
src/venues/extendedStrictApi.ts       # authoritative metadata only if required
```

Allowed tests/support:

```text
test/experiment-risk.test.ts
test/experiment-v02-reduction.test.ts
test/extended-observation.test.ts
test/fixtures/**
test/helpers/**
```

`package.json` may change only to register focused tests.

Do not modify other venue adapters. If another production path is necessary, stop with:

```text
BLOCKED_SCOPE_CHANGE_REQUIRED
```

and identify the exact path and invariant.

## 5. Prohibited actions

```text
CHECKPOINT_C_STARTED=NO
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
PRODUCTION_API_KEY_USE=NO
DEPLOYMENT=NO
MERGE=NO
FORCE_PUSH=NO
V02_FROZEN_CONFIGURATION_CHANGE=NO
RISK_THRESHOLD_REDUCTION=NO
TEST_WEAKENING=NO
```

All transport behavior must be exercised through dry-run doubles/fixtures only.

## 6. Validation

Use the repository's Node 22 baseline and run at minimum:

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

Run a changed-file secret scan without printing values. Provide exact branch-head GitHub Actions run ID and conclusion.

## 7. Handoff

Push bounded commits only to:

```text
experiment/classic-v0.2-100u-safety
```

Then stop and return:

```text
CHECKPOINT=CHECKPOINT_B_CORRECTIVE_1
STATUS=<READY_FOR_REVIEW|BLOCKED>
REPOSITORY=danny0971haha/classic-grid
BRANCH=experiment/classic-v0.2-100u-safety
BASE_SHA=<actual pulled corrective contract head>
HEAD_SHA=<candidate>
TREE_SHA=<candidate tree>

COMMITS:
<exact list>

CHANGED_FILES:
<exact list>

TESTS:
<commands, exit codes, totals>

FENCING_EVIDENCE:
<pre/post durable hashes, active lease binding, predecessor binding>

SNAPSHOT_AUTHORITY_EVIDENCE:
<adapter-produced provenance, freshness, exact lease generation, post-write proof>

RETRY_EVIDENCE:
<UNKNOWN handling and latest-snapshot quantity/identity behavior>

ARTIFACTS:
<patch path/URL, bytes, LF count, SHA-256>

PROHIBITED_ACTION_ATTESTATION:
LIVE_EXCHANGE_WRITE=NO
DEPLOYMENT=NO
MERGE=NO
CHECKPOINT_C_STARTED=NO

KNOWN_LIMITATIONS:
<explicit list>

REQUESTED_VERDICT=<PASS|REJECT|BLOCKED>
```

The implementation agent must not self-declare Checkpoint B PASS. Stop after handoff.