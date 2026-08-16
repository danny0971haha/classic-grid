import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadSoftResumeAnchors, persistSoftResumeAnchor } from "../src/softResume.js";
import { buildGrid, planFromFillsAndSeed, seedOrders } from "../src/grid.js";
import { anchorGrid, loadRuntimeConfig } from "../src/config.js";
import { withEnv } from "./helpers/env.js";

describe("soft-resume regression", () => {
  it("preserves saved anchor and does not duplicate logical grid orders", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-resume-"));
    persistSoftResumeAnchor({
      experimentId: "classic-dryrun-001",
      scopeKey: "extended:BTC",
      leaseGeneration: "test-lease",
      venue: "extended",
      anchor: { anchorMid: 100_000, gridCount: 12, anchorEpoch: 1234 },
      baseDir: dir,
    });

    const anchors = withEnv({ SOFT_RESUME: "1" }, () => loadSoftResumeAnchors({
      experimentId: "classic-dryrun-001",
      scopeKey: "extended:BTC",
      baseDir: dir,
    }));
    assert.equal(anchors.extended?.anchorMid, 100_000);

    const cfg = withEnv(
      {
        EXPERIMENT_MODE: "1",
        EXPERIMENT_ID: "classic-dryrun-001",
      },
      () => loadRuntimeConfig()
    );
    const liveMid = 101_200;
    const midForAnchor = anchors.extended!.anchorMid;
    const anchored = anchorGrid(cfg.grids.extended, midForAnchor);
    assert.ok(Math.abs(anchored.lower - 97_000) < 1e-6);
    assert.equal(anchored.gridCount, 12);
    assert.ok(Math.abs(liveMid - midForAnchor) > 1);

    const built = buildGrid({
      lower: anchored.lower,
      upper: anchored.upper,
      gridCount: anchored.gridCount,
    });
    const seeds = seedOrders({
      levels: built.levels,
      price: midForAnchor,
      mode: "neutral",
      spacing: built.spacing,
      skipBand: anchored.skipBand,
    });
    const openOrders = seeds.map((s, i) => ({
      id: `o${i}`,
      market: "BTC",
      side: s.side,
      price: s.price,
      size: anchored.sizeBase,
      level: s.levelIndex,
    }));

    const plan = planFromFillsAndSeed({
      market: "BTC",
      mid: liveMid,
      levels: built.levels,
      spacing: built.spacing,
      mode: "neutral",
      sizeBase: anchored.sizeBase,
      openOrders,
      prevActive: new Map(),
      maxWrites: 40,
      seeded: true,
      skipBand: anchored.skipBand,
    });

    const placeLevels = plan.intents
      .filter((i) => i.type === "place")
      .map((i) => (i.type === "place" ? i.order.level : -1));
    const occupied = new Set(openOrders.map((o) => o.level));
    for (const level of placeLevels) {
      assert.equal(occupied.has(level), false, `duplicate place at level ${level}`);
    }
    const byLevel = new Map<number, number>();
    for (const o of openOrders) byLevel.set(o.level, (byLevel.get(o.level) || 0) + 1);
    for (const [level, n] of byLevel) {
      assert.equal(n, 1, `open orders already duplicate at ${level}`);
    }
  });
});
