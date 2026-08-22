# Classic Grid Experiment Spec v0.2 — 100U Safety Canary

Status: DRAFT / NO LIVE AUTHORIZATION  
Date: 2026-08-22  
Base: `experiment/classic-v0.1` @ `a168c487e210306aab17cf428dec67d8168b68fe`

## Purpose

Prepare a bounded 100 USDT experiment envelope for engineering validation. This document does **not** authorize live trading and does not claim profitability.

The primary goals are execution correctness, fail-closed risk behavior, restart consistency, telemetry integrity, and bounded exposure.

## Frozen v0.2 test envelope

| Parameter | Value |
|---|---:|
| Starting capital | 100 USDT |
| Exchange leverage | 5x |
| Maximum margin budget | 30 USDT (30%) |
| Maximum planned gross notional | 150 USDT |
| Primary underlying | BTC perpetual |
| Grid half-band | ±3.0% from anchor |
| Grid level count | 10 total levels |
| Poll/tick target | 15 s |
| Daily loss hard halt | 5 USDT |
| Drawdown-from-start hard halt | 10 USDT |
| Boundary buffer | 1.0% beyond active grid |
| Soft/restart recovery | Required |
| Withdrawal permission | Disabled |

These values are a conservative engineering test envelope, not an optimized trading configuration.

## Mandatory safety corrections before any live canary

### 1. Actual-notional over-cap must actively reduce exposure

Current v0.1 behavior can classify `ACTUAL_NOTIONAL_CAP` as `reduceOnly`, while the generic intent filter retains only cancel intents. v0.2 must not call this state "reduce only" unless it has a verified path that actually reduces position exposure.

Required behavior when actual position notional exceeds the cap:

1. stop all risk-increasing placement;
2. cancel owned risk-increasing open orders;
3. invoke a bounded, venue-supported position reduction/flatten path;
4. verify using a fresh exchange snapshot;
5. remain HALTED or REDUCING until verified inside the envelope;
6. never resume grid seeding automatically after an unresolved over-cap event.

### 2. FILL telemetry must distinguish observed vs inferred fills

Planner-level disappearance of an order from an open-order snapshot must not be emitted as an authoritative exchange-observed `FILL` without evidence.

Required schema behavior:

- exchange-confirmed execution: `event=FILL`, `source=exchange`, include exchange order/trade identifiers where available;
- inferred disappearance: use a distinct event/status such as `ORDER_DISAPPEARED` or `source=inferred`, and never count it as authoritative realized fill telemetry;
- partial fills must preserve filled and remaining quantity where the venue exposes them.

### 3. Freshness and PnL inputs remain fail-closed in live mode

Live mode must continue to halt when equity, official PnL, or freshness timestamps are unavailable/stale. Funding must be included in daily net PnL when the venue exposes it.

### 4. Dashboard remains local-only and mutation-gated

Dashboard must bind to `127.0.0.1`. Live experiment mode must not expose unauthenticated mutation endpoints. If mutations are enabled, require an auth token.

### 5. Runtime ownership and durable risk state remain mandatory

Preserve:

- runtime lease/fencing;
- checksummed risk-state primary + backup;
- fail-closed corruption handling;
- unique halt acknowledgement token;
- deterministic experiment-owned order identity where venue capability exists;
- soft-resume checkpoint validation.

## Configuration contract

Introduce/resolve v0.2 values through experiment configuration rather than altering legacy defaults:

```text
EXPERIMENT_MODE=1
EXPERIMENT_SPEC_VERSION=0.2.0
EXPERIMENT_CAPITAL_USD=100
EXPERIMENT_LEVERAGE=5
EXPERIMENT_MARGIN_FRAC=0.30
EXPERIMENT_GRID_COUNT=10
EXPERIMENT_HALF_BAND_PCT=0.03
EXPERIMENT_MAX_GROSS_NOTIONAL_USD=150
EXPERIMENT_DAILY_LOSS_USD=5
EXPERIMENT_MAX_DRAWDOWN_USD=10
EXPERIMENT_BOUNDARY_BUFFER_PCT=0.01
```

Legacy non-experiment behavior must remain unchanged.

## Required tests

1. v0.2 resolves 100U / 5x / 30% / 10 levels / ±3% / 150U cap.
2. Planned full-grid notional cannot exceed 150U.
3. Actual position notional above 150U enters an active reduction/halt path, not cancel-only pseudo-reduction.
4. Failed reduction remains fail-closed and cannot reseed.
5. Fresh snapshot verification is required before clearing over-cap state.
6. Daily loss at -5U hard-halts.
7. Drawdown from starting equity at 10U hard-halts.
8. Boundary breach with adverse inventory hard-halts.
9. Missing/stale live equity or PnL hard-halts.
10. Inferred order disappearance is not logged as an authoritative exchange fill.
11. Exchange-observed fill telemetry preserves source and identifiers where available.
12. Partial/ambiguous apply does not advance local planner state.
13. Restart preserves anchor and does not duplicate owned logical orders.
14. Corrupt/missing durable risk state fails closed.
15. Runtime lease loss prevents further exchange writes.
16. Dashboard listens only on loopback.
17. Live dashboard mutations require explicit auth or remain disabled.
18. `DRY_RUN=0` still requires `LIVE_CONFIRM=YES` plus experiment preflight.

## Acceptance gate

Before this branch can be considered live-canary-ready:

- CI passes from a clean `npm ci` on Node 22;
- all v0.2 tests pass;
- bounded dry-run evidence is attached to the PR;
- no live exchange write is used as a test substitute;
- no secret material is committed or logged;
- reviewer confirms actual-notional reduction semantics and fill provenance independently;
- PR remains Draft until an explicit live-canary review occurs.

## Non-goals

- no optimization claims;
- no increase above 100U;
- no leverage increase above 5x;
- no multi-venue live rollout;
- no automatic merge to `main`;
- no live authorization from CI success alone.
