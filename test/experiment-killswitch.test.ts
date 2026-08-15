import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runExperimentKillSwitch } from "../src/experimentKillSwitch.js";
import { loadRiskState, persistRiskState, emptyRiskState } from "../src/experimentRisk.js";
import { withEnvAsync } from "./helpers/env.js";

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
    });

    assert.deepEqual(calls, ["cancelAll:BTC", "closePosition:BTC", "snapshot:BTC"]);
    assert.equal(result.cancelOk, true);
    assert.equal(result.closeOk, false);
    assert.equal(result.halted, true);
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
      });
      assert.equal(again.halted, true);
      assert.equal(loadRiskState(id, dir).halted, true);
    });
  });
});
