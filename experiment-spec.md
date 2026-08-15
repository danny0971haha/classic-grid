# Grid Bot A/B Experiment Specification

Version: 0.1.0  
Date: 2026-08-15  
Bots: `beibei030/classic-grid` and `discountry/ritmex-bot`

## 1. Purpose

This experiment compares two grid-bot implementations under the same capital and risk envelope.

The objective is **not** to prove profitability from a short run. The first objective is to compare:

1. execution correctness;
2. crash/restart recovery;
3. order-state consistency;
4. exposure control;
5. realized transaction costs;
6. operational stability;
7. net performance after fees/funding.

Strategy-specific behavior is intentionally preserved where it is part of the bot design:

- Classic Grid keeps its arithmetic/classic replacement-grid behavior.
- RitMEX keeps its native grid state machine and grid geometry.

Common risk and telemetry rules must be identical wherever technically possible.

---

## 2. Experiment invariants

The following values are frozen for the first live-canary experiment unless this specification is versioned.

| Parameter | Value | Rule |
|---|---:|---|
| Starting capital | 50 USDT per bot | Dedicated account/subaccount only |
| Exchange leverage | **10x** | Must be configured at exchange and verified by bot if API supports it |
| Maximum margin budget | **30% of starting capital = 15 USDT** | Leverage does not authorize use of the whole account |
| Maximum planned gross notional | **150 USDT** | `15 USDT × 10x`; hard cap |
| Primary underlying | BTC perpetual | Use same underlying for both bots where possible |
| Fallback underlying | ETH perpetual | Only if venue minimum-order rules make BTC test infeasible |
| Grid half-band | **±3.0% from anchor** | Normalized percentage, not a hard-coded dollar width |
| Grid level count | **12 total levels** | Target 6 below / 6 above anchor where implementation permits |
| Grid geometry | Native to each bot | Classic arithmetic; RitMEX native geometry |
| Poll/tick target | 15 s | Exchange/event-driven updates may be faster |
| Soft/restart recovery | Enabled | Mandatory before live run |
| API withdrawal permission | Disabled | Mandatory |
| Position mode | One-way where applicable | Mandatory unless venue architecture differs |
| Margin mode | Isolated where supported | Otherwise use a dedicated subaccount plus hard notional cap |

### 2.1 Why 10x does not mean 500 USDT exposure

The account contains 50 USDT and leverage is fixed at 10x, but the experiment limits planned margin to 15 USDT. Therefore the first test is capped at approximately 150 USDT planned gross notional.

The remaining capital is a buffer for maintenance margin, fees, funding, slippage, and abnormal execution states.

---

## 3. Common risk envelope

All bots must implement or enforce the following guards before live-canary approval.

### 3.1 Hard exposure cap

- `MAX_PLANNED_GROSS_NOTIONAL_USD = 150`
- The bot must refuse to seed or extend the grid if the resulting planned exposure exceeds the cap.
- If actual position notional exceeds the cap because of abnormal fills, the bot must stop adding exposure and enter risk-reduction mode.

### 3.2 Daily loss kill-switch

- `DAILY_LOSS_LIMIT_USD = 2.50` (5% of starting capital)
- Loss measurement should use exchange-reported realized PnL + fees + funding where available.
- When the limit is breached:
  1. cancel grid orders;
  2. close/reduce the position;
  3. mark the experiment HALTED;
  4. require explicit manual acknowledgement before restart.

### 3.3 Account drawdown kill-switch

- `MAX_DRAWDOWN_USD = 5.00` (10% of starting capital)
- Baseline is the recorded experiment starting equity or the highest verified experiment equity, depending on the metric being reported.
- The implementation must record both:
  - drawdown from starting equity;
  - drawdown from high-water mark.
- A 5 USDT drawdown from starting equity is a hard halt condition for v0.1.

### 3.4 Grid boundary risk guard

Initial grid range is anchor ±3%.

A hard boundary buffer is placed **1.0% beyond the active grid boundary**:

- lower kill boundary ≈ `grid_lower × 0.99`;
- upper kill boundary ≈ `grid_upper × 1.01`.

If price breaches the relevant boundary while the bot carries adverse inventory:

1. cancel risk-increasing orders;
2. attempt controlled flatten/reduction;
3. halt the strategy;
4. emit a `RISK_BOUNDARY_BREACH` event.

This is an experiment safety rule, not a claim that ±3% is an optimal trading range.

### 3.5 Order safety

Mandatory invariants:

- No more than one intended active order for the same logical grid level/side unless the venue requires otherwise.
- All orders must have an identifiable experiment/bot origin when client order IDs are supported.
- No new risk-increasing orders after a hard risk guard is triggered.
- Unknown/orphan orders must be surfaced in telemetry.
- An API error must never silently convert into a successful local state transition.

---

## 4. Live trading gate

Live mode must require all of the following:

1. dry-run has passed acceptance tests;
2. dedicated 50 USDT account/subaccount funded;
3. withdrawal permission disabled;
4. leverage verified as 10x;
5. configured planned margin <= 15 USDT;
6. configured planned gross notional <= 150 USDT;
7. restart recovery enabled;
8. risk kill-switch enabled;
9. telemetry directory writable;
10. explicit human live confirmation.

Classic Grid must retain its existing `DRY_RUN=0` + `LIVE_CONFIRM=YES` double opt-in. RitMEX should be given an equivalent explicit production acknowledgement in the experiment branch.

---

## 5. Experiment phases

### Phase A — Static/unit validation

No exchange writes.

Must verify:

- config resolves to 50 USDT / 10x / 30% margin budget;
- all venue-specific leverage defaults are overridden in experiment mode;
- calculated full-grid planned notional <= 150 USDT;
- fee-vs-grid-spacing check passes;
- boundary, daily-loss, drawdown and exposure guards have unit tests;
- live gate fails closed.

### Phase B — Dry-run / paper execution

Minimum acceptance conditions:

- no duplicate logical grid orders;
- fill -> replacement behavior remains correct;
- no local state advance on rejected exchange action;
- restart does not reseed the entire grid incorrectly;
- risk breach produces HALTED state;
- telemetry is complete enough to reconstruct every state transition.

### Phase C — Fault injection

At minimum test:

1. process termination with open orders;
2. restart with existing exchange orders;
3. temporary API/network failure;
4. order rejection;
5. partial fill if venue/test harness allows;
6. stale snapshot / delayed state update;
7. unexpected extra order (orphan simulation);
8. price outside grid boundary.

A fault test is a failure if the bot can increase unbounded exposure or silently lose order ownership/state.

### Phase D — 50 USDT live canary

Only after A-C pass.

Start with one venue and one market per bot.

No capital increase during v0.1.

### Phase E — Comparative evaluation

Do not select a winner solely from short-term PnL.

Evaluate reliability and performance together after a meaningful sample of fills/grid cycles and more than one market regime.

---

## 6. Common telemetry schema

Each bot must emit append-only JSON Lines (`.jsonl`).

Recommended location:

`data/experiments/<experiment_id>/events.jsonl`

Each event should contain, where available:

```json
{
  "schema_version": "1.0",
  "ts": "2026-08-15T12:00:00.000Z",
  "experiment_id": "grid-ab-v0.1-classic-001",
  "bot": "classic-grid",
  "commit_sha": "<pinned commit>",
  "mode": "dry-run|live",
  "venue": "<venue>",
  "symbol": "BTC",
  "event": "SNAPSHOT|ORDER_SUBMIT|ORDER_ACK|FILL|CANCEL|RESTART|ERROR|RISK_HALT",
  "anchor": 0,
  "grid_lower": 0,
  "grid_upper": 0,
  "grid_level": null,
  "side": null,
  "mid": 0,
  "equity_usd": null,
  "free_margin_usd": null,
  "leverage": 10,
  "position_qty": 0,
  "position_notional_usd": 0,
  "planned_gross_notional_usd": 0,
  "margin_used_usd": null,
  "open_order_count": 0,
  "order_id": null,
  "client_order_id": null,
  "order_price": null,
  "order_qty": null,
  "fee_usd": null,
  "funding_usd": null,
  "realized_pnl_usd": null,
  "unrealized_pnl_usd": null,
  "net_pnl_usd": null,
  "grid_profit_estimate_usd": null,
  "api_latency_ms": null,
  "error_code": null,
  "error_message": null,
  "restart_count": 0,
  "reconnect_count": 0,
  "risk_flags": []
}
```

Do not invent unavailable exchange metrics. Use `null` and preserve source attribution in implementation-specific fields if necessary.

---

## 7. Required comparison metrics

### 7.1 Trading/performance

- Net PnL after fees and funding
- Gross realized PnL
- Grid profit estimate
- Fees paid
- Funding paid/received
- Maximum drawdown from start
- Maximum drawdown from high-water mark
- Number of fills
- Number of completed grid cycles/rungs
- PnL per completed cycle
- Maker/taker ratio where available
- Maximum absolute inventory
- Maximum position notional

### 7.2 Reliability

- Duplicate logical order count
- Orphan/unknown order count
- Reconciliation/recovery events
- API/order errors
- Rejected orders
- Restart count
- Reconnect count
- Manual interventions
- Time spent HALTED
- Time spent running normally

### 7.3 Operational score

A bot that makes slightly more money but requires repeated manual intervention should not automatically win.

Record a simple operational score based on:

- zero unbounded exposure events;
- zero silent state-corruption events;
- restart consistency;
- manual intervention count;
- data completeness.

---

## 8. Run manifest

Every run must create `manifest.json` containing at least:

```json
{
  "experiment_spec_version": "0.1.0",
  "experiment_id": "<unique id>",
  "bot": "classic-grid|ritmex-bot",
  "repo": "<repo url>",
  "commit_sha": "<pinned sha>",
  "started_at": "<ISO-8601>",
  "mode": "dry-run|live",
  "starting_capital_usd": 50,
  "leverage": 10,
  "max_margin_budget_usd": 15,
  "max_planned_gross_notional_usd": 150,
  "grid_half_band_pct": 3.0,
  "grid_level_count": 12,
  "daily_loss_limit_usd": 2.5,
  "max_drawdown_usd": 5.0,
  "boundary_buffer_pct": 1.0,
  "venue": "<venue>",
  "symbol": "BTC"
}
```

Secrets must never be written to the manifest or telemetry.

---

## 9. Acceptance criteria before live canary

All are mandatory:

- [ ] Tests pass.
- [ ] Dry-run is the default/fail-closed mode.
- [ ] 10x leverage is visible in resolved runtime configuration.
- [ ] Margin budget is <= 15 USDT.
- [ ] Planned gross notional is <= 150 USDT.
- [ ] Grid level count resolves to 12.
- [ ] Grid range resolves to approximately anchor ±3%.
- [ ] Fee gate passes with the selected venue's actual configured fee assumption.
- [ ] Daily-loss guard test passes.
- [ ] Drawdown guard test passes.
- [ ] Boundary-stop guard test passes.
- [ ] Exposure-cap guard test passes.
- [ ] Cancel + flatten kill-switch test passes.
- [ ] Restart/soft-resume test passes.
- [ ] No duplicate logical orders in restart test.
- [ ] Telemetry records startup, order lifecycle, fills, errors, restarts and risk halts.
- [ ] `manifest.json` records the exact commit SHA.
- [ ] API key cannot withdraw funds.
- [ ] Live mode still requires explicit human confirmation.

---

## 10. Classic Grid implementation contract

For the first implementation, Classic Grid keeps its native arithmetic-grid/replacement logic.

### Must preserve

- existing fee-spacing validation;
- existing margin pre-check;
- existing `SOFT_RESUME` behavior;
- existing `DRY_RUN=0` + `LIVE_CONFIRM=YES` live gate;
- existing venue adapters and dashboard unless a change is required for telemetry.

### Must add/change

1. **Experiment configuration**
   - `EXPERIMENT_MODE=1`
   - `EXPERIMENT_ID=`
   - `EXPERIMENT_CAPITAL_USD=50`
   - `EXPERIMENT_LEVERAGE=10`
   - `EXPERIMENT_MARGIN_FRAC=0.30`
   - `EXPERIMENT_GRID_COUNT=12`
   - `EXPERIMENT_HALF_BAND_PCT=0.03`
   - `EXPERIMENT_MAX_GROSS_NOTIONAL_USD=150`
   - `EXPERIMENT_DAILY_LOSS_USD=2.5`
   - `EXPERIMENT_MAX_DRAWDOWN_USD=5`
   - `EXPERIMENT_BOUNDARY_BUFFER_PCT=0.01`

2. **Experiment-mode precedence**
   - In experiment mode, common leverage must override `GRID_LEVERAGE`, `RISEX_LEVERAGE`, `PHOENIX_LEVERAGE`, and venue defaults.
   - Common grid count must override venue grid-count defaults.
   - Equity sizing must use 50 USDT rather than the hard-coded 800 USDT template.
   - Grid width must be derived from live anchor percentage rather than a fixed BTC-dollar half-band.

3. **Risk module**
   - Add a dedicated risk module rather than scattering checks through venue adapters.
   - Implement daily loss, starting-equity drawdown, high-water drawdown tracking, boundary breach and actual-position notional cap.
   - A hard breach must stop risk-increasing order placement.

4. **Kill-switch**
   - On hard breach: `cancelAll` -> `closePosition`/reduce -> verify snapshot -> persist HALTED state.
   - If cancel or close fails, keep retry/error telemetry and never resume seeding automatically.

5. **Telemetry**
   - Append-only JSONL event log using the common schema.
   - Create run manifest with commit SHA and resolved experiment config.

6. **Tests**
   - Add experiment config precedence tests.
   - Add all risk-guard tests.
   - Add restart + duplicate-order regression test.
   - Add live-gate regression test.
   - Add telemetry schema smoke test.

---

## 11. RitMEX implementation contract

RitMEX is implemented only after Classic v0.1 passes its local tests.

RitMEX must use the same capital, leverage, margin budget, notional cap, grid range target, level-count target, telemetry schema and kill-switch thresholds.

Its native per-level state machine, order registry, persistence/reconciliation and exchange-side stop mechanisms should be preserved rather than replaced with Classic Grid logic.

---

## 12. Change control

Any change to capital, leverage, margin fraction, notional cap, grid band, grid count or risk thresholds requires:

1. incrementing the experiment spec version;
2. recording the new version in the manifest;
3. not mixing old and new runs in the same performance aggregate.

The 10x leverage rule is therefore fixed for experiment spec v0.1.0.
