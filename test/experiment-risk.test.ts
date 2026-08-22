import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acknowledgeHaltIfRequested,
  emptyRiskState,
  evaluateExperimentRisk,
  filterRiskIncreasingIntents,
  initializeRiskStateStore,
  persistRiskState,
  loadRiskState,
  riskStatePath,
  type ExperimentRiskLimits,
  type RiskMarketInput,
  worstCaseGrossNotionalUsd,
} from "../src/experimentRisk.js";
import { createChecksummedEnvelopeV2, serializeChecksummedEnvelopeV2 } from "../src/experimentStorage.js";
import { withEnv } from "./helpers/env.js";
import { liveLease } from "./helpers/gate0Corrective.js";
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
      acknowledgeHaltIfRequested(id, loadRiskState(id, dir), dir, {
        activeLease: liveLease("lease-1", "UNSCOPED"),
      })
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

  it("ordinary missing-state load fails closed and explicit initialization starts halted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-missing-state-"));
    const missing = loadRiskState("missing-001", dir, "extended:BTC");
    assert.equal(missing.halted, true);
    assert.equal(missing.haltStatus, "HALT_FAILED");
    assert.ok(missing.haltReasons.includes("RISK_STATE_MISSING"));

    const initialized = initializeRiskStateStore({
      experimentId: "initialized-001",
      baseDir: dir,
      scopeKey: "extended:BTC",
      leaseGeneration: "lease-1",
    });
    assert.equal(initialized.halted, true);
    assert.ok(initialized.haltReasons.includes("INITIAL_RECONCILIATION_REQUIRED"));
    assert.equal(loadRiskState("initialized-001", dir, "extended:BTC").halted, true);
  });

  it("forces HALT when primary is missing even if backup contains RUNNING", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-primary-missing-"));
    const id = "primary-missing-001";
    const scope = "extended:BTC";
    initializeRiskStateStore({ experimentId: id, baseDir: dir, scopeKey: scope });
    persistRiskState(id, emptyRiskState(scope), dir);
    persistRiskState(id, { ...emptyRiskState(scope), updatedAt: "2026-08-16T00:00:01.000Z" }, dir);
    fs.unlinkSync(riskStatePath(id, dir));
    const state = loadRiskState(id, dir, scope);
    assert.equal(state.halted, true);
    assert.equal(state.haltStatus, "HALT_FAILED");
    assert.ok(state.haltReasons.includes("RISK_STATE_PRIMARY_MISSING"));
  });

  it("preserves backup halt evidence when primary is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-primary-missing-halted-"));
    const id = "primary-missing-halted-001";
    const halted = {
      ...emptyRiskState("extended:BTC"),
      halted: true,
      haltStatus: "HALTED_UNFLAT" as const,
      haltId: "halt-backup",
      haltReasons: ["DAILY_LOSS"],
    };
    persistRiskState(id, halted, dir);
    fs.unlinkSync(riskStatePath(id, dir));
    const state = loadRiskState(id, dir, "extended:BTC");
    assert.equal(state.halted, true);
    assert.ok(state.haltReasons.includes("DAILY_LOSS"));
    assert.ok(state.haltReasons.includes("RISK_STATE_PRIMARY_MISSING"));
  });

  it("rejects every truncated primary while retaining a verified backup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-primary-truncate-"));
    const id = "primary-truncate-001";
    const primary = riskStatePath(id, dir);
    persistRiskState(id, emptyRiskState("extended:BTC"), dir);
    const raw = fs.readFileSync(primary, "utf8");
    for (let offset = 0; offset < raw.trimEnd().length; offset++) {
      fs.writeFileSync(primary, raw.slice(0, offset), "utf8");
      const state = loadRiskState(id, dir, "extended:BTC");
      assert.equal(state.halted, true, `offset ${offset}`);
      assert.ok(state.haltReasons.includes("RISK_STATE_PRIMARY_CORRUPT"), `offset ${offset}`);
    }
  });

  it("repairs a missing or corrupt backup only from a verified primary", () => {
    for (const mode of ["missing", "corrupt"] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `classic-backup-${mode}-`));
      const id = `backup-${mode}-001`;
      const primary = riskStatePath(id, dir);
      const backup = `${primary}.bak`;
      initializeRiskStateStore({ experimentId: id, baseDir: dir, scopeKey: "extended:BTC" });
      persistRiskState(id, emptyRiskState("extended:BTC"), dir);
      const primaryRaw = fs.readFileSync(primary, "utf8");
      if (mode === "missing") fs.unlinkSync(backup);
      else fs.writeFileSync(backup, "corrupt", "utf8");
      const loaded = loadRiskState(id, dir, "extended:BTC");
      assert.equal(loaded.halted, false);
      assert.equal(fs.readFileSync(backup, "utf8"), primaryRaw);
    }
  });

  it("fails closed when backup repair cannot be durably completed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-backup-repair-fail-"));
    const id = "backup-repair-fail-001";
    const primary = riskStatePath(id, dir);
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    persistRiskState(id, emptyRiskState("extended:BTC"), dir);
    fs.writeFileSync(`${primary}.bak`, "corrupt", "utf8");
    const state = loadRiskState(id, dir, "extended:BTC", {
      onAtomicWriteStep(step, target) {
        if (target.endsWith(".bak") && step === "BEFORE_DIRECTORY_FSYNC") throw new Error("directory fsync failed");
      },
    });
    assert.equal(state.halted, true);
    assert.ok(state.haltReasons.includes("RISK_STATE_BACKUP_REPAIR_FAILED"));
  });

  it("halts on backup-newer and same-generation hash conflicts", () => {
    const scope = "extended:BTC";
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-backup-newer-"));
      const id = "backup-newer-001";
      const primary = riskStatePath(id, dir);
      persistRiskState(id, emptyRiskState(scope), dir);
      persistRiskState(id, { ...emptyRiskState(scope), updatedAt: "2026-08-16T01:00:00.000Z" }, dir);
      const newer = fs.readFileSync(primary, "utf8");
      const older = fs.readFileSync(`${primary}.bak`, "utf8");
      fs.writeFileSync(primary, older, "utf8");
      fs.writeFileSync(`${primary}.bak`, newer, "utf8");
      const state = loadRiskState(id, dir, scope);
      assert.equal(state.halted, true);
      assert.ok(state.haltReasons.includes("RISK_STATE_BACKUP_NEWER"));
    }
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-same-generation-"));
      const id = "same-generation-001";
      const primary = riskStatePath(id, dir);
      persistRiskState(id, emptyRiskState(scope), dir);
      const current = JSON.parse(fs.readFileSync(primary, "utf8"));
      const changedState = { ...emptyRiskState(scope), updatedAt: "2026-08-16T02:00:00.000Z" };
      const conflicting = createChecksummedEnvelopeV2({
        kind: current.kind,
        experimentId: id,
        scopeKey: scope,
        storeGeneration: current.storeGeneration,
        leaseGeneration: null,
        createdAt: current.createdAt,
        writtenAt: current.writtenAt,
        previousEnvelopeSha256: current.previousEnvelopeSha256,
        payload: changedState,
      });
      fs.writeFileSync(`${primary}.bak`, serializeChecksummedEnvelopeV2(conflicting), "utf8");
      const state = loadRiskState(id, dir, scope);
      assert.equal(state.halted, true);
      assert.ok(state.haltReasons.includes("RISK_STATE_GENERATION_HASH_CONFLICT"));
    }
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-generation-gap-"));
      const id = "generation-gap-001";
      const primary = riskStatePath(id, dir);
      persistRiskState(id, emptyRiskState(scope), dir);
      const generationOne = fs.readFileSync(primary, "utf8");
      persistRiskState(id, { ...emptyRiskState(scope), updatedAt: "2026-08-16T03:00:00.000Z" }, dir);
      persistRiskState(id, { ...emptyRiskState(scope), updatedAt: "2026-08-16T04:00:00.000Z" }, dir);
      fs.writeFileSync(`${primary}.bak`, generationOne, "utf8");
      const state = loadRiskState(id, dir, scope);
      assert.equal(state.halted, true);
      assert.ok(state.haltReasons.includes("RISK_STATE_GENERATION_GAP"));
    }
  });

  it("rejects a hash-valid envelope whose payload identity disagrees with metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-payload-identity-"));
    const id = "payload-identity-001";
    const primary = riskStatePath(id, dir);
    persistRiskState(id, emptyRiskState("extended:BTC"), dir);
    const current = JSON.parse(fs.readFileSync(primary, "utf8"));
    const mismatch = createChecksummedEnvelopeV2({
      kind: current.kind,
      experimentId: id,
      scopeKey: "extended:BTC",
      storeGeneration: current.storeGeneration,
      leaseGeneration: null,
      createdAt: current.createdAt,
      writtenAt: current.writtenAt,
      previousEnvelopeSha256: current.previousEnvelopeSha256,
      payload: emptyRiskState("extended:ETH"),
    });
    fs.writeFileSync(primary, serializeChecksummedEnvelopeV2(mismatch), "utf8");
    const state = loadRiskState(id, dir, "extended:BTC");
    assert.equal(state.halted, true);
    assert.ok(state.haltReasons.includes("RISK_STATE_PRIMARY_CORRUPT"));
  });

  it("fails closed on scope mismatch and unsupported V2 schema", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-v2-invalid-"));
    const id = "v2-invalid-001";
    const primary = riskStatePath(id, dir);
    persistRiskState(id, emptyRiskState("extended:BTC"), dir);
    const wrongScope = loadRiskState(id, dir, "extended:ETH");
    assert.equal(wrongScope.halted, true);
    assert.ok(wrongScope.haltReasons.includes("RISK_STATE_PRIMARY_SCOPE_MISMATCH"));

    for (const file of [primary, `${primary}.bak`]) {
      const row = JSON.parse(fs.readFileSync(file, "utf8"));
      row.schemaVersion = 999;
      fs.writeFileSync(file, JSON.stringify(row), "utf8");
    }
    const unsupported = loadRiskState(id, dir, "extended:BTC");
    assert.equal(unsupported.halted, true);
    assert.ok(unsupported.haltReasons.includes("RISK_STATE_PRIMARY_UNSUPPORTED_VERSION"));
  });

  it("migrates legacy halted:false bytes only into a halted V2 pair", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-legacy-running-"));
    const id = "legacy-running-001";
    const primary = riskStatePath(id, dir);
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(primary, JSON.stringify(emptyRiskState("extended:BTC")), "utf8");
    const state = loadRiskState(id, dir, "extended:BTC");
    assert.equal(state.halted, true);
    assert.ok(state.haltReasons.includes("RISK_STATE_LEGACY_MIGRATED"));
    assert.equal(JSON.parse(fs.readFileSync(primary, "utf8")).schemaVersion, 2);
    assert.equal(JSON.parse(fs.readFileSync(`${primary}.bak`, "utf8")).schemaVersion, 2);
  });

  it("never overwrites a valid backup when invalid-primary recovery write fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-preserve-backup-"));
    const id = "preserve-backup-001";
    const primary = riskStatePath(id, dir);
    persistRiskState(id, emptyRiskState("extended:BTC"), dir);
    const backupBefore = fs.readFileSync(`${primary}.bak`, "utf8");
    fs.writeFileSync(primary, "corrupt", "utf8");
    const halted = loadRiskState(id, dir, "extended:BTC");
    assert.throws(() => persistRiskState(id, halted, dir, {
      onAtomicWriteStep(step, target) {
        if (target === primary && step === "BEFORE_RENAME") throw new Error("primary commit failed");
      },
    }), /primary commit failed/);
    assert.equal(fs.readFileSync(`${primary}.bak`, "utf8"), backupBefore);
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
