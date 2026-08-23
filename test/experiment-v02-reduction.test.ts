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
  persistAuthoritativeRiskState,
  persistRiskState,
  type ExperimentRiskState,
} from "../src/experimentRisk.js";
import {
  ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE,
  MAX_CLOCK_SKEW_MS,
  boundFlattenQty,
  classifyExposureReducingSide,
  classifyTransportError,
  createVenueReductionTransport,
  experimentAllowsReseed,
  isOwnedRiskIncreasingOrder,
  isUnsafeOwnedOpenOrder,
  isVenueProvenReduceOnly,
  normalizeReductionResult,
  reductionClientOrderId,
  runActualNotionalHardHalt,
  verifyFlattenSnapshot,
} from "../src/experimentReduction.js";
import type { Intent } from "../src/types.js";
import { ExtendedExecutor } from "../src/venues/extended.js";
import {
  LIMITS,
  MARKET,
  OWNER_PREFIX,
  SCOPE,
  freshSnapshot,
  inspectDurablePair,
  inspectDurablePairInFreshProcess,
  ownedOrder,
  ackFlatten,
  attachExtendedExchangeForTests,
  createOfflineExtendedVendor,
  localTransportNotSent,
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
  onDurableAuthorityInspected?: Parameters<typeof runActualNotionalHardHalt>[0]["onDurableAuthorityInspected"];
  nowMs?: () => number;
  maxFlattenAttempts?: number;
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
    onDurableAuthorityInspected: p.onDurableAuthorityInspected,
    nowMs: p.nowMs,
    maxFlattenAttempts: p.maxFlattenAttempts,
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
      snapshots: (n) => freshSnapshot({
        positionQty: n === 1 ? 0.00151 : 0,
        openOrders: [],
        observationId: `b3-${n}`,
        sourceGeneration: `g-b3-${n}`,
      }),
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
    const incident = evaluated.next.haltId as string;
    assert.equal(transport.flattenClientOrderIds[0], reductionClientOrderId(incident, 1));
    if (transport.flattenCalls >= 2) {
      assert.equal(transport.flattenClientOrderIds[1], reductionClientOrderId(incident, 2));
      assert.notEqual(transport.flattenClientOrderIds[0], transport.flattenClientOrderIds[1]);
    }
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
      snapshots: (n) => freshSnapshot({
        positionQty: n === 1 ? 0.0018 : 0,
        openOrders: [unownedOrder()],
        observationId: `b16-${n}`,
        sourceGeneration: `g-b16-${n}`,
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
    const before = inspectDurablePairInFreshProcess(id, dir);
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
    const after = inspectDurablePairInFreshProcess(id, dir);
    assert.deepEqual(after, before);
    assert.equal(after.haltStatus, "RUNNING");
    assert.equal(after.leaseGeneration, "lease-2");
  });

  it("BC1 stale lease before HALTING -> durable primary/backup bytes and generation remain unchanged", async () => {
    const dir = tmpDir("bc1");
    const id = "bc1-stale-lease";
    const running = seedRunning(id, dir, "lease-2");
    const before = inspectDurablePairInFreshProcess(id, dir);
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
      leaseGeneration: "lease-1",
      assertLeaseCurrent() {
        throw new Error("RUNTIME_LEASE_GENERATION_MISMATCH");
      },
    });
    const after = inspectDurablePairInFreshProcess(id, dir);
    assert.deepEqual(after, before);
    assert.equal(after.primarySha256, before.primarySha256);
    assert.equal(after.backupSha256, before.backupSha256);
    assert.equal(after.storeGeneration, before.storeGeneration);
    assert.equal(after.envelopeSha256, before.envelopeSha256);
    assert.equal(transport.cancelCalls, 0);
    assert.equal(transport.flattenCalls, 0);
    assert.equal(result.state.halted, true);
    assert.equal(loadRiskState(id, dir, SCOPE).haltStatus, "RUNNING");
  });

  it("BC2 stale caller haltId cannot overwrite a newer durable halt incident", async () => {
    const dir = tmpDir("bc2");
    const id = "bc2-haltid";
    seedRunning(id, dir);
    persistRiskState(id, {
      ...emptyRiskState(SCOPE),
      halted: true,
      haltStatus: "HALTED_UNFLAT",
      haltId: "durable-newer-halt",
      haltReasons: ["ACTUAL_NOTIONAL_CAP"],
      leaseGeneration: "lease-2",
      acknowledged: false,
      updatedAt: "2026-08-23T00:00:00.000Z",
    }, dir);
    const before = inspectDurablePairInFreshProcess(id, dir);
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "REJECTED",
    });
    const result = await runHalt({
      id,
      dir,
      state: {
        ...emptyRiskState(SCOPE),
        halted: true,
        haltStatus: "HALTING",
        haltId: "stale-caller-halt",
        haltReasons: ["ACTUAL_NOTIONAL_CAP"],
        leaseGeneration: "lease-1",
        acknowledged: false,
        updatedAt: "2026-08-23T00:00:00.000Z",
      },
      positionQty: 0.0018,
      transport,
      leaseGeneration: "lease-2",
    });
    const after = inspectDurablePairInFreshProcess(id, dir);
    assert.equal(result.haltId, "durable-newer-halt");
    assert.equal(result.state.haltId, "durable-newer-halt");
    assert.notEqual(result.state.haltId, "stale-caller-halt");
    assert.equal(after.haltId, "durable-newer-halt");
    assert.notEqual(after.haltId, "stale-caller-halt");
    if (after.storeGeneration === before.storeGeneration) {
      assert.equal(after.envelopeSha256, before.envelopeSha256);
      assert.equal(after.primarySha256, before.primarySha256);
    }
    assert.equal(after.haltId, before.haltId);
  });

  it("BC3 accepted HALTING/final writes are bound to the current active lease generation", async () => {
    const dir = tmpDir("bc3");
    const id = "bc3-active-lease";
    seedRunning(id, dir, "lease-1");
    persistRiskState(id, { ...emptyRiskState(SCOPE), leaseGeneration: "lease-1" }, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      { ...emptyRiskState(SCOPE), leaseGeneration: "lease-1" }
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0, leaseGeneration: "lease-2" }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
      leaseGeneration: "lease-2",
    });
    assert.equal(result.state.haltStatus, "HALTED_FLAT");
    const durable = inspectDurablePairInFreshProcess(id, dir);
    assert.equal(durable.haltStatus, "HALTED_FLAT");
    assert.equal(durable.leaseGeneration, "lease-2");
    assert.equal(loadRiskState(id, dir, SCOPE).leaseGeneration, "lease-2");
  });

  it("BC4 predecessor generation/hash changes before commit -> no stale mutation", async () => {
    const dir = tmpDir("bc4");
    const id = "bc4-pred";
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
      state: { ...evaluated.next, haltId: "stale-owner-halt" },
      positionQty: 0.0018,
      transport,
      onDurableAuthorityInspected() {
        persistRiskState(id, {
          ...emptyRiskState(SCOPE),
          halted: true,
          haltStatus: "HALTED_UNFLAT",
          haltId: "newer-intervening-halt",
          haltReasons: ["ACTUAL_NOTIONAL_CAP"],
          leaseGeneration: "lease-1",
          acknowledged: false,
          updatedAt: "2026-08-23T00:00:01.000Z",
        }, dir);
      },
    });
    const after = inspectDurablePairInFreshProcess(id, dir);
    assert.equal(after.haltId, "newer-intervening-halt");
    assert.notEqual(after.haltId, "stale-owner-halt");
    assert.equal(after.haltStatus, "HALTED_UNFLAT");
    assert.notEqual(after.haltStatus, "HALTED_FLAT");
    assert.equal(transport.flattenCalls, 0);
    assert.equal(result.state.halted, true);
  });

  it("BC5 lease lost after flatten ACK but before snapshot -> never HALTED_FLAT", async () => {
    const dir = tmpDir("bc5");
    const id = "bc5-lease-snap";
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
      snapshots: () => freshSnapshot({ positionQty: 0 }),
      onFlatten() {
        lease.lost = true;
      },
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
      assertLeaseCurrent() {
        if (lease.lost) throw new Error("RUNTIME_LEASE_LOST");
      },
    });
    assert.equal(transport.flattenCalls, 1);
    assert.equal(transport.snapshotCalls, 0);
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.notEqual(loadRiskState(id, dir, SCOPE).haltStatus, "HALTED_FLAT");
  });

  it("BC6 lease lost after snapshot response but before final persist -> no stale final mutation", async () => {
    const dir = tmpDir("bc6");
    const id = "bc6-lease-final";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const lease = { phase: "open" as "open" | "after-snap" };
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => {
        const snap = freshSnapshot({ positionQty: 0 });
        lease.phase = "after-snap";
        return snap;
      },
    });
    const before = inspectDurablePair(id, dir);
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
      persistOptions: {
        onAtomicWriteStep(step, target) {
          if (lease.phase === "after-snap" && path.basename(target) === "risk-state.json" && step === "BEFORE_RENAME") {
            throw new Error("RUNTIME_LEASE_LOST");
          }
        },
      },
      assertLeaseCurrent() {
        if (lease.phase === "after-snap") throw new Error("RUNTIME_LEASE_LOST");
      },
    });
    const after = inspectDurablePairInFreshProcess(id, dir);
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(after.haltStatus, "HALTED_FLAT");
    assert.notEqual(loadRiskState(id, dir, SCOPE).haltStatus, "HALTED_FLAT");
    assert.notEqual(after.envelopeSha256, before.envelopeSha256, "HALTING write may commit while lease is current");
    assert.equal(after.haltStatus, "HALTING");
    assert.equal(after.haltId, evaluated.next.haltId);
  });

  it("BC7 missing snapshot lease generation/provenance -> verification rejected", () => {
    const missingLease = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        positionQty: 0,
        leaseGeneration: undefined,
        observedAt: "2026-08-23T00:00:20.000Z",
      }),
      mutationAttemptAtMs: Date.parse("2026-08-23T00:00:10.000Z"),
      ownershipPrefix: OWNER_PREFIX,
      nowMs: Date.parse("2026-08-23T00:00:20.000Z"),
      expectedLeaseGeneration: "lease-1",
    });
    assert.equal(missingLease.ok, false);
    if (missingLease.ok) assert.fail("missing snapshot lease generation must be rejected");
    else assert.equal(missingLease.reasonCode, "SNAPSHOT_FENCE_MISMATCH");

    const missingProvenance = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        positionQty: 0,
        observationId: "",
        sourceGeneration: "",
        observedAt: "2026-08-23T00:00:20.000Z",
      }),
      mutationAttemptAtMs: Date.parse("2026-08-23T00:00:10.000Z"),
      ownershipPrefix: OWNER_PREFIX,
      nowMs: Date.parse("2026-08-23T00:00:20.000Z"),
      expectedLeaseGeneration: "lease-1",
    });
    assert.equal(missingProvenance.ok, false);
  });

  it("BC8 generic or cached snapshot cannot be locally promoted to authoritative fresh evidence", async () => {
    const transport = createVenueReductionTransport({
      apply: async () => ({ placed: 0, cancelled: 0, failed: 0, errors: [] }),
      closePosition: async () => undefined,
      snapshot: async () => ({
        venue: "extended",
        market: MARKET,
        mid: 100_000,
        position: 0,
        openOrders: [],
        observedAt: new Date().toISOString(),
      }),
      assertLeaseCurrent: () => undefined,
    });
    const generic = await transport.fetchFreshSnapshot({
      market: MARKET,
      mutationAttemptAtMs: Date.now() - 1,
      leaseGeneration: "lease-1",
    });
    assert.notEqual(generic.freshness, "fresh");
    assert.equal(generic.observationId, "");
    assert.equal(generic.sourceGeneration, "");
    assert.equal(generic.leaseGeneration, undefined);

    const dir = tmpDir("bc8");
    const id = "bc8-generic";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const haltTransport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: [generic],
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport: haltTransport,
    });
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("BC9 fresh non-flat retry recalculates side/quantity from latest position and uses safe deterministic attempt identity", async () => {
    const dir = tmpDir("bc9");
    const id = "bc9-retry-qty";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.002 }),
      LIMITS,
      running
    );
    const incident = evaluated.next.haltId as string;
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      snapshots: (attempt) => freshSnapshot({
        positionQty: 0.001,
        observationId: `after-${attempt}`,
        sourceGeneration: `g-after-${attempt}`,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.002,
      transport,
    });
    assert.ok(transport.flattenCalls >= 2, "fresh non-flat must retry");
    assert.equal(transport.flattenRequests[0]?.qty, 0.002);
    assert.equal(transport.flattenRequests[0]?.side, "sell");
    assert.equal(transport.flattenRequests[1]?.qty, 0.001);
    assert.equal(transport.flattenRequests[1]?.side, "sell");
    assert.ok((transport.flattenRequests[1]?.qty ?? 1) <= 0.001 + 1e-15);
    assert.equal(transport.flattenClientOrderIds[0], reductionClientOrderId(incident, 1));
    assert.equal(transport.flattenClientOrderIds[1], reductionClientOrderId(incident, 2));
    assert.notEqual(transport.flattenClientOrderIds[0], transport.flattenClientOrderIds[1]);
    assert.equal(result.verifiedFlat, false);
  });

  it("BC10 UNKNOWN flatten does not create a blind second mutation", async () => {
    const dir = tmpDir("bc10");
    const id = "bc10-unknown";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
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
    assert.equal(transport.flattenCalls, 1);
    assert.equal(result.flatten?.outcome, "UNKNOWN");
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("BC11 opposite-side oversized owned non-reduce-only order is cancelled or blocks HALTED_FLAT", async () => {
    const leftover = ownedOrder({ side: "sell", size: 0.01, id: "ex-sell-oversize" });
    assert.equal(isOwnedRiskIncreasingOrder(leftover, OWNER_PREFIX, 0.001), true);
    const verified = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        positionQty: 0,
        openOrders: [leftover],
        observedAt: "2026-08-23T00:00:20.000Z",
      }),
      mutationAttemptAtMs: Date.parse("2026-08-23T00:00:10.000Z"),
      ownershipPrefix: OWNER_PREFIX,
      nowMs: Date.parse("2026-08-23T00:00:20.000Z"),
      expectedLeaseGeneration: "lease-1",
    });
    assert.equal(verified.ok, false);

    const dir = tmpDir("bc11");
    const id = "bc11-cross";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.001 }),
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
      positionQty: 0.001,
      openOrders: [leftover],
      transport,
    });
    assert.ok(
      (transport.cancelledOrders[0] || []).some((row) => row.id === "ex-sell-oversize"),
      "oversized opposite-side owned order must be cancelled"
    );
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("BC12 loop-level risk-state persistence is fenced at its actual write boundary", () => {
    const dir = tmpDir("bc12");
    const id = "bc12-loop-persist";
    seedRunning(id, dir);
    const before = inspectDurablePair(id, dir);
    assert.throws(
      () => persistAuthoritativeRiskState(id, {
        ...emptyRiskState(SCOPE),
        halted: true,
        haltStatus: "HALTING",
        haltId: "bc12-halt",
        haltReasons: ["ACTUAL_NOTIONAL_CAP"],
        leaseGeneration: "lease-1",
        acknowledged: false,
        updatedAt: "2026-08-23T00:00:00.000Z",
      }, dir),
      /RISK_STATE_LEASE_AUTHORITY_MISSING/
    );
    assert.deepEqual(inspectDurablePair(id, dir), before);

    const lost = { hit: 0 };
    assert.throws(
      () => persistAuthoritativeRiskState(id, {
        ...emptyRiskState(SCOPE),
        halted: true,
        haltStatus: "HALTING",
        haltId: "bc12-halt",
        haltReasons: ["ACTUAL_NOTIONAL_CAP"],
        leaseGeneration: "lease-1",
        acknowledged: false,
        updatedAt: "2026-08-23T00:00:00.000Z",
      }, dir, {
        assertLeaseCurrent() {
          lost.hit += 1;
          if (lost.hit > 1) throw new Error("RUNTIME_LEASE_LOST");
        },
        onAtomicWriteStep(step, target) {
          if (path.basename(target) === "risk-state.json" && step === "BEFORE_RENAME") {
            throw new Error("RUNTIME_LEASE_LOST");
          }
        },
      }),
      /RUNTIME_LEASE_LOST/
    );
    assert.deepEqual(inspectDurablePair(id, dir), before);
    assert.ok(lost.hit >= 1);
  });

  it("BC13 Extended reduction rejects stale lease/request mismatch and cannot increase absolute exposure", async () => {
    const ex = new ExtendedExecutor(true);
    ex.setLeaseGeneration(5);
    const base = {
      market: MARKET,
      targetAbsPositionQty: 0 as const,
      incidentId: "halt-bc13",
      positionQty: 0.001,
      attempt: 1,
      clientOrderId: reductionClientOrderId("halt-bc13", 1),
    };
    const stale = await ex.reduceExposure({
      ...base,
      leaseGeneration: "4",
      side: "sell",
      qty: 0.001,
    });
    assert.equal(stale.outcome, "NOT_SENT");
    assert.match(String(stale.reasonCode), /STALE|LEASE/);

    const increasing = await ex.reduceExposure({
      ...base,
      leaseGeneration: "5",
      side: "buy",
      qty: 0.001,
    });
    assert.equal(increasing.outcome, "NOT_SENT");
    assert.match(String(increasing.reasonCode), /EXPOSURE|SIDE/);

    const oversized = await ex.reduceExposure({
      ...base,
      leaseGeneration: "5",
      side: "sell",
      qty: 0.01,
    });
    assert.equal(oversized.outcome, "NOT_SENT");
    assert.match(String(oversized.reasonCode), /QTY|EXPOSURE|POSITION/);
  });

  it("CB2-1 deterministic ID reaches actual vendor payload.id", async () => {
    const { exchange, submittedPayloads } = await createOfflineExtendedVendor();
    const executor = new ExtendedExecutor(false);
    executor.setLeaseGeneration(5);
    attachExtendedExchangeForTests(executor, exchange);
    const requested = reductionClientOrderId("halt-cb2-1", 1);
    const result = await executor.reduceExposure({
      market: MARKET,
      targetAbsPositionQty: 0,
      incidentId: "halt-cb2-1",
      leaseGeneration: "5",
      positionQty: 0.001,
      attempt: 1,
      clientOrderId: requested,
      side: "sell",
      qty: 0.001,
    });
    assert.equal(submittedPayloads.length, 1, "vendor _submitOrder must physically POST once");
    assert.equal(submittedPayloads[0]?.payload.id, requested);
    assert.equal(result.requestedClientOrderId, requested);
    assert.equal(result.submittedExternalId, requested);
    assert.equal(result.requestedClientOrderId, result.submittedExternalId);
    assert.equal(result.submittedExternalId, submittedPayloads[0]?.payload.id);
  });

  it("CB2-2 ACK returns verified identity and keeps exchange ID separate", async () => {
    const { exchange, submittedPayloads } = await createOfflineExtendedVendor();
    const executor = new ExtendedExecutor(false);
    executor.setLeaseGeneration(5);
    attachExtendedExchangeForTests(executor, exchange);
    const requested = reductionClientOrderId("halt-cb2-2", 1);
    const result = await executor.reduceExposure({
      market: MARKET,
      targetAbsPositionQty: 0,
      incidentId: "halt-cb2-2",
      leaseGeneration: "5",
      positionQty: 0.001,
      attempt: 1,
      clientOrderId: requested,
      side: "sell",
      qty: 0.001,
    });
    assert.equal(result.outcome, "ACK");
    assert.equal(result.requestedClientOrderId, requested);
    assert.equal(result.submittedExternalId, requested);
    assert.equal(result.exchangeOrderId, "venue-internal-77");
    assert.notEqual(result.exchangeOrderId, result.submittedExternalId);
    assert.equal(submittedPayloads[0]?.payload.id, requested);
  });

  it("CB2-3 identity mismatch is UNKNOWN and does not ACK", async () => {
    const executor = new ExtendedExecutor(false);
    executor.setLeaseGeneration(5);
    attachExtendedExchangeForTests(executor, {
      marketIdForName: (name: string) => (name.includes("BTC") ? 1 : null),
      closePosition: async () => ({
        submittedExternalId: "not-the-requested-id",
        exchangeId: "venue-1",
        exchangeOrderId: "venue-1",
      }),
    });
    const requested = reductionClientOrderId("halt-cb2-3", 1);
    const mismatched = await executor.reduceExposure({
      market: MARKET,
      targetAbsPositionQty: 0,
      incidentId: "halt-cb2-3",
      leaseGeneration: "5",
      positionQty: 0.001,
      attempt: 1,
      clientOrderId: requested,
      side: "sell",
      qty: 0.001,
    });
    assert.equal(mismatched.outcome, "UNKNOWN");
    assert.equal(mismatched.reasonCode, "REDUCTION_IDENTITY_MISMATCH");
    assert.notEqual(mismatched.outcome, "ACK");

    attachExtendedExchangeForTests(executor, {
      marketIdForName: (name: string) => (name.includes("BTC") ? 1 : null),
      closePosition: async () => ({
        exchangeId: "venue-1",
        exchangeOrderId: "venue-1",
      }),
    });
    const missing = await executor.reduceExposure({
      market: MARKET,
      targetAbsPositionQty: 0,
      incidentId: "halt-cb2-3",
      leaseGeneration: "5",
      positionQty: 0.001,
      attempt: 1,
      clientOrderId: requested,
      side: "sell",
      qty: 0.001,
    });
    assert.equal(missing.outcome, "UNKNOWN");
    assert.equal(missing.reasonCode, "REDUCTION_IDENTITY_MISMATCH");

    const dir = tmpDir("cb2-3");
    const id = "cb2-3-halt";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: (request) => ({
        outcome: "UNKNOWN",
        reasonCode: "REDUCTION_IDENTITY_MISMATCH",
        requestedClientOrderId: request.clientOrderId,
        submittedExternalId: "other-id",
        clientOrderId: request.clientOrderId,
      }),
      snapshots: () => freshSnapshot({ positionQty: 0.0018 }),
    });
    const halted = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(halted.flatten?.outcome, "UNKNOWN");
    assert.equal(halted.flatten?.reasonCode, "REDUCTION_IDENTITY_MISMATCH");
    assert.equal(halted.verifiedFlat, false);
    assert.notEqual(halted.state.haltStatus, "HALTED_FLAT");
    assert.equal(transport.flattenCalls, 1);
  });

  it("CB2-4 unchanged position still advances physical attempt identity", async () => {
    const dir = tmpDir("cb2-4");
    const id = "cb2-4-same-bytes";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const incident = evaluated.next.haltId as string;
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      snapshots: (attempt) => freshSnapshot({
        positionQty: 0.0018,
        observationId: `cb2-4-${attempt}`,
        sourceGeneration: `g-cb2-4-${attempt}`,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(transport.flattenCalls, 2);
    assert.equal(transport.flattenRequests[0]?.attempt, 1);
    assert.equal(transport.flattenRequests[1]?.attempt, 2);
    assert.equal(transport.flattenRequests[0]?.clientOrderId, reductionClientOrderId(incident, 1));
    assert.equal(transport.flattenRequests[1]?.clientOrderId, reductionClientOrderId(incident, 2));
    assert.equal(transport.flattenClientOrderIds[0], `cg-reduce:${incident}:flatten`);
    assert.equal(transport.flattenClientOrderIds[1], `cg-reduce:${incident}:flatten:2`);
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("CB2-5 changed position recomputes direction and quantity with advancing attempt", async () => {
    const dir = tmpDir("cb2-5");
    const id = "cb2-5-recompute";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 200, positionQty: -0.002 }),
      LIMITS,
      running
    );
    const incident = evaluated.next.haltId as string;
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      snapshots: (attempt) => freshSnapshot({
        positionQty: attempt === 1 ? 0.001 : 0.001,
        observationId: `cb2-5-${attempt}`,
        sourceGeneration: `g-cb2-5-${attempt}`,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: -0.002,
      transport,
    });
    assert.ok(transport.flattenCalls >= 2);
    assert.equal(transport.flattenRequests[0]?.side, "buy");
    assert.equal(transport.flattenRequests[0]?.qty, 0.002);
    assert.equal(transport.flattenRequests[1]?.side, "sell");
    assert.equal(transport.flattenRequests[1]?.qty, 0.001);
    assert.ok((transport.flattenRequests[1]?.qty ?? 1) <= 0.001 + 1e-15);
    assert.equal(transport.flattenRequests[1]?.attempt, 2);
    assert.equal(transport.flattenClientOrderIds[0], reductionClientOrderId(incident, 1));
    assert.equal(transport.flattenClientOrderIds[1], reductionClientOrderId(incident, 2));
    assert.equal(result.verifiedFlat, false);
  });

  it("CB2-6 old observation cannot verify a later physical attempt", async () => {
    const replayed = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        positionQty: 0,
        observationId: "obs-shared",
        sourceGeneration: "gen-shared",
        observedAt: "2026-08-23T00:00:20.000Z",
      }),
      mutationAttemptAtMs: Date.parse("2026-08-23T00:00:15.000Z"),
      ownershipPrefix: OWNER_PREFIX,
      nowMs: Date.parse("2026-08-23T00:00:20.000Z"),
      expectedLeaseGeneration: "lease-1",
      consumedObservationIds: ["obs-shared"],
      consumedSourceGenerations: ["gen-shared"],
    });
    assert.equal(replayed.ok, false);
    if (replayed.ok) assert.fail("replayed observation must be rejected");
    else assert.equal(replayed.reasonCode, "REDUCTION_OBSERVATION_REPLAY");

    const dir = tmpDir("cb2-6");
    const id = "cb2-6-replay";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const reused = {
      observationId: "obs-attempt-1",
      sourceGeneration: "gen-attempt-1",
    };
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      snapshots: (attempt) => freshSnapshot({
        positionQty: attempt === 1 ? 0.0018 : 0,
        observationId: reused.observationId,
        sourceGeneration: reused.sourceGeneration,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(transport.flattenCalls, 2);
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.ok(result.errors.some((row) => row.includes("REDUCTION_OBSERVATION_REPLAY")));
  });

  it("CB2-7 each physical submission rebinds mutationAttemptAtMs", async () => {
    const dir = tmpDir("cb2-7");
    const id = "cb2-7-ts";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const clock = { ms: 1_700_000_000_000 };
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      snapshots: (attempt) => freshSnapshot({
        positionQty: 0.0018,
        observationId: `cb2-7-${attempt}`,
        sourceGeneration: `g-cb2-7-${attempt}`,
        observedAt: new Date(clock.ms + 1).toISOString(),
      }),
      onFlatten() {
        clock.ms += 5_000;
      },
    });
    await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
      nowMs: () => clock.ms,
    });
    assert.equal(transport.flattenCalls, 2);
    assert.equal(transport.snapshotCalls, 2);
    assert.equal(transport.snapshotMutationAttemptAtMs[0], 1_700_000_000_000);
    assert.equal(transport.snapshotMutationAttemptAtMs[1], 1_700_000_005_000);
    assert.ok(
      (transport.snapshotMutationAttemptAtMs[1] ?? 0) > (transport.snapshotMutationAttemptAtMs[0] ?? 0),
      "later verifier must use the later attempt timestamp"
    );
  });

  it("CB2-8 UNKNOWN causes no blind second mutation", async () => {
    const dir = tmpDir("cb2-8");
    const id = "cb2-8-unknown";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
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
    assert.equal(transport.flattenCalls, 1);
    assert.equal(result.flatten?.outcome, "UNKNOWN");
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.equal(result.reseedAllowed, false);
    assert.equal(experimentAllowsReseed(result.state), false);
  });

  it("CB2-9 lease loss and durable authority remain unchanged", async () => {
    const dir = tmpDir("cb2-9");
    const id = "cb2-9-lease";
    seedRunning(id, dir, "lease-2");
    const before = inspectDurablePairInFreshProcess(id, dir);
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
      transport,
      leaseGeneration: "lease-1",
      assertLeaseCurrent() {
        throw new Error("RUNTIME_LEASE_GENERATION_MISMATCH");
      },
    });
    const after = inspectDurablePairInFreshProcess(id, dir);
    assert.deepEqual(after, before);
    assert.equal(after.primarySha256, before.primarySha256);
    assert.equal(after.backupSha256, before.backupSha256);
    assert.equal(after.storeGeneration, before.storeGeneration);
    assert.equal(after.envelopeSha256, before.envelopeSha256);
    assert.equal(transport.cancelCalls, 0);
    assert.equal(transport.flattenCalls, 0);
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.equal(loadRiskState(id, dir, SCOPE).haltStatus, "RUNNING");
  });

  it("C2-1 Attempt 1 ACK with unchanged side/qty still allocates attempt 2 and a new clientOrderId", async () => {
    const dir = tmpDir("c2-1");
    const id = "c2-1-same-bytes";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const incident = evaluated.next.haltId as string;
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      snapshots: (attempt) => freshSnapshot({
        positionQty: 0.0018,
        observationId: `c2-1-${attempt}`,
        sourceGeneration: `g-c2-1-${attempt}`,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(transport.flattenCalls, 2);
    assert.equal(transport.flattenRequests[0]?.attempt, 1);
    assert.equal(transport.flattenRequests[1]?.attempt, 2);
    assert.equal(transport.flattenRequests[0]?.side, transport.flattenRequests[1]?.side);
    assert.equal(transport.flattenRequests[0]?.qty, transport.flattenRequests[1]?.qty);
    assert.equal(transport.flattenClientOrderIds[0], `cg-reduce:${incident}:flatten`);
    assert.equal(transport.flattenClientOrderIds[1], `cg-reduce:${incident}:flatten:2`);
    assert.notEqual(transport.flattenClientOrderIds[0], transport.flattenClientOrderIds[1]);
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("C2-2 snapshot after attempt 1 but before attempt 2 barrier cannot verify attempt 2", async () => {
    const dir = tmpDir("c2-2");
    const id = "c2-2-pre-barrier";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const clock = { ms: 1_700_000_000_000 };
    let attempt2StartedAtMs = 0;
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      onFlatten() {
        if (transport.flattenCalls === 2) attempt2StartedAtMs = clock.ms;
        clock.ms += 5_000;
      },
      snapshots: (attempt) => {
        if (attempt === 1) {
          return freshSnapshot({
            positionQty: 0.0018,
            observationId: "c2-2-after-1",
            sourceGeneration: "g-c2-2-after-1",
            observedAt: new Date(clock.ms + 1).toISOString(),
          });
        }
        return freshSnapshot({
          positionQty: 0,
          observationId: "c2-2-before-2-complete",
          sourceGeneration: "g-c2-2-before-2-complete",
          observedAt: new Date(attempt2StartedAtMs).toISOString(),
        });
      },
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
      nowMs: () => clock.ms,
    });
    assert.equal(transport.flattenCalls, 2);
    assert.ok(attempt2StartedAtMs > 0);
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.ok(result.errors.some((row) => /STALE_OR_PRE_WRITE|REDUCTION_OBSERVATION_REPLAY/.test(row)));
  });

  it("C2-3 only a new authoritative post-attempt-2 snapshot may verify attempt 2", async () => {
    const dir = tmpDir("c2-3");
    const id = "c2-3-post-barrier";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const clock = { ms: 1_700_000_000_000 };
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      onFlatten() {
        clock.ms += 5_000;
      },
      snapshots: (attempt) => freshSnapshot({
        positionQty: attempt === 1 ? 0.0018 : 0,
        observationId: `c2-3-${attempt}`,
        sourceGeneration: `g-c2-3-${attempt}`,
        observedAt: new Date(clock.ms + 1).toISOString(),
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
      nowMs: () => clock.ms,
    });
    assert.equal(transport.flattenCalls, 2);
    assert.equal(transport.snapshotEvidence[0]?.observationId, "c2-3-1");
    assert.equal(transport.snapshotEvidence[1]?.observationId, "c2-3-2");
    assert.notEqual(transport.snapshotEvidence[0]?.sourceGeneration, transport.snapshotEvidence[1]?.sourceGeneration);
    assert.equal(result.verifiedFlat, true);
    assert.equal(result.state.haltStatus, "HALTED_FLAT");
  });

  it("C2-4 latest quantity change recomputes side/qty and still uses attempt 2", async () => {
    const dir = tmpDir("c2-4");
    const id = "c2-4-recompute";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 200, positionQty: -0.002 }),
      LIMITS,
      running
    );
    const incident = evaluated.next.haltId as string;
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      snapshots: (attempt) => freshSnapshot({
        positionQty: attempt === 1 ? 0.001 : 0.001,
        observationId: `c2-4-${attempt}`,
        sourceGeneration: `g-c2-4-${attempt}`,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: -0.002,
      transport,
    });
    assert.ok(transport.flattenCalls >= 2);
    assert.equal(transport.flattenRequests[0]?.side, "buy");
    assert.equal(transport.flattenRequests[0]?.qty, 0.002);
    assert.equal(transport.flattenRequests[1]?.side, "sell");
    assert.equal(transport.flattenRequests[1]?.qty, 0.001);
    assert.equal(transport.flattenRequests[1]?.attempt, 2);
    assert.equal(transport.flattenClientOrderIds[0], reductionClientOrderId(incident, 1));
    assert.equal(transport.flattenClientOrderIds[1], reductionClientOrderId(incident, 2));
    assert.equal(result.verifiedFlat, false);
  });

  it("C2-5 UNKNOWN creates exactly one transport mutation and does not blind-submit again", async () => {
    const dir = tmpDir("c2-5");
    const id = "c2-5-unknown";
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
    assert.equal(transport.flattenCalls, 1);
    assert.equal(result.flatten?.outcome, "UNKNOWN");
    assert.deepEqual(transport.flattenClientOrderIds, [reductionClientOrderId(incident, 1)]);
    assert.ok(["HALTED_UNFLAT", "HALT_FAILED"].includes(result.state.haltStatus));
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.equal(result.reseedAllowed, false);
  });

  it("C2-6 unclassified thrown exception returns UNKNOWN, not REJECTED", async () => {
    assert.equal(classifyTransportError(new Error("order rejected by exchange")), "UNKNOWN");
    assert.equal(classifyTransportError(new Error("sdk parser exploded")), "UNKNOWN");
    assert.equal(classifyTransportError(new Error("timeout ETIMEDOUT")), "UNKNOWN");

    const dir = tmpDir("c2-6");
    const id = "c2-6-unclassified";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: () => {
        throw new Error("order rejected by exchange");
      },
      snapshots: () => freshSnapshot({ positionQty: 0.0018 }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(transport.flattenCalls, 1);
    assert.equal(result.flatten?.outcome, "UNKNOWN");
    assert.notEqual(result.flatten?.outcome, "REJECTED");
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.equal(result.reseedAllowed, false);
  });

  it("C2-7 typed explicit venue rejection returns REJECTED", async () => {
    const typed = Object.assign(new Error("ORDER_REJECTED"), {
      rejectionProven: true,
      venueAccepted: false,
    });
    assert.equal(classifyTransportError(typed), "REJECTED");
    assert.equal(classifyTransportError(new Error("ORDER_REJECTED")), "UNKNOWN");

    const dir = tmpDir("c2-7");
    const id = "c2-7-typed-reject";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: () => {
        throw Object.assign(new Error("ORDER_REJECTED"), {
          rejectionProven: true,
          venueAccepted: false,
        });
      },
      snapshots: () => freshSnapshot({ positionQty: 0 }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(transport.flattenCalls, 1);
    assert.equal(result.flatten?.outcome, "REJECTED");
    assert.ok(["HALTED_UNFLAT", "HALT_FAILED"].includes(result.state.haltStatus));
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("C2-8 proven local lease/preflight failure returns NOT_SENT and performs no transport call", async () => {
    const dir = tmpDir("c2-8");
    const id = "c2-8-not-sent";
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
      snapshots: () => freshSnapshot({ positionQty: 0 }),
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
    assert.notEqual(result.flatten?.outcome, "UNKNOWN");
    assert.notEqual(result.flatten?.outcome, "REJECTED");
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("C2-9 earlier attempt observationId/sourceGeneration cannot prove a later attempt", async () => {
    const replayed = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        positionQty: 0,
        observationId: "obs-c2-9",
        sourceGeneration: "gen-c2-9",
        observedAt: "2026-08-23T00:00:20.000Z",
      }),
      mutationAttemptAtMs: Date.parse("2026-08-23T00:00:15.000Z"),
      ownershipPrefix: OWNER_PREFIX,
      nowMs: Date.parse("2026-08-23T00:00:20.000Z"),
      expectedLeaseGeneration: "lease-1",
      consumedObservationIds: ["obs-c2-9"],
      consumedSourceGenerations: ["gen-c2-9"],
    });
    assert.equal(replayed.ok, false);
    if (replayed.ok) assert.fail("earlier observation must not verify a later attempt");
    else assert.equal(replayed.reasonCode, "REDUCTION_OBSERVATION_REPLAY");

    const dir = tmpDir("c2-9");
    const id = "c2-9-replay";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const reused = {
      observationId: "obs-c2-9-shared",
      sourceGeneration: "gen-c2-9-shared",
    };
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: ["ACK", "ACK"],
      snapshots: (attempt) => freshSnapshot({
        positionQty: attempt === 1 ? 0.0018 : 0,
        observationId: reused.observationId,
        sourceGeneration: reused.sourceGeneration,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(transport.flattenCalls, 2);
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.ok(result.errors.some((row) => row.includes("REDUCTION_OBSERVATION_REPLAY")));
  });

  it("C2-10 lease loss between submit response and verification cannot produce HALTED_FLAT", async () => {
    const dir = tmpDir("c2-10");
    const id = "c2-10-lease-gap";
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
      snapshots: () => freshSnapshot({ positionQty: 0 }),
      onFlatten() {
        lease.lost = true;
      },
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
      assertLeaseCurrent() {
        if (lease.lost) throw new Error("RUNTIME_LEASE_LOST");
      },
    });
    assert.equal(transport.flattenCalls, 1);
    assert.equal(transport.snapshotCalls, 0);
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.notEqual(loadRiskState(id, dir, SCOPE).haltStatus, "HALTED_FLAT");
  });

  it("C2-11 prior B1-B22, BC1-BC13 case IDs remain present without being rewritten away", () => {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    for (let i = 1; i <= 22; i += 1) {
      assert.match(src, new RegExp(`it\\("B${i}:`), `missing B${i}`);
    }
    for (let i = 1; i <= 13; i += 1) {
      assert.match(src, new RegExp(`it\\("BC${i}[ :]`), `missing BC${i}`);
    }
  });

  function hasAudit(result: { errors: string[]; state: { haltReasons: string[] } }, code: string): boolean {
    return result.errors.includes(code) || result.state.haltReasons.includes(code);
  }

  it("C3-1 cancel UNKNOWN + dangerous order remains => flattenCalls=0", async () => {
    const dir = tmpDir("c3-1");
    const id = "c3-1-unknown-remain";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 1 }),
      LIMITS,
      running
    );
    const leftover = ownedOrder({ side: "sell", size: 0.6, id: "ex-sell-a" });
    const transport = scriptedTransport({
      cancel: "UNKNOWN",
      flatten: "ACK",
      snapshots: () => freshSnapshot({
        positionQty: 1,
        openOrders: [leftover],
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 1,
      openOrders: [leftover],
      transport,
    });
    assert.equal(transport.flattenCalls, 0);
    assert.ok(["HALTED_UNFLAT", "HALT_FAILED"].includes(result.state.haltStatus));
    assert.equal(result.reseedAllowed, false);
    assert.ok(hasAudit(result, "CANCEL_RECONCILIATION_UNPROVEN") || hasAudit(result, "UNSAFE_OWNED_ORDER_REMAINS"));
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.notEqual(result.state.haltStatus, "RUNNING");
  });

  it("C3-2 cancel REJECTED + fresh snapshot independently proves absence => flatten may proceed from latest position", async () => {
    const dir = tmpDir("c3-2");
    const id = "c3-2-reject-absent";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 1 }),
      LIMITS,
      running
    );
    const targeted = ownedOrder({ side: "sell", size: 0.4, id: "ex-sell-absent" });
    const transport = scriptedTransport({
      cancel: "REJECTED",
      flatten: "ACK",
      snapshots: (n) => freshSnapshot({
        positionQty: n === 1 ? 0.7 : 0,
        openOrders: [],
        observationId: `c3-2-${n}`,
        sourceGeneration: `g-c3-2-${n}`,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 1,
      openOrders: [targeted],
      transport,
    });
    assert.equal(result.cancel?.outcome, "REJECTED");
    assert.ok(transport.flattenCalls >= 1, "absence proof may authorize flatten from latest position");
    assert.equal(transport.flattenRequests[0]?.qty, 0.7);
    assert.equal(transport.flattenRequests[0]?.side, "sell");
    assert.ok((transport.flattenRequests[0]?.qty ?? 1) <= 0.7 + 1e-15);
    assert.equal(result.reseedAllowed, false);
  });

  it("C3-3 cancel ACK without authoritative absence proof => flattenCalls=0", async () => {
    const dir = tmpDir("c3-3");
    const id = "c3-3-ack-unproven";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 1 }),
      LIMITS,
      running
    );
    const leftover = ownedOrder({ side: "buy", id: "ex-buy-still-open" });
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({
        positionQty: 1,
        openOrders: [leftover],
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 1,
      openOrders: [leftover],
      transport,
    });
    assert.equal(result.cancel?.outcome, "ACK");
    assert.equal(transport.flattenCalls, 0);
    assert.ok(["HALTED_UNFLAT", "HALT_FAILED"].includes(result.state.haltStatus));
    assert.equal(result.reseedAllowed, false);
    assert.ok(hasAudit(result, "CANCEL_RECONCILIATION_UNPROVEN") || hasAudit(result, "UNSAFE_OWNED_ORDER_REMAINS"));
  });

  it("C3-4 pre-cancel/cached/replayed snapshot cannot authorize flatten", async () => {
    const targeted = ownedOrder({ side: "buy", id: "ex-buy-c3-4" });
    const preCancel = freshSnapshot({
      positionQty: 0,
      openOrders: [],
      freshness: "fresh",
      observationId: "obs-pre-cancel",
      sourceGeneration: "gen-pre-cancel",
      observedAt: "2026-08-23T00:00:01.000Z",
      capturedAtMs: Date.parse("2026-08-23T00:00:01.000Z"),
    });
    const cached = freshSnapshot({
      positionQty: 0,
      openOrders: [],
      freshness: "cached",
      observationId: "obs-cached",
      sourceGeneration: "gen-cached",
    });
    for (const [label, snap] of [["pre-cancel", preCancel], ["cached", cached]] as const) {
      const caseDir = tmpDir(`c3-4-${label}`);
      const caseId = `c3-4-stale-recon-${label}`;
      const caseRunning = seedRunning(caseId, caseDir);
      const caseEvaluated = evaluateExperimentRisk(
        riskInput({ positionNotionalUsd: 180, positionQty: 1 }),
        LIMITS,
        caseRunning
      );
      const transport = scriptedTransport({
        cancel: "ACK",
        flatten: "ACK",
        snapshots: [snap],
      });
      const result = await runHalt({
        id: caseId,
        dir: caseDir,
        state: caseEvaluated.next,
        positionQty: 1,
        openOrders: [targeted],
        transport,
      });
      assert.equal(transport.flattenCalls, 0, label);
      assert.notEqual(result.state.haltStatus, "HALTED_FLAT", label);
      assert.equal(result.reseedAllowed, false, label);
      assert.ok(
        hasAudit(result, "CANCEL_RECONCILIATION_UNPROVEN")
        || hasAudit(result, "CACHED_SNAPSHOT")
        || hasAudit(result, "STALE_OR_PRE_WRITE")
        || hasAudit(result, "REDUCTION_OBSERVATION_REPLAY"),
        label
      );
    }
  });

  it("C3-5 long 1 + sell 0.6 + sell 0.6 non-reduce-only => both cancel targets", async () => {
    const sellA = ownedOrder({ side: "sell", size: 0.6, id: "ex-sell-a", level: 8 });
    const sellB = ownedOrder({ side: "sell", size: 0.6, id: "ex-sell-b", level: 9 });
    assert.equal(isUnsafeOwnedOpenOrder(sellA, OWNER_PREFIX), true);
    assert.equal(isUnsafeOwnedOpenOrder(sellB, OWNER_PREFIX), true);
    assert.equal(isOwnedRiskIncreasingOrder(sellA, OWNER_PREFIX, 1), true);
    assert.equal(isOwnedRiskIncreasingOrder(sellB, OWNER_PREFIX, 1), true);

    const dir = tmpDir("c3-5");
    const id = "c3-5-aggregate";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 1 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({
        positionQty: 1,
        openOrders: [sellA, sellB],
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 1,
      openOrders: [sellA, sellB],
      transport,
    });
    const cancelledIds = (transport.cancelledOrders[0] || []).map((row) => row.id);
    assert.ok(cancelledIds.includes("ex-sell-a"), "sell 0.6 A must be a cancel target");
    assert.ok(cancelledIds.includes("ex-sell-b"), "sell 0.6 B must be a cancel target");
    assert.equal(transport.flattenCalls, 0);
    assert.ok(hasAudit(result, "UNSAFE_OWNED_ORDER_REMAINS") || hasAudit(result, "CANCEL_RECONCILIATION_UNPROVEN"));
  });

  it("C3-6 long 1 + sell 0.4 non-reduce-only => cancel before full flatten", async () => {
    const sell = ownedOrder({ side: "sell", size: 0.4, id: "ex-sell-04" });
    assert.equal(isUnsafeOwnedOpenOrder(sell, OWNER_PREFIX), true);
    const dir = tmpDir("c3-6");
    const id = "c3-6-undersize";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 1 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: (n) => freshSnapshot({
        positionQty: n === 1 ? 1 : 0,
        openOrders: [],
        observationId: `c3-6-${n}`,
        sourceGeneration: `g-c3-6-${n}`,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 1,
      openOrders: [sell],
      transport,
    });
    assert.ok((transport.cancelledOrders[0] || []).some((row) => row.id === "ex-sell-04"));
    assert.ok(transport.cancelCalls >= 1);
    assert.ok(transport.flattenCalls >= 1, "order absence must be proven before flatten");
    assert.equal(result.reseedAllowed, false);
  });

  it("C3-7 true venue-proven reduce-only order remains excluded without authorizing new exposure", async () => {
    const reduceOnly = ownedOrder({ side: "sell", size: 0.4, id: "ex-ro", reduceOnly: true });
    const unsafeBuy = ownedOrder({ side: "buy", id: "ex-buy-1" });
    assert.equal(isVenueProvenReduceOnly(reduceOnly), true);
    assert.equal(isUnsafeOwnedOpenOrder(reduceOnly, OWNER_PREFIX), false);
    assert.equal(isUnsafeOwnedOpenOrder(unsafeBuy, OWNER_PREFIX), true);
    const dir = tmpDir("c3-7");
    const id = "c3-7-ro";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 1 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: (n) => freshSnapshot({
        positionQty: n === 1 ? 1 : 0,
        openOrders: [reduceOnly],
        observationId: `c3-7-${n}`,
        sourceGeneration: `g-c3-7-${n}`,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 1,
      openOrders: [reduceOnly, unsafeBuy],
      transport,
    });
    const cancelledIds = (transport.cancelledOrders[0] || []).map((row) => row.id);
    assert.ok(cancelledIds.includes("ex-buy-1"));
    assert.equal(cancelledIds.includes("ex-ro"), false, "venue-proven reduce-only must stay excluded");
    assert.ok(transport.flattenCalls >= 1);
    assert.equal(result.verifiedFlat, true);
    assert.equal(result.state.haltStatus, "HALTED_FLAT");
    assert.equal(result.reseedAllowed, false);
    assert.notEqual(result.state.haltStatus, "RUNNING");
  });

  it("C3-8 retry attempt 2 throws after transport boundary => attempt 2 UNKNOWN + exactly one reconciliation + no attempt 3", async () => {
    const dir = tmpDir("c3-8");
    const id = "c3-8-retry-throw";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const incident = evaluated.next.haltId as string;
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: (req) => {
        if (req.attempt === 2) throw new Error("socket hang up after write");
        return ackFlatten(req);
      },
      snapshots: (n) => freshSnapshot({
        positionQty: 0.0018,
        observationId: `c3-8-${n}`,
        sourceGeneration: `g-c3-8-${n}`,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(transport.flattenCalls, 2);
    assert.equal(result.flatten?.outcome, "UNKNOWN");
    assert.equal(result.flatten?.attempt, 2);
    assert.equal(result.flatten?.requestedClientOrderId, reductionClientOrderId(incident, 2));
    assert.equal(result.flatten?.clientOrderId, reductionClientOrderId(incident, 2));
    assert.ok(Number.isFinite(result.flatten?.requestStartedAtMs));
    assert.ok(Number.isFinite(result.flatten?.verificationBarrierAtMs));
    assert.equal(transport.snapshotCalls, 2, "exactly one post-attempt-2 reconciliation");
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.ok(hasAudit(result, "FLATTEN_ATTEMPT_UNKNOWN"));
  });

  it("C3-9 retry attempt 2 UNKNOWN + new post-barrier flat snapshot => HALTED_FLAT", async () => {
    const dir = tmpDir("c3-9");
    const id = "c3-9-retry-unknown-flat";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const clock = { ms: 1_700_000_000_000 };
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: (req) => {
        if (req.attempt === 2) throw new Error("timeout after transport entry");
        return ackFlatten(req);
      },
      onFlatten() {
        clock.ms += 1_000;
      },
      snapshots: (n) => freshSnapshot({
        positionQty: n === 1 ? 0.0018 : 0,
        observationId: `c3-9-${n}`,
        sourceGeneration: `g-c3-9-${n}`,
        observedAt: new Date(clock.ms).toISOString(),
        capturedAtMs: clock.ms,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
      nowMs: () => clock.ms,
    });
    assert.equal(transport.flattenCalls, 2);
    assert.equal(result.flatten?.outcome, "UNKNOWN");
    assert.equal(result.flatten?.attempt, 2);
    assert.equal(result.verifiedFlat, true);
    assert.equal(result.state.haltStatus, "HALTED_FLAT");
    assert.equal(result.reseedAllowed, false);
  });

  it("C3-10 retry attempt 2 UNKNOWN + old/replayed snapshot => not HALTED_FLAT", async () => {
    const dir = tmpDir("c3-10");
    const id = "c3-10-replay";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const reused = { observationId: "obs-c3-10", sourceGeneration: "gen-c3-10" };
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: (req) => {
        if (req.attempt === 2) throw new Error("connection reset after write");
        return ackFlatten(req);
      },
      snapshots: (n) => freshSnapshot({
        positionQty: n === 1 ? 0.0018 : 0,
        observationId: reused.observationId,
        sourceGeneration: reused.sourceGeneration,
      }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(transport.flattenCalls, 2);
    assert.equal(result.flatten?.attempt, 2);
    assert.equal(result.flatten?.outcome, "UNKNOWN");
    assert.equal(result.verifiedFlat, false);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.ok(hasAudit(result, "REDUCTION_OBSERVATION_REPLAY"));
  });

  it("C3-11 ACK missing submittedExternalId => UNKNOWN", () => {
    const request = {
      market: MARKET,
      targetAbsPositionQty: 0 as const,
      incidentId: "halt-c3-11",
      leaseGeneration: "lease-1",
      positionQty: 0.001,
      attempt: 1,
      clientOrderId: reductionClientOrderId("halt-c3-11", 1),
      side: "sell" as const,
      qty: 0.001,
    };
    const normalized = normalizeReductionResult(request, {
      outcome: "ACK",
      requestedClientOrderId: request.clientOrderId,
      clientOrderId: request.clientOrderId,
    });
    assert.equal(normalized.outcome, "UNKNOWN");
    assert.equal(normalized.reasonCode, "REDUCTION_IDENTITY_MISMATCH");
    assert.notEqual(normalized.outcome, "ACK");
  });

  it("C3-12 ACK mismatched submittedExternalId => UNKNOWN", () => {
    const request = {
      market: MARKET,
      targetAbsPositionQty: 0 as const,
      incidentId: "halt-c3-12",
      leaseGeneration: "lease-1",
      positionQty: 0.001,
      attempt: 1,
      clientOrderId: reductionClientOrderId("halt-c3-12", 1),
      side: "sell" as const,
      qty: 0.001,
    };
    const normalized = normalizeReductionResult(request, {
      outcome: "ACK",
      requestedClientOrderId: request.clientOrderId,
      submittedExternalId: "someone-else",
      clientOrderId: request.clientOrderId,
    });
    assert.equal(normalized.outcome, "UNKNOWN");
    assert.equal(normalized.reasonCode, "REDUCTION_IDENTITY_MISMATCH");
  });

  it("C3-13 malformed/undefined result => UNKNOWN", () => {
    const request = {
      market: MARKET,
      targetAbsPositionQty: 0 as const,
      incidentId: "halt-c3-13",
      leaseGeneration: "lease-1",
      positionQty: 0.001,
      attempt: 1,
      clientOrderId: reductionClientOrderId("halt-c3-13", 1),
      side: "sell" as const,
      qty: 0.001,
    };
    for (const raw of [undefined, null, "ACK", 12, { outcome: "WEIRD" }, { foo: true }]) {
      const normalized = normalizeReductionResult(request, raw);
      assert.equal(normalized.outcome, "UNKNOWN", String(raw));
      assert.ok(
        normalized.reasonCode === "REDUCTION_RESULT_MALFORMED"
        || normalized.reasonCode === "REDUCTION_IDENTITY_MISMATCH",
        String(raw)
      );
    }
  });

  it("C3-14 message-only LEASE_MISSING after transport entry => UNKNOWN", async () => {
    assert.equal(classifyTransportError(new Error("LEASE_MISSING")), "UNKNOWN");
    assert.equal(classifyTransportError(new Error("GENERATION_MISMATCH")), "UNKNOWN");
    assert.equal(classifyTransportError(new Error("NOT_SENT")), "UNKNOWN");

    const dir = tmpDir("c3-14");
    const id = "c3-14-msg-lease";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: () => {
        throw new Error("LEASE_MISSING");
      },
      snapshots: () => freshSnapshot({ positionQty: 0.0018 }),
    });
    const result = await runHalt({
      id,
      dir,
      state: evaluated.next,
      positionQty: 0.0018,
      transport,
    });
    assert.equal(transport.flattenCalls, 1);
    assert.equal(result.flatten?.outcome, "UNKNOWN");
    assert.notEqual(result.flatten?.outcome, "NOT_SENT");
    assert.ok(hasAudit(result, "FLATTEN_ATTEMPT_UNKNOWN"));
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("C3-15 explicitly branded pre-call lease failure => NOT_SENT and zero physical transport calls", async () => {
    const branded = localTransportNotSent("LEASE");
    assert.equal(classifyTransportError(branded), "NOT_SENT");
    const request = {
      market: MARKET,
      targetAbsPositionQty: 0 as const,
      incidentId: "halt-c3-15",
      leaseGeneration: "lease-1",
      positionQty: 0.001,
      attempt: 1,
      clientOrderId: reductionClientOrderId("halt-c3-15", 1),
      side: "sell" as const,
      qty: 0.001,
    };
    const normalized = normalizeReductionResult(request, branded);
    assert.equal(normalized.outcome, "NOT_SENT");
    assert.notEqual(normalized.outcome, "UNKNOWN");

    const dir = tmpDir("c3-15");
    const id = "c3-15-branded";
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
      snapshots: () => freshSnapshot({ positionQty: 0 }),
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
        if (lease.lost) {
          throw Object.assign(new Error("RUNTIME_LEASE_LOST"), localTransportNotSent("LEASE"));
        }
      },
    });
    assert.equal(transport.cancelCalls, 1);
    assert.equal(transport.flattenCalls, 0);
    assert.equal(result.flatten?.outcome, "NOT_SENT");
    assert.notEqual(result.flatten?.outcome, "UNKNOWN");
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("C3-16 future observedAt rejected", () => {
    const nowMs = Date.parse("2026-08-23T00:00:20.000Z");
    const future = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        positionQty: 0,
        observedAt: new Date(nowMs + MAX_CLOCK_SKEW_MS + 1).toISOString(),
        capturedAtMs: nowMs,
      }),
      mutationAttemptAtMs: nowMs - 5_000,
      verificationBarrierAtMs: nowMs - 5_000,
      ownershipPrefix: OWNER_PREFIX,
      nowMs,
      expectedLeaseGeneration: "lease-1",
    });
    assert.equal(future.ok, false);
    if (future.ok) assert.fail("future observedAt must be rejected");
    else assert.equal(future.reasonCode, "FUTURE_OBSERVATION");
    assert.ok(MAX_CLOCK_SKEW_MS > 0);
    assert.ok(MAX_CLOCK_SKEW_MS <= 5_000);
  });

  it("C3-17 capturedAtMs before barrier rejected", () => {
    const barrier = Date.parse("2026-08-23T00:00:10.000Z");
    const nowMs = Date.parse("2026-08-23T00:00:20.000Z");
    const earlyCapture = verifyFlattenSnapshot({
      snapshot: freshSnapshot({
        positionQty: 0,
        observedAt: "2026-08-23T00:00:20.000Z",
        capturedAtMs: barrier - 1,
      }),
      mutationAttemptAtMs: barrier,
      verificationBarrierAtMs: barrier,
      ownershipPrefix: OWNER_PREFIX,
      nowMs,
      expectedLeaseGeneration: "lease-1",
    });
    assert.equal(earlyCapture.ok, false);
    if (earlyCapture.ok) assert.fail("capturedAtMs before barrier must be rejected");
    else assert.ok(
      earlyCapture.reasonCode === "STALE_OR_PRE_WRITE"
      || earlyCapture.reasonCode === "SNAPSHOT_FENCE_MISMATCH"
    );
  });

  it("C3-18 lease loss around cancel reconciliation or flatten reconciliation cannot produce HALTED_FLAT", async () => {
    const dirCancel = tmpDir("c3-18-cancel");
    const idCancel = "c3-18-cancel-recon";
    const runningCancel = seedRunning(idCancel, dirCancel);
    const evaluatedCancel = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 1 }),
      LIMITS,
      runningCancel
    );
    const leaseCancel = { lost: false };
    const cancelTransport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => {
        leaseCancel.lost = true;
        return freshSnapshot({ positionQty: 0, openOrders: [] });
      },
    });
    const cancelResult = await runHalt({
      id: idCancel,
      dir: dirCancel,
      state: evaluatedCancel.next,
      positionQty: 1,
      openOrders: [ownedOrder({ side: "buy" })],
      transport: cancelTransport,
      assertLeaseCurrent() {
        if (leaseCancel.lost) throw Object.assign(new Error("RUNTIME_LEASE_LOST"), localTransportNotSent("LEASE"));
      },
    });
    assert.equal(cancelTransport.flattenCalls, 0);
    assert.equal(cancelResult.verifiedFlat, false);
    assert.notEqual(cancelResult.state.haltStatus, "HALTED_FLAT");
    assert.equal(cancelResult.reseedAllowed, false);

    const dirFlat = tmpDir("c3-18-flat");
    const idFlat = "c3-18-flatten-recon";
    const runningFlat = seedRunning(idFlat, dirFlat);
    const evaluatedFlat = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      LIMITS,
      runningFlat
    );
    const leaseFlat = { lost: false };
    const flattenTransport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => {
        leaseFlat.lost = true;
        return freshSnapshot({ positionQty: 0 });
      },
      onFlatten() {
        leaseFlat.lost = true;
      },
    });
    const flattenResult = await runHalt({
      id: idFlat,
      dir: dirFlat,
      state: evaluatedFlat.next,
      positionQty: 0.0018,
      transport: flattenTransport,
      assertLeaseCurrent() {
        if (leaseFlat.lost) throw Object.assign(new Error("RUNTIME_LEASE_LOST"), localTransportNotSent("LEASE"));
      },
    });
    assert.equal(flattenTransport.flattenCalls, 1);
    assert.equal(flattenResult.verifiedFlat, false);
    assert.notEqual(flattenResult.state.haltStatus, "HALTED_FLAT");
    assert.equal(flattenResult.reseedAllowed, false);
  });

  it("C3-19 all prior B*, BC*, CB2*, C2*, Gate 0 and Checkpoint A tests remain present and green", () => {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    for (let i = 1; i <= 22; i += 1) {
      assert.match(src, new RegExp(`it\\("B${i}:`), `missing B${i}`);
    }
    for (let i = 1; i <= 13; i += 1) {
      assert.match(src, new RegExp(`it\\("BC${i}[ :]`), `missing BC${i}`);
    }
    for (let i = 1; i <= 9; i += 1) {
      assert.match(src, new RegExp(`it\\("CB2-${i} `), `missing CB2-${i}`);
    }
    for (let i = 1; i <= 11; i += 1) {
      assert.match(src, new RegExp(`it\\("C2-${i} `), `missing C2-${i}`);
    }
    for (let i = 1; i <= 19; i += 1) {
      assert.match(src, new RegExp(`it\\("C3-${i} `), `missing C3-${i}`);
    }
    const gate0 = fs.readFileSync(fileURLToPath(new URL("./experiment-ack-authority.test.ts", import.meta.url)), "utf8");
    const gate0Corrective = fs.readFileSync(fileURLToPath(new URL("./experiment-gate0-corrective.test.ts", import.meta.url)), "utf8");
    const checkpointA = fs.readFileSync(fileURLToPath(new URL("./experiment-v02-config.test.ts", import.meta.url)), "utf8");
    assert.match(gate0, /Gate 0 durable ACK authority/);
    assert.match(gate0Corrective, /Gate 0 Corrective 1/);
    assert.match(checkpointA, /Checkpoint A versioned v0\.2 configuration/);
    assert.ok(Number.isFinite(MAX_CLOCK_SKEW_MS));
  });
});
