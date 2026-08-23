# Classic Grid v0.2 — Checkpoint B Corrective 2

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE CANDIDATE / INDEPENDENT REVIEW REQUIRED  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/classic-grid`  
**Implementation branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`  
**Corrective base SHA:** `25a029954f6eb96b7c98fabce6c1961f40c7d1e1`  
**Current gate:** Checkpoint B Corrective 1 was rejected; this change is Corrective 2 only.

This document does **not** declare Checkpoint B PASS. CI success is not a gate verdict.

```text
CHECKPOINT_C_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

## 1. Problem

Corrective 1 bound halt identity, lease fencing, and snapshot authority, but reduction mutation identity still stopped at the project-owned result object.

Observed current-byte path before this corrective:

```text
runActualNotionalHardHalt()
  -> ReductionTransport.submitFlatten()
  -> ExtendedExecutor.reduceExposure()
  -> ExtendedExchange.closePosition(marketId, qty)
  -> _submitOrder(...)
```

Root cause:

1. `ExtendedExecutor.reduceExposure()` computed a deterministic `clientOrderId`.
2. `closePosition(marketId, qty)` did not receive or forward that ID.
3. Vendor `_submitOrder()` hashed a random nonce into `payload.id` when `externalId` was missing.
4. The orchestrator could therefore report a client order ID that was never the actual exchange mutation identity.
5. Retry incremented `attempt` only when side/qty bytes changed, so an unchanged position could be physically submitted again under the same attempt identity.
6. `mutationAttemptAtMs` was sampled after the first submit and reused, so a later attempt could be verified by earlier observation evidence.

## 2. Changed files

| File | Why |
|---|---|
| `src/experimentReduction.ts` | Single source of truth for `clientOrderId`; physical-attempt increment; attempt-scoped verification window; observation consumption; UNKNOWN remains reconcile-only |
| `src/venues/extended.ts` | Forward requested ID into vendor `closePosition`; ACK only after verified `submittedExternalId` |
| `vendor/extended/exchange/extended.js` | Reduce-only IOC path accepts `externalId` and sets `payload.id`; return fields keep external vs exchange IDs separate |
| `test/experiment-v02-reduction.test.ts` | CB2-1..CB2-9 regression matrix; B13/BC13 aligned to physical-attempt identity |
| `test/helpers/reduction.ts` | Record request identity and snapshot verification timestamps; offline vendor seam with no live network |
| `docs/classic-v0.2-checkpoint-b-corrective-2.md` | This evidence note |

No Checkpoint C execution journal, fill provenance, planner dedup, deployment, or live enablement work is included.

## 3. Identity propagation contract

One value is minted once per physical submission, before the venue call:

```text
requestedClientOrderId = reductionClientOrderId(incidentId, physicalAttempt)
```

That value is the only source of truth and is carried as `ReductionRequest.clientOrderId` through:

```text
runActualNotionalHardHalt
  -> ReductionTransport.submitFlatten
  -> ExtendedExecutor.reduceExposure
  -> ExtendedExchange.closePosition(marketId, sizeBase, externalId)
  -> _submitOrder({ externalId })
  -> payload.id
```

`ExtendedExecutor` does not invent a second ID. It rejects a missing or non-matching request ID with `NOT_SENT` before any write. ACK requires all of:

```text
submittedExternalId exists
submittedExternalId === requestedClientOrderId
HTTP/API submission completed without throw
```

Returned fields stay separate:

```text
requestedClientOrderId
submittedExternalId
exchangeOrderId / exchangeId   # venue internal id only, never the external id
```

If the request may already have been sent but identity is missing or mismatched:

```text
outcome=UNKNOWN
reasonCode=REDUCTION_IDENTITY_MISMATCH
```

The generic `closePosition(market)` fallback in `createVenueReductionTransport` cannot prove payload identity and therefore returns `UNKNOWN` / `REDUCTION_IDENTITY_UNPROVEN` instead of ACK.

## 4. Physical attempt semantics

`physicalAttempt` counts actual venue mutation transport calls, not whether side/qty bytes changed.

```text
first physical submit  -> attempt 1 -> cg-reduce:<incident>:flatten
second physical submit -> attempt 2 -> cg-reduce:<incident>:flatten:2
third physical submit  -> attempt 3 -> cg-reduce:<incident>:flatten:3
```

The previous rule:

```ts
attempt: bytesChanged ? request.attempt + 1 : request.attempt
```

is removed. An unchanged authoritative position still advances identity on the next physical submit. This change does not assume Extended server-side strict idempotency for a reused external ID.

## 5. Observation consumption semantics

Each physical attempt binds its own:

```text
physicalAttempt
requestedClientOrderId
mutationAttemptAtMs
observationId
sourceGeneration
```

`mutationAttemptAtMs` is sampled immediately before that attempt's mutation call. The following verifier call uses that timestamp, not the first attempt's timestamp.

A snapshot may verify an attempt only when:

```text
snapshot.observedAt >= current attempt mutationAttemptAtMs
snapshot.leaseGeneration == current lease generation
snapshot is fresh
snapshot observationId and sourceGeneration are non-empty
snapshot evidence was not already consumed by an earlier physical attempt
```

If attempt 2 receives attempt 1's `observationId` or the same authoritative `sourceGeneration`, verification fails with `REDUCTION_OBSERVATION_REPLAY` and cannot produce `HALTED_FLAT`.

## 6. UNKNOWN behavior

Any physical attempt that returns `UNKNOWN`:

1. does not create another mutation;
2. performs authoritative reconciliation only;
3. may enter `HALTED_FLAT` only when a fresh authoritative snapshot independently proves flat;
4. otherwise remains `HALTED_UNFLAT` or `HALT_FAILED`;
5. never treats a still-open position as permission to submit a second order.

## 7. Preserved safety properties

This corrective does not relax:

```text
durable halt identity
risk-state primary/backup authority
predecessor generation/hash fencing
runtime lease generation fencing
stale owner rejection
HALTING before mutation
UNKNOWN fail-closed
fresh strict observation requirements
reduce-only side/quantity bounds
no position sign crossing
no reseed while halted
explicit live double opt-in
```

## 8. Test matrix

| ID | Assertion |
|---|---|
| CB2-1 | requested ID == vendor `externalId` == actual `_submitOrder` `payload.id` |
| CB2-2 | ACK only with matching requested/submitted external IDs; exchange ID remains separate |
| CB2-3 | missing or mismatched submitted ID is `UNKNOWN` / `REDUCTION_IDENTITY_MISMATCH`, never ACK |
| CB2-4 | unchanged position still uses attempt 2 identity on the second physical submit; submit count is 2 |
| CB2-5 | retry side/qty follow the latest authoritative position, stay reduce-only, and advance attempt |
| CB2-6 | reused `observationId` / `sourceGeneration` cannot verify a later attempt or produce `HALTED_FLAT` |
| CB2-7 | each physical submit has a new `mutationAttemptAtMs`; later verifier uses that attempt's timestamp |
| CB2-8 | first-submit UNKNOWN and non-flat snapshot produce exactly one physical submit and no reseed |
| CB2-9 | stale lease still cannot mutate durable primary/backup bytes |

Existing B1–B22, BC1–BC14, and Gate 0 tests remain in the suite and must stay green.

Offline vendor tests stub `_req` only. They do not read live credentials, open a real Extended connection, or perform a live write.

## 9. Verification commands

```bash
node --version
npm --version
npm ci
git diff --check
npm run typecheck
npm test
npm run check
git grep -n "closePosition" -- src vendor test
git grep -n "reductionClientOrderId" -- src vendor test
git grep -n "payload.id\\|externalId" -- src/venues vendor/extended test
```

## 10. Stop line

Implementation stops after this corrective candidate. Checkpoint C is not started. This document does not authorize merge, deployment, live exchange writes, or a self-declared Checkpoint B PASS.
