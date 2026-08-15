# Classic Grid — Phase 1 Implementation Plan

Target: bring `beibei030/classic-grid` into compliance with `experiment-spec.md` v0.1.0 without changing its core classic arithmetic-grid strategy.

## Priority 0 — Baseline

Before editing:

```bash
git checkout -b experiment/classic-v0.1
git rev-parse HEAD
git status
npm ci
npm test
DRY_RUN=1 npm start -- --once
```

Record the original commit SHA.

## Priority 1 — Configuration normalization

Files: `src/config.ts`, `.env.example`, tests.

Add experiment-mode config and ensure it has the highest strategy-sizing precedence.

Required resolved values in experiment mode:

```text
capital = 50 USDT
leverage = 10x
marginFraction = 0.30
gridCount = 12
halfBandPct = 0.03
maxGrossNotional = 150 USDT
dailyLossLimit = 2.5 USDT
maxDrawdown = 5 USDT
boundaryBufferPct = 0.01
```

Important: the current code has venue-specific leverage defaults. Experiment mode must override every one of them, including RISEx and Phoenix.

Grid half-band should be percentage-based for experiment mode:

```text
halfBand = anchorMid * 0.03
lower = anchorMid * 0.97
upper = anchorMid * 1.03
```

Do not remove the legacy behavior outside experiment mode.

## Priority 2 — Hard risk module

Create a module such as `src/experimentRisk.ts`.

Suggested responsibilities:

```ts
export type RiskDecision = {
  halt: boolean;
  reduceOnly: boolean;
  reasons: string[];
};
```

Inputs should include verified snapshot/equity/PnL/position/mid/grid bounds and experiment thresholds.

Implement:

- planned gross-notional cap;
- actual position-notional cap;
- daily loss limit;
- starting-equity drawdown;
- high-water-mark tracking;
- grid boundary breach with adverse inventory;
- persisted HALTED state.

Risk evaluation should occur before creating new risk-increasing desired orders.

## Priority 3 — Kill-switch integration

File: `src/loop.ts`.

On hard risk breach:

```text
risk breach
  -> stop new grid writes
  -> cancelAll
  -> closePosition/reduce
  -> snapshot verification
  -> persist HALTED
  -> telemetry
```

Failure of `cancelAll` or `closePosition` must not clear HALTED state.

Manual restart must be required after a hard halt.

## Priority 4 — Experiment telemetry

Create `src/experimentTelemetry.ts`.

Write:

```text
data/experiments/<experiment_id>/manifest.json
data/experiments/<experiment_id>/events.jsonl
```

Do not log keys, private keys, auth headers, tokens or complete signed requests.

At minimum log:

- boot/config;
- snapshots;
- order submit/ack/reject;
- fill inferred/observed;
- cancel;
- position changes;
- restart/soft-resume;
- API errors;
- risk decisions;
- halt/flatten result.

## Priority 5 — Tests

Extend beyond the existing `test/grid.test.ts`.

Required regression cases:

1. experiment mode resolves leverage=10 for every venue;
2. experiment mode resolves equity=50 and marginFraction=0.30;
3. experiment grid count=12 overrides 80/65/46 venue defaults;
4. 3% half-band derives from live anchor;
5. full-grid planned gross notional <=150;
6. daily loss 2.50 triggers halt;
7. drawdown 5.00 triggers halt;
8. boundary + adverse inventory triggers halt;
9. exposure above cap stops new risk;
10. live mode still refuses without `LIVE_CONFIRM=YES`;
11. soft-resume preserves anchor and does not duplicate logical grid orders;
12. telemetry can write a valid manifest and JSONL event.

## Priority 6 — Dry-run acceptance

Run:

```bash
npm test
DRY_RUN=1 \
EXPERIMENT_MODE=1 \
EXPERIMENT_ID=classic-dryrun-001 \
EXPERIMENT_CAPITAL_USD=50 \
EXPERIMENT_LEVERAGE=10 \
EXPERIMENT_MARGIN_FRAC=0.30 \
EXPERIMENT_GRID_COUNT=12 \
EXPERIMENT_HALF_BAND_PCT=0.03 \
npm start -- --once
```

Startup output must explicitly print the resolved experiment envelope, including:

```text
EXPERIMENT MODE
capital=50U
leverage=10x
marginBudget=15U
maxGrossNotional=150U
gridCount=12
halfBand=3%
dailyLossLimit=2.5U
maxDrawdown=5U
```

Do not enable live mode until the acceptance checklist in `experiment-spec.md` is complete.
