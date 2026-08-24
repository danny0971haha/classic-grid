# Classic Grid v0.2 — Checkpoint C Corrective 1

**Status:** CHECKPOINT_C_REVIEW_CANDIDATE / INDEPENDENT REVIEW REQUIRED
**Date:** 2026-08-24
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-100u-safety`
**Draft PR:** `#3`
**Current task:** `CHECKPOINT_C_CORRECTIVE_1_ONLY`

This document does **not** declare Checkpoint C PASS. CI success is not a gate verdict.

```text
CHECKPOINT_B=PASS
CHECKPOINT_C=REVIEW_CANDIDATE
CHECKPOINT_C_SELF_DECLARED_PASS=NO
CHECKPOINT_D_STARTED=NO
CHECKPOINT_D_AUTHORIZED=NO
CHECKPOINT_E_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH_AUTHORIZED=NO
```

Rejected previous Checkpoint C candidate:

```text
REJECTED_HEAD=ce3d1d9630c02763e1f7a9815357c756d51455ad
REJECTED_TREE=af031cc302642552d0c1093c46f4b59c6730d00d
```

Accepted Checkpoint B baseline remains:

```text
BASE_HEAD=197369a00a7c1f7080f2a1ebea76ffae20ac13ba
BASE_TREE=6c08c9e3fb78a86591423ea47a60ce96e1c9f796
CHECKPOINT_B_CORRECTIVE_5=PASS
```

## 1. Corrected blockers

### C-BLOCKER-01 — per-record authority

Authority is captured on each `ExecutionRecord` at observation time. `source="exchange"` does not imply authority.

- A record observed while `trusted` may emit exactly one authoritative `FILL`.
- A later sequence gap, reconnect, malformed identity, or cursor conflict does not revoke that per-record flag.
- A record first observed after invalidation may be retained as diagnostic evidence and must not enter `authoritativeExecutions`, increment `authoritativeCount`, or publish as `FILL`.
- `publishExecutionJournal` consumes only `drain.authoritativeExecutions`. It does not infer authority from `drain.authority` or `source`.

### C-BLOCKER-02 — stable restart cursor

The production cursor is no longer written under `experimentTelemetry.dir` (that path embeds a unique `runId`).

Path derivation:

```text
<data/experiments or baseDir>/<safeExperimentId>/execution-cursors/<sha256Canonical(identity)[0:32]>.json
```

Identity fields hashed into the filename, never interpolated as path segments:

```text
schemaVersion=classic-grid.execution-cursor.v2
experimentId
scopeKey
venue
normalized market
```

Market normalization is `BTC` → `BTC-USD`. Raw scope strings, account scopes, and telemetry run IDs are not filesystem path components.

Cursor load rules:

- missing file: initialize empty per the original Checkpoint C contract;
- v1 / corrupt / truncated / identity mismatch: fail closed, emit `CURSOR_CONFLICT`, load no seen keys;
- foreign seen keys are never treated as local.

Directory mode `0700`, file mode `0600`.

### C-BLOCKER-03 — bounded drain

Absolute array-index drain plus front-splice is removed for execution and fault queues.

- Authoritative records stay in a pending queue until `acknowledgeJournal` after a successful `FILL` emit.
- Diagnostic executions and faults are removed on drain.
- Capacity is `EXECUTION_JOURNAL_LIMIT=2000` undrained records. Overflow fails closed with `JOURNAL_CAPACITY` rather than silently deleting undrained authoritative data.
- Periodic drain continues past the limit (C-C12, C-C14).

## 2. Restart / replay disposition

Accept/persist happens before telemetry publish. The durable cursor stores:

- `pendingAuthoritative` — accepted, not yet successfully published;
- `publishedDedupeKeys` — watermark after emit success;
- `seenDedupeKeys` — replay suppression.

| Window | Disposition |
|---|---|
| Crash after persist, before publish | Restart re-drains the pending record. Exactly one `FILL`. Not treated as already published. |
| Exchange replay of the same `exchangeTradeId` after ack | Zero additional `FILL`. |
| New unique trade after clean trusted restart | Observable exactly once. |
| `emit()` returns `false` | That record is not acknowledged and remains drainable. Telemetry failure does not alter reduction/risk handling. |

A crash after a durable `FILL` append and before watermark ack can re-deliver at-least-once. Consumers can detect that by `exchange_trade_id`. That window is after publication, not the accept→publish window required by C-C11.

## 3. Changed files for Corrective 1

| File | Why |
|---|---|
| `src/types.ts` | `authoritative` on `ExecutionRecord`; explicit `authoritativeExecutions`; `JOURNAL_CAPACITY` |
| `src/venues/types.ts` | `setExecutionCursorBind`; `acknowledgeExecutionJournal` |
| `src/venues/extendedAccountStream.ts` | per-record authority; pending/ack watermark; identity-bound v2 cursor; bounded queues |
| `src/venues/extended.ts` | bind + ack wiring; dry-run still skips the websocket |
| `src/experimentTelemetry.ts` | `resolveExecutionCursorPath`; publish only `authoritativeExecutions`; return published keys |
| `src/loop.ts` | stable cursor bind independent of telemetry `runId`; ack only successful emits |
| `test/experiment-v02-execution.test.ts` | C-C1..C-C15 plus updated C-09/C-13/C-14/C-20 |
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

- Dedupe key: `extended|<market>|trade|<exchangeTradeId>`
- Duplicate websocket delivery and reconnect replay of the same trade ID do not create a second record
- Two legitimate partials with different trade IDs remain two records
- `price` / `quantity` must be finite and strictly positive
- Trade ID is never substituted from order ID or client order ID
- Sequence gap / out-of-order throw `EXTENDED_WS_SEQUENCE_GAP`, do not advance `lastSeq`, observe the payload as non-authoritative, and emit `EXECUTION_RECONCILIATION_REQUIRED`
- Reconnect after messages have been observed invalidates current authority (`DISCONNECTED`) and keeps seen keys
- Websocket `message` handler only calls `state.ingest`; it never places, cancels, or reduces

Planner boundary: executions drive telemetry, audited counters, and reconciliation diagnostics only. They do not drive replacement-order state, `plan.filled`, automatic reseeding, or completed-rung planner advancement. `plan.filled` remains `[]`.

## 5. Telemetry

| Event | Meaning |
|---|---|
| `FILL` | per-record authoritative exchange-observed execution; `source=exchange` is not sufficient |
| `ORDER_DISAPPEARED` | diagnostic/inferred only; `source=inferred`; never counted as fill |
| `EXECUTION_RECONCILIATION_REQUIRED` | gap, reconnect, malformed identity, cursor conflict, out-of-order, capacity |
| `REDUCTION_STARTED` / `REDUCTION_SUBMITTED` / `REDUCTION_VERIFIED` / `REDUCTION_FAILED` | bounded reduction telemetry around the existing Checkpoint B halt |

Telemetry failure is swallowed. It cannot skip, alter, or weaken `runActualNotionalHardHalt`, and it cannot watermark a pending authoritative record as published.

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
| C-C1 | post-gap unique trade → reconciliation, zero `FILL` | C-C1 |
| C-C2 | post-reconnect unique trade → zero authoritative `FILL` | C-C2 |
| C-C3 | pre-gap trusted trade → exactly one `FILL`; post-gap none | C-C3 |
| C-C4 | cursor conflict then unique trade → zero authoritative `FILL` | C-C4 |
| C-C5 | malformed identity then valid trade while invalidated → no `FILL` | C-C5 |
| C-C6 | two telemetry run IDs resolve the same stable cursor | C-C6 |
| C-C7 | replay after restart → no duplicate | C-C7 |
| C-C8 | new trade after clean restart → exactly once | C-C8 |
| C-C9 | scope/venue/market mismatch fails closed | C-C9 |
| C-C10 | corrupt/truncated cursor fail closed without leaking payload | C-C10 |
| C-C11 | crash between accept and publish: no duplicate, no silent loss | C-C11 |
| C-C12 | >2500 unique executions with periodic drains | C-C12 |
| C-C13 | >`JOURNAL_LIMIT` before first drain fail-closes without silent loss | C-C13 |
| C-C14 | fault queue drains past `JOURNAL_LIMIT` or fail-closes at capacity | C-C14 |
| C-C15 | no undrained authoritative execution is silently removed | C-C15 |

## 7. Known limitations

- Checkpoint D planner deduplication is not started.
- Execution records do not advance planner completed-rung or `plan.filled`.
- Local dashboard/Telegram `completedRungs` from position-delta heuristics is unchanged pre-existing behavior; it is not journal-authoritative.
- Cursor restart does not restore `lastSeq`. Sequence-gap detection remains intra-connection.
- Crash after durable `FILL` append and before watermark ack is at-least-once; C-C11 covers accept→publish.
- No real-network test. No production credentials. No live exchange write.

## 8. Independent review

The independent reviewer owns `PASS`, `REJECT`, or `BLOCKED`.

```text
CHECKPOINT_C_SELF_DECLARED_PASS=NO
CHECKPOINT_C=REVIEW_CANDIDATE
CHECKPOINT_D_STARTED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
```
