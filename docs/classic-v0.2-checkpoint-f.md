# Classic Grid v0.2 — Checkpoint F

**Status:** CHECKPOINT_F_REVIEW_CANDIDATE / INDEPENDENT REVIEW REQUIRED  
**Date:** 2026-08-25  
**Repository:** `danny0971haha/classic-grid`  
**Branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`  
**Current task:** `CHECKPOINT_F`

This document does **not** declare Checkpoint F PASS. CI success is not a gate verdict. The implementation agent must not self-declare PASS.

```text
CHECKPOINT=F
REQUESTED_GATE=CHECKPOINT_F_REVIEW
CHECKPOINT_E_CORRECTIVE_2=ACCEPT
CHECKPOINT_F=REVIEW_CANDIDATE
CHECKPOINT_F_SELF_DECLARED_PASS=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_CREDENTIAL_USED=NO
MERGE_PERFORMED=NO
DEPLOY_PERFORMED=NO
```

The independent ACCEPT of Checkpoint E Corrective 2 covers evidence-schema correction only. It does not authorize LIVE_CANARY, real funds, merge, or deploy.

## Binding

```text
AUTHORITATIVE_START_HEAD=3960e3634b1fc68ab90bd8f73cd6effd925932e2
AUTHORITATIVE_START_TREE=7e46f9db25240f2ff57c2403481502bc4b75ff18
SOURCE_BRANCH=experiment/classic-v0.2-100u-safety
```

Tested commit SHA and tree SHA are the Checkpoint F implementation commit after it lands on the branch. Bind them from `git rev-parse HEAD` / `git rev-parse HEAD^{tree}` at evidence generation time, and from GitHub Actions on push/PR. Do not hand-write PASS.

Local toolchain during implementation: Node v26.5.0 / npm 11.17.0. GitHub Actions must prove Node v22.23.2 / npm 10.9.8.

## Goal

Extended venue authoritative `ExecutionRecord` values are the only fill proof for replacement obligations and realized-pair metrics.

1. Open-order disappearance does not infer a fill.
2. Position delta does not infer a specific order fill.
3. Telemetry publication is not strategy consumption.
4. Partial fill, duplicate replay, crash/restart, and UNKNOWN submit keep exactly-once strategy semantics.
5. Uncertain identity, quantity, scope, epoch, or durability fail closed.
6. Unowned orders are never cancelled.
7. No live trading.

## Durable strategy ledger

New module: `src/strategyExecutionLedger.ts`.

Path:

```text
<data/experiments or baseDir>/<safeExperimentId>/strategy-ledgers/<sha256Canonical(identity)[0:32]>.json
```

Identity hashed into the filename:

```text
schemaVersion=classic-grid.strategy-ledger.v1
experimentId
scopeKey
venue
normalized market
anchorEpoch
```

Envelope: checksummed V2 (`kind=classic-grid.strategy-ledger.v1`) with atomic write, file fsync, rename, directory fsync, and readback. Missing file initializes empty. Corrupt, truncated, unsupported version, wrong scope/market/epoch/experiment fail closed. No implicit migration.

Payload `schemaVersion` is exactly `classic-grid.strategy-ledger.v1`. Validation is exact-shape: unexpected keys are rejected.

### Tick order

1. `drainExecutionJournal()`
2. Inspect authority and faults
3. Idempotent durable ingest of authoritative records (`dedupeKey`)
4. Strategy received only after proven durable write
5. Planner reads pending obligations from the ledger
6. Telemetry publication
7. `acknowledgeExecutionJournal()` means telemetry published only

Ingest runs before telemetry ACK. Telemetry failure keeps strategy obligations. Repeat drain is absorbed by `dedupeKey`. Ledger persist failure: no telemetry ACK of new records, no risk-increasing replacement, durable `RECONCILIATION_REQUIRED` / cancel-only.

## Obligation state machine

```text
OBSERVED
DURABLY_INGESTED
READY
SUBMITTING
SUBMIT_UNKNOWN
CONFIRMED_OPEN
TERMINAL_FILLED_OR_REPLACED
TERMINAL_EDGE_NOOP
RECONCILIATION_REQUIRED
```

- Buy fill at level `i` → sell at `i+1` with exact incremental quantity.
- Sell fill at level `i` → buy at `i-1` with exact incremental quantity.
- Outside the grid edge → `TERMINAL_EDGE_NOOP`, no order.
- Replacement `clientOrderId`: `{prefix}{epoch}-{side}-{level}-r-{16-hex}` from `sha256Canonical(obligationId)`.
- Seed one-order-per-logical-slot is unchanged. Replacements use obligation-specific slot keys so exact residuals are not rounded to `sizeBase`.
- CONFIRMED requires post-write observation of the deterministic identity.
- REJECTED keeps the same clientOrderId and retries with bound 8.
- UNKNOWN/ambiguous does not mint a second clientOrderId; restart reconciles the original identity.

## Ownership and fail-closed table

| Condition | Strategy effect |
|---|---|
| `source!==exchange` or `authoritative!==true` | rejected, recon |
| wrong venue / wrong market | recon, no obligation |
| empty `dedupeKey` | recon |
| missing `clientOrderId` and no unique registry map | `UNKNOWN_ORDER_IDENTITY` |
| malformed ownership prefix | `MALFORMED_OWNERSHIP_PREFIX` |
| stale anchor epoch | `STALE_ANCHOR_EPOCH` |
| alias maps to two client IDs | `ALIAS_CONFLICT` |
| sequence gap / cursor conflict / journal capacity | recon, cancel-only |
| cumulative regression / exceeds original / qty conflict | recon, no second obligation |
| ledger corrupt/truncated/wrong-scope | persist unproven, no ACK, cancel-only |
| unowned occupancy of replacement target | no cancel, risk increase blocked |
| malformed owned occupancy | existing cancel-only rules, no replacement place that tick |

Registry bindings are durable `clientOrderId ↔ exchangeOrderId` pairs. Same client order with two exchange IDs is a conflict. Two partials of one order must share the exchange order id.

Incremental quantity: if `quantity` matches the cumulative delta, use `quantity`. Reporting the running cumulative as a second incremental fill is `QUANTITY_CONFLICT`.

## Planner and metrics

`planFromFillsAndSeed` accepts `replacementObligations`, `replacementSizes`, and optional authoritative filled/rungs. Without those inputs, `filled=[]` and `completedRungs=0` remain, so Checkpoint D tests are unchanged.

`completedRungs` / `gridProfit` on the strategy path are authoritative pair metrics (gross, fees not included). Loop position-delta still drives Telegram estimates only (`estimatedCompletedRungs` / `estimatedGridProfit`) and is not written as realized.

## Crash matrix

All crash cases use a real child process and SIGKILL, not a mock throw:

| ID | Window | Expected |
|---|---|---|
| F-10 | before ledger persist | venue journal still drainable; no strategy obligation |
| F-11 | after ingest, before submit persist | same READY obligation and CID; place once |
| F-12 | after SUBMITTING persist, before apply response | no second place |
| F-13 | after observation, before terminal persist | recover via CID; no second place |
| F-14 | after ingest, before telemetry ACK | journal replay absorbed by `dedupeKey` |

## Commands and results

Local implementation run (Node v26.5.0 / npm 11.17.0). CI pin is Node v22.23.2 / npm 10.9.8.

| Command | Result |
|---|---|
| `npm run test:checkpoint-f` | 35 tests, 35 pass, 0 fail, 0 skipped, 0 todo, exit 0 |
| `npm test` | `grid.test.ts OK` then node:test **393 pass / 0 fail / 0 skipped / 0 todo**, exit 0 |
| `npm run typecheck` / `npm run build` | `tsc --noEmit`, exit 0 |
| `npm run check` | typecheck + full suite, same 393/0/0/0 |
| `git diff --check <start>...<HEAD>` | recorded against `3960e3634b1fc68ab90bd8f73cd6effd925932e2` after the implementation commit |

Baseline before Checkpoint F was 358 node:test tests. 358 + 35 = 393. No prior test was deleted or skipped. Crash cases F-10..F-13 used a real child process and SIGKILL.

Tested commit SHA and tree SHA are the Checkpoint F implementation commit (`git rev-parse HEAD` / `git rev-parse HEAD^{tree}` at review time). Do not treat local Node v26 as a substitute for the pinned CI toolchain.

## Known limitations

- Checkpoint F is a review candidate only.
- Local verification used Node v26.5.0 / npm 11.17.0. CI must prove the pinned toolchain.
- Generated evidence JSON is not checked in.
- Replacement stacking across ticks at a level already occupied by a confirmed replacement of a different residual waits; same-tick multiple partials place exact residuals with obligation-specific identities.
- Authoritative gross profit ignores fees (`feeBasis=gross`).
- Dry-run Extended still has no account websocket; loop consumption is exercised through the ledger APIs and fixtures.
- No live exchange write. No production credential. No merge. No deploy. No canary.

## Independent review

The independent reviewer owns `ACCEPT`, `REJECT`, or `BLOCKED`.

```text
CHECKPOINT_F_SELF_DECLARED_PASS=NO
CHECKPOINT_E_CORRECTIVE_2=ACCEPT
CHECKPOINT_F=REVIEW_CANDIDATE
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_CREDENTIAL_USED=NO
MERGE=NO
DEPLOYMENT=NO
```
