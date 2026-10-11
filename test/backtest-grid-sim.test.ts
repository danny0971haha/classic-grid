import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectedOwnedClientOrderId, planFromFillsAndSeed, replacementFor } from "../src/grid.js";
import type { LiveOrder, PlannerReplacementObligation, Side } from "../src/types.js";
import { anchorFor, botPlacements, simulate, V01_PROFILE, type Candle, type SimConfig } from "../tools/backtest/grid-sim.js";

const CFG: SimConfig = { ...V01_PROFILE, strategy: "classic", makerFee: 0, takerFee: 0 };

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const candle = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t: t * 60_000, o, h, l, c });

describe("backtest grid-sim", () => {
  it("bot placement model matches planFromFillsAndSeed on random states", () => {
    const grid = anchorFor(CFG, 83_000);
    const prefix = "cgx-";
    const epoch = 7;
    const rand = rng(42);
    for (let trial = 0; trial < 500; trial++) {
      const mid = grid.lower - grid.spacing + rand() * (grid.upper - grid.lower + 2 * grid.spacing);
      const open: LiveOrder[] = [];
      for (let level = 0; level < grid.levels.length; level++) {
        if (rand() < 0.5) continue;
        const side: Side = rand() < 0.5 ? "buy" : "sell";
        open.push({
          id: `o-${level}`,
          market: "BTC-USD",
          side,
          price: grid.levels[level]!,
          size: grid.size,
          level,
          clientOrderId: expectedOwnedClientOrderId(prefix, epoch, side, level),
        });
      }
      const occupied = new Set(open.map((o) => o.level));
      const empty = grid.levels.map((_, i) => i).filter((i) => !occupied.has(i));
      const filled: Array<{ side: Side; levelIndex: number }> = [];
      const obligations: PlannerReplacementObligation[] = [];
      if (empty.length > 0 && rand() < 0.7) {
        const fill = { side: (rand() < 0.5 ? "buy" : "sell") as Side, levelIndex: empty[Math.floor(rand() * empty.length)]! };
        const target = replacementFor(fill, grid.levels, "neutral");
        filled.push(fill);
        if (target) {
          const token = trial.toString(16).padStart(16, "0");
          obligations.push({
            obligationId: `obl-${trial}`,
            sourceDedupeKey: `fill-${trial}`,
            targetSide: target.side,
            targetLevelIndex: target.levelIndex,
            outstandingQuantity: grid.size,
            placementQuantity: grid.size,
            replacementClientOrderId: `${expectedOwnedClientOrderId(prefix, epoch, target.side, target.levelIndex)}-r-${token}`,
            lifecycle: "READY",
          });
        }
      }

      const plan = planFromFillsAndSeed({
        market: "BTC-USD",
        mid,
        levels: grid.levels,
        spacing: grid.spacing,
        mode: "neutral",
        sizeBase: grid.size,
        openOrders: open,
        prevActive: new Map(),
        maxWrites: 40,
        seeded: true,
        skipBand: CFG.skipBand,
        ownershipPrefix: prefix,
        anchorEpoch: epoch,
        replacementObligations: obligations,
      });
      assert.equal(plan.plannerDisposition, "CLEAR");
      const real = plan.intents
        .map((i) => {
          assert.equal(i.type, "place");
          return i.type === "place" ? `${i.order.side}@${i.order.level}` : "";
        })
        .sort();
      const model = botPlacements({ levels: grid.levels, spacing: grid.spacing, skipBand: CFG.skipBand, mid, occupied, filled })
        .map((r) => `${r.side}@${r.levelIndex}`)
        .sort();
      assert.deepEqual(model, real, `trial ${trial} mid=${mid}`);
    }
  });

  it("fills only when the candle trades through the level and charges funding by position sign", () => {
    // anchor at 100: spacing 0.5, size 0.125, buys 97..99.5, sells 100.5..103
    const touch = simulate([candle(0, 100, 100, 99.5, 99.8)], [], CFG);
    assert.equal(touch.fills, 0);

    const through = simulate(
      [candle(0, 100, 100, 99.5, 99.8), candle(1, 99.8, 99.8, 99.49, 99.6), candle(2, 99.6, 99.7, 99.55, 99.6)],
      [{ t: 2 * 60_000, rate: 0.01 }],
      CFG
    );
    assert.equal(through.fills, 1);
    assert.ok(Math.abs(through.fundingUsd - -0.125 * 99.6 * 0.01) < 1e-12);
  });

  it("classic grid oscillation books one spacing per round trip minus maker fees", () => {
    const candles: Candle[] = [];
    let t = 0;
    for (let i = 0; i < 10; i++) {
      candles.push(candle(t++, 100, 100, 99.4, 99.6)); // buy 99.5 fills
      candles.push(candle(t++, 99.6, 100.1, 99.6, 100)); // sell 100 fills
    }
    const fee = 0.0002;
    const res = simulate(candles, [], { ...CFG, makerFee: fee });
    assert.equal(res.fills, 20);
    assert.ok(Math.abs(res.realizedUsd - 10 * 0.5 * 0.125) < 1e-9);
    assert.ok(Math.abs(res.feesUsd - 10 * (99.5 + 100) * 0.125 * fee) < 1e-9);
    assert.equal(res.halts.length, 0);
  });

  it("boundary breach flattens at the close with taker fee and re-anchors on the next candle", () => {
    const candles: Candle[] = [candle(0, 100, 100, 95.9, 95.9), candle(1, 95.9, 96, 95.8, 95.9)];
    const res = simulate(candles, [], { ...CFG, takerFee: 0.001 });
    assert.equal(res.halts.length, 1);
    assert.deepEqual(res.halts[0]!.reasons, ["RISK_BOUNDARY_BREACH"]);
    assert.ok(Math.abs(res.halts[0]!.closedQty - 6 * 0.125) < 1e-9);
    // six buys 97..99.5 (avg 98.25) closed at 95.9 plus 0.1% taker
    assert.ok(Math.abs(res.halts[0]!.closePnlUsd - (0.75 * (95.9 - 98.25) - 0.75 * 95.9 * 0.001)) < 1e-9);
    assert.equal(res.anchors, 2);
    assert.equal(res.unrealizedUsd, 0);
  });
});
