# Classic Grid v0.2 — Checkpoint C Execution Journal

**Status:** CHECKPOINT_C_REVIEW_CANDIDATE / INDEPENDENT REVIEW REQUIRED  
**Date:** 2026-08-24  
**Repository:** `danny0971haha/classic-grid`  
**Branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`

This document does **not** declare Checkpoint C PASS. CI success is not a gate verdict.

```text
CHECKPOINT_B=PASS
CHECKPOINT_C_AUTHORIZED=YES
CHECKPOINT_C_SELF_DECLARED_PASS=NO
CHECKPOINT_D_STARTED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH_AUTHORIZED=NO
```

## 1. Accepted baseline

```text
BASE_HEAD=197369a00a7c1f7080f2a1ebea76ffae20ac13ba
BASE_TREE=6c08c9e3fb78a86591423ea47a60ce96e1c9f796
CHECKPOINT_B_CORRECTIVE_5=PASS
```

Checkpoint C implements only exchange-observed execution journal and telemetry for the Extended venue.

## 2. Binding rule

An authoritative `FILL` may be emitted only from a validated exchange-observed `TRADE` execution.

The following never create a `FILL`:

- open-order disappearance
- position delta without execution identity
- cancel acknowledgement
- rejected order
- local planner transition
- timeout / `UNKNOWN` write
- reconstructed or guessed trade ID

`source` is always `"exchange"`. Missing venue identity is omitted, never guessed.

## 3. Changed files

| File | Why |
|---|---|
| `src/types.ts` | `ExecutionRecord`, fault codes, journal drain |
| `src/venues/types.ts` | optional `drainExecutionJournal` / `setExecutionCursorPath` |
| `src/venues/extendedAccountStream.ts` | TRADE ingest, replay-safe journal, cursor, gap/reconnect faults |
| `src/venues/extended.ts` | cursor bind + journal drain; dry-run still skips the websocket |
| `src/experimentTelemetry.ts` | `FILL` provenance helpers; `ORDER_DISAPPEARED`; `EXECUTION_RECONCILIATION_REQUIRED`; reduction event names |
| `src/loop.ts` | drain journal to telemetry; inferred `ORDER_DISAPPEARED`; reduction telemetry around existing halt; no planner fill inference |
| `package.json` | register focused Checkpoint C tests |
| `test/experiment-v02-execution.test.ts` | C-01..C-18 plus WS/planner/Corrective 5 presence checks |
| `docs/classic-v0.2-checkpoint-c-execution.md` | this evidence note |

Unchanged on purpose:

```text
src/experimentReduction.ts
src/experimentRisk.ts
src/grid.ts
src/config.ts
vendor/**
```

Frozen v0.2 values are unchanged: capital=100 USDT, leverage=5x, marginFraction=0.30, plannedGrossNotionalCap=150 USDT, levels=10, gridHalfBand=0.03, dailyLossHalt=5 USDT, startingDrawdownHalt=10 USDT, boundaryBuffer=0.01, venue=Extended, market=BTC.

## 4. Journal semantics

Normalized record fields match the contract `ExecutionRecord`.

- Dedupe key: `extended|<market>|trade|<exchangeTradeId>`
- Duplicate websocket delivery and reconnect replay of the same trade ID do not create a second record
- Two legitimate partials with different trade IDs remain two records
- `price` / `quantity` must be finite and strictly positive
- Trade ID is never substituted from order ID or client order ID
- `authoritativeCount` increments only while journal authority is `trusted`
- Sequence gap and out-of-order data throw `EXTENDED_WS_SEQUENCE_GAP`, do not advance `lastSeq`, and emit `EXECUTION_RECONCILIATION_REQUIRED`
- Reconnect after messages have been observed invalidates authority (`DISCONNECTED`) and keeps seen keys
- Persisted cursor stores seen keys, lineage cumulative, authority, and `authoritativeCount`
- Corrupt or invalidated cursor fails closed (`CURSOR_CONFLICT`); later unique trades are not counted as authoritative
- Websocket `message` handler only calls `state.ingest`; it never places, cancels, or reduces

Planner boundary: executions drive telemetry, audited counters, and reconciliation diagnostics only. They do not drive replacement-order state, `plan.filled`, automatic reseeding, or completed-rung planner advancement. `plan.filled` remains `[]`.

## 5. Telemetry

| Event | Meaning |
|---|---|
| `FILL` | accepted exchange-observed execution; `source=exchange`; actual execution quantity |
| `ORDER_DISAPPEARED` | diagnostic/inferred only; `source=inferred`; never counted as fill |
| `EXECUTION_RECONCILIATION_REQUIRED` | gap, reconnect, malformed identity, cursor conflict, out-of-order |
| `REDUCTION_STARTED` / `REDUCTION_SUBMITTED` / `REDUCTION_VERIFIED` / `REDUCTION_FAILED` | bounded reduction telemetry around the existing Checkpoint B halt |

Telemetry failure is swallowed. It cannot skip, alter, or weaken `runActualNotionalHardHalt`.

## 6. Fault-case mapping

| ID | Claim | Proof |
|---|---|---|
| C-01 | full exchange fill → one authoritative `FILL` | `test/experiment-v02-execution.test.ts` C-01 |
| C-02 | duplicate delivery → one record | C-02 |
| C-03 | partial preserves qty / cumulative / remaining | C-03 |
| C-04 | two legitimate partials are not collapsed | C-04 |
| C-05 | open-order disappearance → no `FILL` | C-05; `plan.filled.length === 0` |
| C-06 | cancel → no `FILL` | C-06 |
| C-07 | rejection → no `FILL` | C-07 |
| C-08 | position delta without execution → no `FILL` | C-08 |
| C-09 | sequence gap invalidates journal authority | C-09 |
| C-10 | reconnect replay does not double-count | C-10 |
| C-11 | malformed / non-finite rejected | C-11 |
| C-12 | missing stable identity does not advance authoritative counters | C-12 |
| C-13 | persisted cursor restart is replay-safe | C-13 |
| C-14 | out-of-order data cannot silently advance the cursor | C-14 |
| C-15 | telemetry failure does not alter risk/reduction handling | C-15 |
| C-16 | Gate 0 / A / B suites remain present and green | C-16 plus `npm run check` |
| C-17 | dry-run performs zero live/network mutations | C-17; `ExtendedExecutor(true).connect()` is a no-op |
| C-18 | diagnostics do not expose secret-like fixture values | C-18 |
| C-19 | websocket callback never places or replaces | C-19 source assertion |
| C-20 | `plan.filled` stays empty; loop no longer emits planner `FILL` | C-20 |
| C-21 / C-22 | Corrective 5 `NOT_SENT` / `UNKNOWN` tests remain | C-21 |

## 7. Known limitations

- Checkpoint D planner deduplication is not started.
- Execution records do not advance planner completed-rung or `plan.filled`.
- Local dashboard/Telegram `completedRungs` from position-delta heuristics is unchanged pre-existing behavior; it is not journal-authoritative.
- Cursor restart does not restore `lastSeq`. Replay safety across process restart is the persisted seen-key set. Sequence-gap detection is intra-connection.
- After authority invalidation, newly observed unique trades may still be retained for diagnostics; they do not increment `authoritativeCount`.
- No real-network test. No production credentials. No live exchange write.

## 8. Independent review

The independent reviewer owns `PASS`, `REJECT`, or `BLOCKED`.
