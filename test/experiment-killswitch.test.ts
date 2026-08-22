import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runExperimentKillSwitch } from "../src/experimentKillSwitch.js";
import {
  acknowledgeDurableHalt,
  emptyRiskState,
  isForcedHaltInMemoryOnly,
  loadRiskState,
  persistRiskState,
} from "../src/experimentRisk.js";
import { withEnv, withEnvAsync } from "./helpers/env.js";

describe("experiment kill switch", () => {
  it("cancels, flattens, verifies snapshot, and persists HALTED even if close fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-halt-"));
    const id = "classic-dryrun-001";
    persistRiskState(id, emptyRiskState(), dir);

    const calls: string[] = [];
    const ex = {
      async cancelAll(market: string) {
        calls.push(`cancelAll:${market}`);
      },
      async closePosition(market: string) {
        calls.push(`closePosition:${market}`);
        throw new Error("close failed");
      },
      async snapshot(market: string) {
        calls.push(`snapshot:${market}`);
        return {
          venue: "extended" as const,
          market,
          mid: 100_000,
          position: 0.01,
          openOrders: [{ id: "1", market, side: "buy" as const, price: 99_000, size: 0.01, level: 1 }],
        };
      },
    };

    const result = await runExperimentKillSwitch({
      ex,
      market: "BTC",
      reasons: ["DAILY_LOSS"],
      experimentId: id,
      baseDir: dir,
      maxAttempts: 1,
      retryDelayMs: 0,
    });

    assert.deepEqual(calls, ["cancelAll:BTC", "closePosition:BTC", "snapshot:BTC"]);
    assert.equal(result.cancelOk, true);
    assert.equal(result.closeOk, false);
    assert.equal(result.halted, true);
    assert.equal(result.flat, false);
    assert.equal(result.status, "HALTED_UNFLAT");
    const persisted = loadRiskState(id, dir);
    assert.equal(persisted.halted, true);
    assert.ok(persisted.haltReasons.includes("DAILY_LOSS"));

    await withEnvAsync({ EXPERIMENT_HALT_ACK: undefined }, async () => {
      const again = await runExperimentKillSwitch({
        ex: {
          ...ex,
          async closePosition() {
            /* now succeeds */
          },
        },
        market: "BTC",
        reasons: ["DAILY_LOSS"],
        experimentId: id,
        baseDir: dir,
        maxAttempts: 1,
        retryDelayMs: 0,
      });
      assert.equal(again.halted, true);
      assert.equal(loadRiskState(id, dir).halted, true);
    });
  });

  it("continues liquidation and reaches HALTED_FLAT when telemetry throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-halt-telemetry-"));
    let position = 0.01;
    let orders = 1;
    const result = await runExperimentKillSwitch({
      ex: {
        async cancelAll() { orders = 0; },
        async closePosition() { position = 0; },
        async snapshot(market: string) {
          return { venue: "extended" as const, market, mid: 100_000, position, openOrders: orders ? [{ id: "x", market, side: "buy" as const, price: 1, size: 1, level: 1 }] : [] };
        },
      },
      market: "BTC",
      reasons: ["TEST"],
      experimentId: "telemetry-throw-001",
      baseDir: dir,
      retryDelayMs: 0,
      onEvent() { throw new Error("disk full"); },
    });
    assert.equal(result.flat, true);
    assert.equal(result.status, "HALTED_FLAT");
    assert.ok(result.state.haltId && result.state.haltId.length > 0);
    assert.equal(loadRiskState("telemetry-throw-001", dir).haltId, result.state.haltId);
  });

  it("G0-KS-HALTID: mints a unique haltId in memory before persist and preserves it across the lifecycle", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-ks-haltid-"));
    const id = "ks-haltid-001";
    persistRiskState(id, emptyRiskState("extended:BTC"), dir);
    let position = 0.01;
    let orders = 1;
    const result = await runExperimentKillSwitch({
      ex: {
        async cancelAll() { orders = 0; },
        async closePosition() { position = 0; },
        async snapshot(market: string) {
          return { venue: "extended" as const, market, mid: 100_000, position, openOrders: orders ? [{ id: "x", market, side: "buy" as const, price: 1, size: 1, level: 1 }] : [] };
        },
      },
      market: "BTC",
      reasons: ["DAILY_LOSS"],
      experimentId: id,
      baseDir: dir,
      retryDelayMs: 0,
    });
    assert.equal(result.halted, true);
    assert.equal(result.status, "HALTED_FLAT");
    assert.equal(typeof result.state.haltId, "string");
    assert.ok(result.state.haltId && result.state.haltId.length > 0);
    assert.equal(result.state.acknowledged, false);
    const persisted = loadRiskState(id, dir, "extended:BTC");
    assert.equal(persisted.haltId, result.state.haltId);
    assert.equal(persisted.haltStatus, "HALTED_FLAT");
  });

  it("G0-KS-PERSIST-FAIL: persistence failure latches FORCED_HALT_IN_MEMORY_ONLY and still flattens", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-ks-persist-fail-"));
    const id = "ks-persist-fail-001";
    persistRiskState(id, emptyRiskState("extended:BTC"), dir);
    const primary = path.join(dir, id, "risk-state.json");
    let writes = 0;
    let cancelCalls = 0;
    let closeCalls = 0;
    const result = await runExperimentKillSwitch({
      ex: {
        async cancelAll() { cancelCalls += 1; },
        async closePosition() { closeCalls += 1; },
        async snapshot(market: string) {
          return { venue: "extended" as const, market, mid: 100_000, position: 0, openOrders: [] };
        },
      },
      market: "BTC",
      reasons: ["DAILY_LOSS"],
      experimentId: id,
      baseDir: dir,
      retryDelayMs: 0,
      persistOptions: {
        onAtomicWriteStep(step, target) {
          if (target === primary && step === "BEFORE_RENAME") {
            writes += 1;
            if (writes === 1) throw new Error("HALTING persist failed");
          }
        },
      },
    });
    assert.equal(cancelCalls, 1);
    assert.equal(closeCalls, 1);
    assert.equal(result.halted, true);
    assert.ok(result.state.haltId && result.state.haltId.length > 0);
    assert.ok(
      result.state.haltReasons.includes("FORCED_HALT_IN_MEMORY_ONLY")
      || result.errors.some((e) => /persist HALTING|FORCED_HALT|HALTING persist failed/i.test(e))
    );
    assert.equal(isForcedHaltInMemoryOnly(id), true);
    const ack = withEnv({ EXPERIMENT_HALT_ACK: result.state.haltId! }, () =>
      acknowledgeDurableHalt(id, result.state, dir)
    );
    assert.equal(ack.accepted, false);
    const durable = loadRiskState(id, dir, "extended:BTC");
    assert.notEqual(durable.haltStatus, "RUNNING");
  });

  it("G0-KS-IDENTITY-PRESERVE: HALTING → HALTED_UNFLAT keeps the same haltId", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-ks-preserve-"));
    const id = "ks-preserve-001";
    persistRiskState(id, emptyRiskState("extended:BTC"), dir);
    const first = await runExperimentKillSwitch({
      ex: {
        async cancelAll() {},
        async closePosition() { throw new Error("still open"); },
        async snapshot(market: string) {
          return {
            venue: "extended" as const,
            market,
            mid: 100_000,
            position: 0.01,
            openOrders: [{ id: "1", market, side: "buy" as const, price: 99_000, size: 0.01, level: 1 }],
          };
        },
      },
      market: "BTC",
      reasons: ["DAILY_LOSS"],
      experimentId: id,
      baseDir: dir,
      maxAttempts: 1,
      retryDelayMs: 0,
    });
    assert.equal(first.status, "HALTED_UNFLAT");
    const incident = first.state.haltId;
    assert.ok(incident);
    const second = await runExperimentKillSwitch({
      ex: {
        async cancelAll() {},
        async closePosition() {},
        async snapshot(market: string) {
          return { venue: "extended" as const, market, mid: 100_000, position: 0, openOrders: [] };
        },
      },
      market: "BTC",
      reasons: ["DAILY_LOSS"],
      experimentId: id,
      baseDir: dir,
      maxAttempts: 1,
      retryDelayMs: 0,
    });
    assert.equal(second.state.haltId, incident);
    assert.equal(loadRiskState(id, dir, "extended:BTC").haltId, incident);
  });
});
