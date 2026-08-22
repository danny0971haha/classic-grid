import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  emptyRiskState,
  evaluateExperimentRisk,
  filterRiskIncreasingIntents,
  initializeRiskStateStore,
  isForcedHaltInMemoryOnly,
  loadRiskState,
  persistRiskState,
  type ExperimentRiskState,
} from "../src/experimentRisk.js";
import {
  ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE,
  boundFlattenQty,
  classifyExposureReducingSide,
  experimentAllowsReseed,
  isOwnedRiskIncreasingOrder,
  reductionClientOrderId,
  runActualNotionalHardHalt,
  verifyFlattenSnapshot,
} from "../src/experimentReduction.js";
import type { Intent } from "../src/types.js";
import {
  LIMITS,
  MARKET,
  OWNER_PREFIX,
  SCOPE,
  freshSnapshot,
  ownedOrder,
  scriptedTransport,
  unownedOrder,
} from "./helpers/reduction.js";

const WORKER = fileURLToPath(new URL("./fixtures/experiment-reduction-restart-worker.ts", import.meta.url));

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `classic-b-${label}-`));
}

function seedRunning(id: string, dir: string, leaseGeneration = "lease-1"): ExperimentRiskState {
  initializeRiskStateStore({
    experimentId: id,
    baseDir: dir,
    scopeKey: SCOPE,
    leaseGeneration,
  });
  persistRiskState(id, { ...emptyRiskState(SCOPE), leaseGeneration }, dir);
  const loaded = loadRiskState(id, dir, SCOPE);
  assert.equal(loaded.haltStatus, "RUNNING");
  return loaded;
}

function riskInput(partial: {
  positionNotionalUsd?: number;
  positionQty?: number;
  plannedGrossNotionalUsd?: number;
} = {}) {
  return {
    mid: 100_000,
    equityUsd: 100,
    dailyPnlUsd: 0,
    positionQty: partial.positionQty ?? 0,
    positionNotionalUsd: partial.positionNotionalUsd ?? 0,
    plannedGrossNotionalUsd: partial.plannedGrossNotionalUsd ?? 150,
    gridLower: 97_000,
    gridUpper: 103_000,
  };
}

async function runHalt(p: {
  id: string;
  dir: string;
  state: ExperimentRiskState;
  positionQty: number;
  openOrders?: ReturnType<typeof ownedOrder>[];
  transport: ReturnType<typeof scriptedTransport>;
  leaseGeneration?: string;
  assertLeaseCurrent?: () => void;
  persistOptions?: Parameters<typeof runActualNotionalHardHalt>[0]["persistOptions"];
}) {
  return runActualNotionalHardHalt({
    experimentId: p.id,
    market: MARKET,
    ownershipPrefix: OWNER_PREFIX,
    positionQty: p.positionQty,
    openOrders: p.openOrders ?? [],
    reasons: ["ACTUAL_NOTIONAL_CAP"],
    transport: p.transport,
    assertLeaseCurrent: p.assertLeaseCurrent ?? (() => undefined),
    leaseGeneration: p.leaseGeneration ?? "lease-1",
    baseDir: p.dir,
    scopeKey: SCOPE,
    persistOptions: p.persistOptions,
    state: p.state,
  });
}

function reloadInFreshProcess(id: string, dir: string): any {
  const result = spawnSync(process.execPath, ["--import", "tsx", WORKER], {
    env: {
      ...process.env,
      CLASSIC_RISK_ID: id,
      CLASSIC_RISK_DIR: dir,
      CLASSIC_RISK_SCOPE: SCOPE,
    },
    encoding: "utf8",
  });
  const line = String(result.stdout || "").trim().split("\n").filter(Boolean).at(-1);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(line, result.stderr);
  return JSON.parse(line);
}

describe("Checkpoint B actual-notional hard halt", () => {
  it("B1: actual notional exactly 150.00U does not breach", () => {
    const { decision, next } = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 150, positionQty: 0.0015, plannedGrossNotionalUsd: 150 }),
      LIMITS,
      emptyRiskState(SCOPE)
    );
    assert.equal(decision.halt, false);
    assert.equal(decision.reduceOnly, false);
    assert.equal(decision.reasons.includes("ACTUAL_NOTIONAL_CAP"), false);
    assert.equal(next.halted, false);
    assert.equal(next.haltStatus, "RUNNING");
  });

  it("B2: actual notional >150.00U hard-halts and mints haltId", () => {
    const { decision, next } = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 150.01, positionQty: 0.0015001 }),
      LIMITS,
      emptyRiskState(SCOPE)
    );
    assert.equal(decision.halt, true);
    assert.equal(decision.reduceOnly, true);
    assert.ok(decision.reasons.includes("ACTUAL_NOTIONAL_CAP"));
    assert.equal(next.halted, true);
    assert.equal(next.haltStatus, "HALTING");
    assert.ok(next.haltId && next.haltId.length > 0);
    assert.equal(next.acknowledged, false);
  });

  it("B3: actual breach invokes active flatten, not cancel-only", async () => {
    const dir = tmpDir("b3");
    const id = "b3-flatten";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 151, positionQty: 0.00151 }),
      LIMITS,
      running
    );
    const intents: Intent[] = [
      { type: "place", order: { market: MARKET, side: "buy", price: 99_000, size: 0.001, level: 1 } },
      { type: "cancel", orderId: "1", market: MARKET },
    ];
    const filtered = filterRiskIncreasingIntents(intents, evaluated.decision);
    assert.deepEqual(filtered.map((row) => row.type), ["cancel"]);

    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0, openOrders: [] }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.00151,
      openOrders: [ownedOrder({ side: "buy" })],
      transport,
    });
    assert.ok(transport.flattenCalls >= 1, "active flatten must be invoked");
    assert.notEqual(result.lifecycle, "NORMAL");
    assert.equal(result.reseedAllowed, false);
    assert.notEqual(result.state.haltStatus, "RUNNING");
  });

  it("B4: long position selects only exposure-reducing direction", async () => {
    assert.equal(classifyExposureReducingSide(0.002), "sell");
    const dir = tmpDir("b4");
    const id = "b4-long";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 200, positionQty: 0.002 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0 }),
    });
    await runHalt({ id, dir, state: evaluated.next, positionQty: 0.002, transport });
    assert.equal(transport.flattenRequests[0]?.side, "sell");
    assert.ok((transport.flattenRequests[0]?.qty ?? 1) <= 0.002 + 1e-15);
  });

  it("B5: short position selects only exposure-reducing direction", async () => {
    assert.equal(classifyExposureReducingSide(-0.002), "buy");
    const dir = tmpDir("b5");
    const id = "b5-short";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 200, positionQty: -0.002 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0 }),
    });
    await runHalt({ id, dir, state: evaluated.next, positionQty: -0.002, transport });
    assert.equal(transport.flattenRequests[0]?.side, "buy");
    assert.ok((transport.flattenRequests[0]?.qty ?? 1) <= 0.002 + 1e-15);
  });

  it("B6: reduction rounding cannot increase absolute exposure", () => {
    assert.ok(ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE > 0);
    assert.ok(ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE <= 1e-6);
    assert.equal(boundFlattenQty(0.00123, 0.00123, 0.001), 0.001);
    assert.equal(boundFlattenQty(0.001, 0.002, 0.001), 0.001);
    assert.equal(boundFlattenQty(0.001, 0.0015, 0.001), 0.001);
    assert.equal(boundFlattenQty(-0.0024, 0.003, 0.001), 0.002);
    assert.equal(boundFlattenQty(0.001, 0, 0.001), 0);
    const rounded = boundFlattenQty(0.00123, 0.00123, 0.001);
    assert.ok(rounded <= Math.abs(0.00123));
  });

  it("B7: incident haltId is preserved through HALTING -> HALTED_UNFLAT/HALTED_FLAT", async () => {
    const dir = tmpDir("b7");
    const id = "b7-id";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const incident = evaluated.next.haltId;
    assert.ok(incident);

    const unflatTransport = scriptedTransport({
      cancel: "ACK",
      flatten: "REJECTED",
      snapshots: [freshSnapshot({ positionQty: 0.0018 })],
    });
    const unflat = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport: unflatTransport,
    });
    assert.equal(unflat.haltId, incident);
    assert.equal(unflat.state.haltId, incident);
    assert.equal(loadRiskState(id, dir, SCOPE).haltId, incident);
    assert.ok(["HALTED_UNFLAT", "HALT_FAILED"].includes(unflat.state.haltStatus));

    const flatTransport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0 }),
    });
    const flat = await runHalt({
      id,
      dir,
      state: unflat.state,
      positionQty: 0.0018,
      transport: flatTransport,
    });
    assert.equal(flat.haltId, incident);
    assert.equal(loadRiskState(id, dir, SCOPE).haltId, incident);
    assert.equal(flat.state.haltStatus, "HALTED_FLAT");
  });

  it("B8: cancellation failure remains halted", async () => {
    const dir = tmpDir("b8");
    const id = "b8-cancel-fail";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "REJECTED",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0 }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      openOrders: [ownedOrder({ side: "buy" })],
      transport,
    });
    assert.equal(result.state.halted, true);
    assert.notEqual(result.state.haltStatus, "RUNNING");
    assert.equal(experimentAllowsReseed(result.state), false);
    assert.equal(loadRiskState(id, dir, SCOPE).halted, true);
  });

  it("B9: cancellation UNKNOWN requires reconciliation and remains halted", async () => {
    const dir = tmpDir("b9");
    const id = "b9-cancel-unknown";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "UNKNOWN",
      flatten: "ACK",
      snapshots: () => freshSnapshot({
        positionQty: 0.0018,
        openOrders: [ownedOrder({ side: "buy" })],
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      openOrders: [ownedOrder({ side: "buy" })],
      transport,
    });
    assert.ok(transport.snapshotCalls >= 1, "UNKNOWN cancel must reconcile via snapshot");
    assert.equal(result.state.halted, true);
    assert.notEqual(result.state.haltStatus, "RUNNING");
    assert.notEqual(result.cancel?.outcome, "ACK");
  });

  it("B10: flatten REJECTED remains halted", async () => {
    const dir = tmpDir("b10");
    const id = "b10-flat-rej";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "REJECTED",
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(result.flatten?.outcome, "REJECTED");
    assert.equal(result.verifiedFlat, false);
    assert.equal(result.state.halted, true);
    assert.ok(["HALTED_UNFLAT", "HALT_FAILED"].includes(result.state.haltStatus));
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.notEqual(result.state.haltStatus, "RUNNING");
  });

  it("B11: flatten UNKNOWN remains halted and is not blindly retried with unrelated identity", async () => {
    const dir = tmpDir("b11");
    const id = "b11-unknown";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const incident = evaluated.next.haltId as string;
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "UNKNOWN",
      snapshots: () => freshSnapshot({ positionQty: 0.0018 }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(result.flatten?.outcome, "UNKNOWN");
    assert.equal(result.verifiedFlat, false);
    assert.equal(result.state.halted, true);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.deepEqual(
      [...new Set(transport.flattenClientOrderIds)],
      [reductionClientOrderId(incident)]
    );
    assert.ok(
      transport.flattenCalls === 1
      || transport.flattenClientOrderIds.every((row) => row === reductionClientOrderId(incident)),
      "UNKNOWN must not mint an unrelated second mutation identity"
    );
  });

  it("B12: flatten ACK without fresh snapshot is not verified", async () => {
    const dir = tmpDir("b12");
    const id = "b12-no-snap";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshotError: new Error("SNAPSHOT_WITHHELD"),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(result.flatten?.outcome, "ACK");
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.equal(result.state.halted, true);
  });

  it("B13: fresh snapshot still non-flat -> retry boundedly or HALTED_UNFLAT", async () => {
    const dir = tmpDir("b13");
    const id = "b13-retry";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      snapshots: (attempt) => freshSnapshot({
        positionQty: 0.0018,
        observationId: `after-${attempt}`,
        sourceGeneration: `g-after-${attempt}`,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(result.verifiedFlat, false);
    assert.ok(["HALTED_UNFLAT", "HALT_FAILED"].includes(result.state.haltStatus));
    assert.equal(result.state.halted, true);
    assert.ok(transport.flattenCalls >= 1);
    assert.ok(transport.flattenCalls <= 3, "retry must be bounded");
    const identities = new Set(transport.flattenClientOrderIds);
    assert.equal(identities.size, 1);
    assert.equal([...identities][0], reductionClientOrderId(evaluated.next.haltId as string));
  });

  it("B14: stale/pre-write snapshot cannot produce HALTED_FLAT", async () => {
    const preWrite = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        freshness: "pre_write",
        positionQty: 0,
        observedAt: "2026-08-23T00:00:01.000Z",
        capturedAtMs: Date.parse("2026-08-23T00:00:01.000Z"),
      }),
      mutationAttemptAtMs: Date.parse("2026-08-23T00:00:05.000Z"),
      ownershipPrefix: OWNER_PREFIX,
      nowMs: Date.parse("2026-08-23T00:00:10.000Z"),
    });
    assert.equal(preWrite.ok, false);

    const stale = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        freshness: "cached",
        positionQty: 0,
        observedAt: "2026-08-23T00:00:01.000Z",
      }),
      mutationAttemptAtMs: Date.parse("2026-08-23T00:00:05.000Z"),
      ownershipPrefix: OWNER_PREFIX,
      nowMs: Date.parse("2026-08-23T00:00:10.000Z"),
    });
    assert.equal(stale.ok, false);

    const oldObserved = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        freshness: "fresh",
        positionQty: 0,
        observedAt: "2026-08-23T00:00:01.000Z",
        sourceGeneration: "old",
      }),
      mutationAttemptAtMs: Date.parse("2026-08-23T00:00:05.000Z"),
      ownershipPrefix: OWNER_PREFIX,
      nowMs: Date.parse("2026-08-23T00:00:10.000Z"),
    });
    assert.equal(oldObserved.ok, false);

    const dir = tmpDir("b14");
    const id = "b14-stale";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: [freshSnapshot({
        freshness: "pre_write",
        positionQty: 0,
        observedAt: "2026-08-23T00:00:01.000Z",
        sourceGeneration: "pre-write",
      })],
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(result.state.haltStatus === "HALTED_FLAT", false);
    assert.equal(result.verifiedFlat, false);
  });

  it("B15: flat snapshot with remaining owned risk-increasing order cannot produce HALTED_FLAT", async () => {
    const leftover = ownedOrder({ side: "buy" });
    assert.equal(isOwnedRiskIncreasingOrder(leftover, OWNER_PREFIX, 0), true);
    const verified = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        positionQty: 0,
        openOrders: [leftover],
        observedAt: "2026-08-23T00:00:20.000Z",
      }),
      mutationAttemptAtMs: Date.parse("2026-08-23T00:00:10.000Z"),
      ownershipPrefix: OWNER_PREFIX,
      nowMs: Date.parse("2026-08-23T00:00:20.000Z"),
    });
    assert.equal(verified.ok, false);

    const dir = tmpDir("b15");
    const id = "b15-owned-ri";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({
        positionQty: 0,
        openOrders: [leftover],
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      openOrders: [leftover],
      transport,
    });
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("B16: verified flat + no owned risk-increasing orders -> HALTED_FLAT, never RUNNING", async () => {
    const dir = tmpDir("b16");
    const id = "b16-flat";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({
        positionQty: 0,
        openOrders: [unownedOrder()],
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      openOrders: [ownedOrder({ side: "buy" }), unownedOrder()],
      transport,
    });
    assert.deepEqual(transport.cancelledOrders[0]?.map((row) => row.id), ["ex-buy-1"]);
    assert.equal(result.verifiedFlat, true);
    assert.equal(result.state.haltStatus, "HALTED_FLAT");
    assert.equal(result.state.halted, true);
    assert.equal(result.reseedAllowed, false);
    assert.notEqual(result.lifecycle, "NORMAL");
    const durable = loadRiskState(id, dir, SCOPE);
    assert.equal(durable.haltStatus, "HALTED_FLAT");
    assert.equal(durable.halted, true);
    assert.equal(durable.acknowledged, false);
  });

  it("B17: lease loss before cancel -> NOT_SENT / no transport", async () => {
    const dir = tmpDir("b17");
    const id = "b17-lease-cancel";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0 }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      openOrders: [ownedOrder({ side: "buy" })],
      transport,
      assertLeaseCurrent() {
        throw new Error("RUNTIME_LEASE_LOST");
      },
    });
    assert.equal(transport.cancelCalls, 0);
    assert.equal(transport.flattenCalls, 0);
    assert.equal(result.cancel?.outcome, "NOT_SENT");
    assert.equal(result.state.halted, true);
    assert.notEqual(result.state.haltStatus, "RUNNING");
  });

  it("B18: lease loss between cancel and flatten -> no flatten transport, remain halted", async () => {
    const dir = tmpDir("b18");
    const id = "b18-lease-flatten";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const lease = { lost: false };
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0.0018 }),
      onCancel() {
        lease.lost = true;
      },
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      openOrders: [ownedOrder({ side: "buy" })],
      transport,
      assertLeaseCurrent() {
        if (lease.lost) throw new Error("RUNTIME_LEASE_LOST");
      },
    });
    assert.equal(transport.cancelCalls, 1);
    assert.equal(transport.flattenCalls, 0);
    assert.equal(result.flatten?.outcome, "NOT_SENT");
    assert.equal(result.state.halted, true);
    assert.notEqual(result.state.haltStatus, "RUNNING");
  });

  it("B19: persistence failure still permits only fenced emergency reduction", async () => {
    const dir = tmpDir("b19");
    const id = "b19-persist";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const primary = path.join(dir, id, "risk-state.json");
    let writes = 0;
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0 }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
      persistOptions: {
        onAtomicWriteStep(step, target) {
          if (target === primary && step === "BEFORE_RENAME") {
            writes += 1;
            if (writes === 1) throw new Error("HALTING persist failed");
          }
        },
      },
    });
    assert.ok(transport.flattenCalls >= 1, "emergency flatten must still run");
    assert.equal(result.state.halted, true);
    assert.equal(experimentAllowsReseed(result.state), false);
    assert.ok(
      isForcedHaltInMemoryOnly(id)
      || result.state.haltReasons.includes("FORCED_HALT_IN_MEMORY_ONLY")
      || result.errors.some((row) => /persist|HALTING/i.test(row))
    );
    assert.notEqual(loadRiskState(id, dir, SCOPE).haltStatus, "RUNNING");
  });

  it("B20: restart at every lifecycle stage cannot reseed", async () => {
    const stages: Array<{ label: string; patch: Partial<ExperimentRiskState> }> = [
      { label: "HALTING", patch: { haltStatus: "HALTING", haltReasons: ["ACTUAL_NOTIONAL_CAP"] } },
      { label: "HALTED_UNFLAT", patch: { haltStatus: "HALTED_UNFLAT", haltReasons: ["ACTUAL_NOTIONAL_CAP"] } },
      { label: "HALTED_FLAT", patch: { haltStatus: "HALTED_FLAT", haltReasons: ["ACTUAL_NOTIONAL_CAP"] } },
      { label: "HALT_FAILED", patch: { haltStatus: "HALT_FAILED", haltReasons: ["ACTUAL_NOTIONAL_CAP"] } },
    ];
    for (const stage of stages) {
      const dir = tmpDir(`b20-${stage.label.toLowerCase()}`);
      const id = `b20-${stage.label.toLowerCase()}`;
      seedRunning(id, dir);
      persistRiskState(id, {
        ...emptyRiskState(SCOPE),
        halted: true,
        haltStatus: stage.patch.haltStatus as ExperimentRiskState["haltStatus"],
        haltId: `halt-${stage.label}`,
        haltReasons: stage.patch.haltReasons as string[],
        leaseGeneration: "lease-1",
        acknowledged: false,
        updatedAt: "2026-08-23T00:00:00.000Z",
      }, dir);
      const child = reloadInFreshProcess(id, dir);
      assert.equal(child.durableHalted, true, stage.label);
      assert.equal(child.decisionHalt, true, stage.label);
      assert.equal(child.reseedAllowedFromDurable, false, stage.label);
      assert.equal(child.reseedAllowedFromEvaluated, false, stage.label);
      assert.notEqual(child.nextHaltStatus, "RUNNING", stage.label);
    }
  });

  it("B21: successful flatten never auto-clears the halt", async () => {
    const dir = tmpDir("b21");
    const id = "b21-no-clear";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0 }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(result.state.haltStatus, "HALTED_FLAT");
    const later = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 0, positionQty: 0, plannedGrossNotionalUsd: 100 }),
      LIMITS,
      result.state
    );
    assert.equal(later.decision.halt, true);
    assert.equal(later.next.halted, true);
    assert.equal(later.next.haltId, result.haltId);
    assert.equal(later.next.haltStatus, "HALTED_FLAT");
    assert.ok(later.decision.reasons.includes("ACTUAL_NOTIONAL_CAP"));
    assert.equal(experimentAllowsReseed(later.next), false);
  });

  it("B22: stale owner cannot mutate after fencing generation turnover", async () => {
    const dir = tmpDir("b22");
    const id = "b22-stale";
    seedRunning(id, dir, "lease-1");
    persistRiskState(id, { ...emptyRiskState(SCOPE), leaseGeneration: "lease-2" }, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      { ...emptyRiskState(SCOPE), leaseGeneration: "lease-1" }
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0 }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      openOrders: [ownedOrder({ side: "buy" })],
      transport,
      leaseGeneration: "lease-1",
      assertLeaseCurrent() {
        throw new Error("RUNTIME_LEASE_GENERATION_MISMATCH");
      },
    });
    assert.equal(transport.cancelCalls, 0);
    assert.equal(transport.flattenCalls, 0);
    assert.equal(result.cancel?.outcome, "NOT_SENT");
    assert.equal(result.state.halted, true);
    assert.notEqual(loadRiskState(id, dir, SCOPE).haltStatus, "RUNNING");
  });
});
