import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acknowledgeHaltIfRequested,
  emptyRiskState,
  evaluateExperimentRisk,
  filterRiskIncreasingIntents,
  persistRiskState,
  loadRiskState,
  type ExperimentRiskLimits,
  type RiskMarketInput,
  worstCaseGrossNotionalUsd,
} from "../src/experimentRisk.js";
import { withEnv } from "./helpers/env.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Intent } from "../src/types.js";

const LIMITS: ExperimentRiskLimits = {
  maxGrossNotionalUsd: 150,
  dailyLossUsd: 2.5,
  maxDrawdownUsd: 5,
  boundaryBufferPct: 0.01,
};

function input(partial: Partial<RiskMarketInput> = {}): RiskMarketInput {
  return {
    mid: 100_000,
    equityUsd: 50,
    dailyPnlUsd: 0,
    positionQty: 0,
    positionNotionalUsd: 0,
    plannedGrossNotionalUsd: 150,
    gridLower: 97_000,
    gridUpper: 103_000,
    ...partial,
  };
}

describe("experiment risk guards", () => {
  it("halts when daily loss reaches 2.50U", () => {
    const { decision, next } = evaluateExperimentRisk(
      input({ dailyPnlUsd: -2.5 }),
      LIMITS,
      emptyRiskState()
    );
    assert.equal(decision.halt, true);
    assert.ok(decision.reasons.includes("DAILY_LOSS"));
    assert.equal(next.halted, true);
  });

  it("halts when drawdown from starting equity reaches 5.00U", () => {
    const started = emptyRiskState();
    const first = evaluateExperimentRisk(input({ equityUsd: 50 }), LIMITS, started);
    assert.equal(first.decision.halt, false);
    assert.equal(first.next.startingEquityUsd, 50);
    const { decision, next } = evaluateExperimentRisk(
      input({ equityUsd: 45 }),
      LIMITS,
      first.next
    );
    assert.equal(decision.halt, true);
    assert.ok(decision.reasons.includes("DRAWDOWN_FROM_START"));
    assert.equal(next.drawdownFromStartUsd, 5);
    assert.ok((next.highWaterMarkUsd ?? 0) >= 50);
  });

  it("tracks high-water drawdown without using it as the v0.1 hard halt", () => {
    const s1 = evaluateExperimentRisk(input({ equityUsd: 50 }), LIMITS, emptyRiskState());
    const s2 = evaluateExperimentRisk(input({ equityUsd: 54 }), LIMITS, s1.next);
    const s3 = evaluateExperimentRisk(input({ equityUsd: 50 }), LIMITS, s2.next);
    assert.equal(s3.next.highWaterMarkUsd, 54);
    assert.equal(s3.next.drawdownFromHwmUsd, 4);
    assert.equal(s3.decision.halt, false);
  });

  it("halts on boundary breach with adverse inventory", () => {
    const longBelow = evaluateExperimentRisk(
      input({ mid: 97_000 * 0.99 - 1, positionQty: 0.001, positionNotionalUsd: 100 }),
      LIMITS,
      emptyRiskState()
    );
    assert.equal(longBelow.decision.halt, true);
    assert.ok(longBelow.decision.reasons.includes("RISK_BOUNDARY_BREACH"));

    const shortAbove = evaluateExperimentRisk(
      input({ mid: 103_000 * 1.01 + 1, positionQty: -0.001, positionNotionalUsd: 100 }),
      LIMITS,
      emptyRiskState()
    );
    assert.equal(shortAbove.decision.halt, true);
    assert.ok(shortAbove.decision.reasons.includes("RISK_BOUNDARY_BREACH"));

    const noInventory = evaluateExperimentRisk(
      input({ mid: 97_000 * 0.99 - 1, positionQty: 0, positionNotionalUsd: 0 }),
      LIMITS,
      emptyRiskState()
    );
    assert.equal(noInventory.decision.halt, false);
  });

  it("stops new risk when planned or actual notional exceeds 150U", () => {
    const planned = evaluateExperimentRisk(
      input({ plannedGrossNotionalUsd: 150.01 }),
      LIMITS,
      emptyRiskState()
    );
    assert.equal(planned.decision.halt, false);
    assert.equal(planned.decision.reduceOnly, true);
    assert.ok(planned.decision.reasons.includes("PLANNED_NOTIONAL_CAP"));

    const actual = evaluateExperimentRisk(
      input({ positionNotionalUsd: 151, positionQty: 0.002 }),
      LIMITS,
      emptyRiskState()
    );
    assert.equal(actual.decision.reduceOnly, true);
    assert.ok(actual.decision.reasons.includes("ACTUAL_NOTIONAL_CAP"));

    const ok = evaluateExperimentRisk(
      input({ plannedGrossNotionalUsd: 150, positionNotionalUsd: 150 }),
      LIMITS,
      emptyRiskState()
    );
    assert.equal(ok.decision.reduceOnly, false);
    assert.equal(ok.decision.halt, false);
  });

  it("fails closed when live equity/PnL inputs are missing or stale", () => {
    const missing = evaluateExperimentRisk(
      input({ equityUsd: null, dailyPnlUsd: null, requireFreshInputs: true, snapshotAgeMs: 0, pnlAgeMs: 0 }),
      LIMITS,
      emptyRiskState()
    );
    assert.equal(missing.decision.halt, true);
    assert.ok(missing.decision.reasons.includes("EQUITY_UNAVAILABLE"));
    assert.ok(missing.decision.reasons.includes("DAILY_PNL_UNAVAILABLE"));

    const stale = evaluateExperimentRisk(
      input({ requireFreshInputs: true, snapshotAgeMs: 120_001, pnlAgeMs: 120_001 }),
      LIMITS,
      emptyRiskState()
    );
    assert.equal(stale.decision.halt, true);
    assert.ok(stale.decision.reasons.includes("SNAPSHOT_STALE"));
    assert.ok(stale.decision.reasons.includes("DAILY_PNL_STALE"));
  });

  it("keeps HALTED once set and strips risk-increasing intents", () => {
    const halted = evaluateExperimentRisk(
      input({ dailyPnlUsd: -3 }),
      LIMITS,
      emptyRiskState()
    );
    const again = evaluateExperimentRisk(input({ dailyPnlUsd: 0 }), LIMITS, halted.next);
    assert.equal(again.decision.halt, true);
    assert.equal(again.next.halted, true);

    const intents: Intent[] = [
      { type: "place", order: { market: "BTC", side: "buy", price: 99_000, size: 0.001, level: 1 } },
      { type: "cancel", orderId: "1", market: "BTC" },
    ];
    const filtered = filterRiskIncreasingIntents(intents, again.decision);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.type, "cancel");
  });

  it("requires the unique halt id and consumes it before clearing persisted HALTED", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-ack-"));
    const id = "classic-dryrun-001";
    const halted = {
      ...emptyRiskState(),
      halted: true,
      haltStatus: "HALTED_FLAT" as const,
      haltId: "halt-unique-123",
      haltReasons: ["DAILY_LOSS"],
    };
    persistRiskState(id, halted, dir);
    const still = withEnv({ EXPERIMENT_HALT_ACK: undefined }, () =>
      acknowledgeHaltIfRequested(id, loadRiskState(id, dir), dir)
    );
    assert.equal(still.halted, true);
    const staticYes = withEnv({ EXPERIMENT_HALT_ACK: "YES" }, () =>
      acknowledgeHaltIfRequested(id, loadRiskState(id, dir), dir)
    );
    assert.equal(staticYes.halted, true);
    const cleared = withEnv({ EXPERIMENT_HALT_ACK: "halt-unique-123" }, () =>
      acknowledgeHaltIfRequested(id, loadRiskState(id, dir), dir)
    );
    assert.equal(cleared.halted, false);
    assert.equal(cleared.acknowledged, true);
  });

  it("fails closed on corrupt durable state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-corrupt-"));
    const id = "classic-corrupt-001";
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, "risk-state.json"), "{broken", "utf8");
    const state = loadRiskState(id, dir, "extended:BTC");
    assert.equal(state.halted, true);
    assert.equal(state.haltStatus, "HALT_FAILED");
    assert.ok(state.haltReasons.includes("RISK_STATE_CORRUPT"));
  });

  it("uses a verified backup only as evidence and still halts on primary corruption", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-corrupt-backup-"));
    const id = "classic-corrupt-backup-001";
    persistRiskState(id, emptyRiskState("extended:BTC"), dir);
    persistRiskState(id, { ...emptyRiskState("extended:BTC"), updatedAt: new Date().toISOString() }, dir);
    fs.writeFileSync(path.join(dir, id, "risk-state.json"), "bad", "utf8");
    const state = loadRiskState(id, dir, "extended:BTC");
    assert.equal(state.halted, true);
    assert.equal(state.haltStatus, "HALT_FAILED");
    assert.ok(state.haltReasons.includes("RISK_STATE_PRIMARY_CORRUPT"));
  });

  it("reserves current position, live orders, and proposed orders in worst-case direction", () => {
    const notional = worstCaseGrossNotionalUsd({
      positionQty: 0.0005,
      mid: 100_000,
      openOrders: [
        { id: "b1", market: "BTC", side: "buy", price: 99_000, size: 0.0005, level: 1 },
        { id: "s1", market: "BTC", side: "sell", price: 101_000, size: 0.00025, level: 2 },
      ],
      intents: [
        { type: "cancel", orderId: "b1", market: "BTC" },
        { type: "place", order: { market: "BTC", side: "buy", price: 98_000, size: 0.0005, level: 0 } },
      ],
    });
    assert.equal(notional, 150);
  });
});
