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
6. `mutationAttemptAtMs` was sampled once and reused, so a snapshot taken after attempt 1 but before attempt 2 could verify attempt 2.
7. `classifyTransportError()` defaulted unmatched exceptions to `REJECTED`, so an unclassified parser/SDK throw was treated as a proven non-acceptance.

## 2. Changed files

| File | Why |
|---|---|
| `src/experimentReduction.ts` | Physical-attempt identity; per-attempt `ReductionAttemptContext`; `verificationBarrierAtMs` after each submit; observation consumption; unclassified exceptions default to UNKNOWN |
| `src/venues/extended.ts` | Forward requested ID into vendor `closePosition`; ACK only after verified `submittedExternalId` (present in local starting commit) |
| `vendor/extended/exchange/extended.js` | Already present in local starting commit `0ef2bfa`; not modified by the remaining C2 classification/barrier patch |
| `test/experiment-v02-reduction.test.ts` | C2-1..C2-11 required matrix; prior CB2-1..CB2-9 and B1–B22 / BC1–BC13 remain |
| `test/helpers/reduction.ts` | Record request identity even when submit throws; snapshot verification timestamps; offline vendor seam with no live network |
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

Each physical attempt binds a `ReductionAttemptContext`:

```text
attempt
clientOrderId
side
qty
requestStartedAtMs
verificationBarrierAtMs
```

Required submit order:

```text
1. assert current lease
2. allocate attempt + 1 and a new deterministic client order ID
3. record requestStartedAtMs
4. call submitFlatten()
5. record verificationBarrierAtMs immediately after return or throw
6. request a new authoritative snapshot
7. require snapshot.observedAt >= that attempt's verificationBarrierAtMs
```

A snapshot may verify an attempt only when:

```text
snapshot.observedAt >= current attempt verificationBarrierAtMs
snapshot.leaseGeneration == current lease generation
snapshot is fresh
snapshot observationId and sourceGeneration are non-empty
snapshot evidence was not already consumed by an earlier physical attempt
```

A snapshot taken after attempt 1, or at attempt 2 start but before attempt 2 returns, cannot verify attempt 2. If attempt 2 receives attempt 1's `observationId` or the same authoritative `sourceGeneration`, verification fails with `REDUCTION_OBSERVATION_REPLAY` and cannot produce `HALTED_FLAT`.

## 6. Outcome classification and UNKNOWN behavior

```text
NOT_SENT   only when local fencing/preflight proves transport was not called
REJECTED   only when a typed/structured venue response proves unambiguous non-acceptance
UNKNOWN    default for timeout, connection loss, parser/SDK exceptions, and unclassified throws
```

`classifyTransportError()` no longer infers `REJECTED` from an arbitrary exception message. An unclassified throw such as `order rejected by exchange` is `UNKNOWN`.

Any physical attempt that returns `UNKNOWN`:

1. does not create another mutation;
2. performs authoritative reconciliation of that same attempt identity only;
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
| C2-1 | Attempt 1 ACK, same side/qty; attempt 2 uses a new client order ID |
| C2-2 | Snapshot after attempt 1 / before attempt 2 barrier cannot verify attempt 2 |
| C2-3 | Only a new authoritative post-attempt-2 snapshot may verify attempt 2 |
| C2-4 | Latest quantity change recomputes side/qty and still uses attempt=2 |
| C2-5 | UNKNOWN creates exactly one transport mutation; no blind second submit |
| C2-6 | Unclassified thrown exception returns UNKNOWN, not REJECTED |
| C2-7 | Typed explicit venue rejection returns REJECTED |
| C2-8 | Proven local lease/preflight failure returns NOT_SENT and performs no flatten transport |
| C2-9 | Earlier observationId/sourceGeneration cannot prove a later attempt |
| C2-10 | Lease loss between submit response and verification cannot produce HALTED_FLAT |
| C2-11 | Prior B1–B22, BC1–BC13 case IDs remain present; Gate 0 and Checkpoint A stay in `npm run check` |

Existing B1–B22, BC1–BC13, Gate 0, and Checkpoint A tests remain in the suite and must stay green.

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
