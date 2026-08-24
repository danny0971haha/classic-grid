import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareOpaqueString,
  comparePlannerOrders,
  expectedOwnedClientOrderId,
  PLANNER_PRICE_TOLERANCE_SPACING_FRAC,
  PLANNER_SIZE_TOLERANCE_FRAC,
  PLANNER_SIZE_TOLERANCE_MIN,
  planFromFillsAndSeed,
  plannerSizeTolerance,
} from "../src/grid.js";
import type { Intent, LiveOrder, PlannerDiagnostic } from "../src/types.js";
import { ExtendedExecutor } from "../src/venues/extended.js";

const MARKET = "BTC";
const PREFIX = "cg:test:";
const EPOCH = 42;
const LEVELS = [99_000, 100_000, 101_000];
const SPACING = 1_000;
const SIZE = 0.001;
const HERE = fileURLToPath(import.meta.url);

function cid(side: "buy" | "sell", level: number, epoch = EPOCH): string {
  return expectedOwnedClientOrderId(PREFIX, epoch, side, level);
}

function live(p: {
  id: string;
  side?: "buy" | "sell";
  level?: number;
  price?: number;
  size?: number;
  market?: string;
  clientOrderId?: string | undefined;
  exchangeOrderId?: string;
}): LiveOrder {
  const side = p.side ?? "buy";
  const level = p.level ?? 0;
  return {
    id: p.id,
    market: p.market ?? MARKET,
    side,
    price: p.price ?? LEVELS[level]!,
    size: p.size ?? SIZE,
    level,
    clientOrderId: p.clientOrderId === undefined ? cid(side, level) : p.clientOrderId,
    ...(p.exchangeOrderId !== undefined ? { exchangeOrderId: p.exchangeOrderId } : {}),
  };
}

function plan(openOrders: LiveOrder[], extra: Record<string, unknown> = {}) {
  return planFromFillsAndSeed({
    market: MARKET,
    mid: 100_000,
    levels: LEVELS,
    spacing: SPACING,
    mode: "neutral",
    sizeBase: SIZE,
    openOrders,
    prevActive: new Map(),
    maxWrites: 10,
    seeded: true,
    ownershipPrefix: PREFIX,
    anchorEpoch: EPOCH,
    ...extra,
  });
}

function serializePlan(result: ReturnType<typeof planFromFillsAndSeed>): string {
  return JSON.stringify({
    intents: result.intents,
    nextActive: [...result.nextActive.entries()],
    filled: result.filled,
    completedRungs: result.completedRungs,
    diagnostics: result.diagnostics,
  });
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) out.push([items[i]!, ...perm]);
  }
  return out;
}

function cancelIds(intents: Intent[]): string[] {
  return intents.filter((i) => i.type === "cancel").map((i) => i.orderId);
}

function placeLevels(intents: Intent[]): number[] {
  return intents.filter((i) => i.type === "place").map((i) => i.order.level);
}

function assertNoFill(result: ReturnType<typeof planFromFillsAndSeed>): void {
  assert.deepEqual(result.filled, []);
  assert.equal(result.completedRungs, 0);
}

function codes(diagnostics: PlannerDiagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

describe("Checkpoint D planner dedup", () => {
  it("D-01 every permutation of the same valid duplicate set selects the same survivor", () => {
    const orders = [
      live({ id: "id-c", exchangeOrderId: "ex-c", side: "buy", level: 0 }),
      live({ id: "id-a", exchangeOrderId: "ex-a", side: "buy", level: 0 }),
      live({ id: "id-b", exchangeOrderId: "ex-b", side: "buy", level: 0 }),
    ];
    const expectedSurvivor = [...orders].sort(comparePlannerOrders)[0]!.id;
    assert.equal(expectedSurvivor, "id-a");
    const serialized = new Set<string>();
    for (const openOrders of permutations(orders)) {
      const result = plan(openOrders);
      assertNoFill(result);
      assert.deepEqual([...result.nextActive.keys()], [expectedSurvivor]);
      assert.deepEqual(cancelIds(result.intents), ["id-b", "id-c"]);
      serialized.add(serializePlan(result));
    }
    assert.equal(serialized.size, 1);
  });

  it("D-02 numeric-looking opaque IDs are not ordered with Number()", () => {
    assert.equal(Number("2") < Number("10"), true);
    assert.equal(Number("0010"), Number("10"));
    assert.equal(compareOpaqueString("0010", "10") < 0, true);
    assert.equal(compareOpaqueString("10", "2") < 0, true);
    const orders = [
      live({ id: "2", exchangeOrderId: "2", side: "buy", level: 0 }),
      live({ id: "10", exchangeOrderId: "10", side: "buy", level: 0 }),
      live({ id: "0010", exchangeOrderId: "0010", side: "buy", level: 0 }),
    ];
    for (const openOrders of permutations(orders)) {
      const result = plan(openOrders);
      assert.deepEqual([...result.nextActive.keys()], ["0010"]);
      assert.deepEqual(cancelIds(result.intents), ["10", "2"]);
      assert.equal(result.intents.some((i) => i.type === "cancel" && i.orderId === "0010"), false);
    }
  });

  it("D-03 valid current order plus malformed owned duplicate retains valid and cancels malformed", () => {
    const valid = live({ id: "keep", exchangeOrderId: "ex-keep", side: "buy", level: 0 });
    const malformed = live({
      id: "drop",
      exchangeOrderId: "ex-drop",
      side: "buy",
      level: 0,
      size: SIZE * 4,
    });
    const result = plan([malformed, valid]);
    assertNoFill(result);
    assert.deepEqual([...result.nextActive.keys()], ["keep"]);
    assert.deepEqual(cancelIds(result.intents), ["drop"]);
    assert.ok(codes(result.diagnostics).includes("MALFORMED_OWNED"));
  });

  it("D-04 multiple valid duplicates retain one survivor and cancel the rest in comparator order", () => {
    const orders = [
      live({ id: "z", exchangeOrderId: "z", side: "buy", level: 0 }),
      live({ id: "m", exchangeOrderId: "m", side: "buy", level: 0 }),
      live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 }),
    ];
    const result = plan(orders);
    assert.deepEqual([...result.nextActive.keys()], ["a"]);
    assert.deepEqual(cancelIds(result.intents), ["m", "z"]);
    assert.equal(result.nextActive.size, 1);
  });

  it("D-05 all owned orders malformed: cancel proven targets and do not reseed that slot", () => {
    const orders = [
      live({ id: "bad-b", exchangeOrderId: "bad-b", side: "buy", level: 0, size: SIZE * 3 }),
      live({ id: "bad-a", exchangeOrderId: "bad-a", side: "buy", level: 0, size: SIZE * 3 }),
    ];
    const result = plan(orders);
    assertNoFill(result);
    assert.equal(result.nextActive.size, 0);
    assert.deepEqual(cancelIds(result.intents), ["bad-a", "bad-b"]);
    assert.equal(placeLevels(result.intents).includes(0), false);
    assert.ok(result.intents.every((i) => i.type !== "place" || i.order.level !== 0));
  });

  it("D-06 unowned/manual orders are never cancelled and never enter nextActive", () => {
    const manual = live({
      id: "manual",
      side: "buy",
      level: 0,
      clientOrderId: "manual-bot-1",
    });
    const result = plan([manual]);
    assertNoFill(result);
    assert.equal(cancelIds(result.intents).includes("manual"), false);
    assert.equal(result.nextActive.has("manual"), false);
    assert.ok(codes(result.diagnostics).includes("UNOWNED_BLOCKS_SLOT"));
  });

  it("D-07 same-price unowned order is not a cancel target and stays conservative", () => {
    const owned = live({ id: "owned", exchangeOrderId: "owned", side: "buy", level: 0 });
    const manual = live({
      id: "manual",
      side: "buy",
      level: 0,
      clientOrderId: "someone-else",
    });
    const result = plan([manual, owned]);
    assertNoFill(result);
    assert.deepEqual([...result.nextActive.keys()], ["owned"]);
    assert.equal(cancelIds(result.intents).includes("manual"), false);
    assert.equal(result.nextActive.has("manual"), false);
    assert.equal(placeLevels(result.intents).includes(0), false);
  });

  it("D-08 AMBIGUOUS / missing identity is not cancelled, claimed, or reseeded", () => {
    const missing = live({
      id: "",
      side: "buy",
      level: 0,
    });
    const result = plan([missing]);
    assertNoFill(result);
    assert.equal(result.intents.some((i) => i.type === "cancel"), false);
    assert.equal(result.nextActive.size, 0);
    assert.equal(placeLevels(result.intents).includes(0), false);
    assert.ok(
      codes(result.diagnostics).includes("MISSING_CANCEL_IDENTITY") ||
        codes(result.diagnostics).includes("AMBIGUOUS_ORDER")
    );
  });

  it("D-09 buy/sell, different levels, and different markets are not merged", () => {
    const buy0 = live({ id: "buy0", exchangeOrderId: "buy0", side: "buy", level: 0 });
    const sell2 = live({ id: "sell2", exchangeOrderId: "sell2", side: "sell", level: 2 });
    const buy2 = live({ id: "buy2", exchangeOrderId: "buy2", side: "buy", level: 2, price: LEVELS[2] });
    const eth = live({
      id: "eth",
      exchangeOrderId: "eth",
      side: "buy",
      level: 0,
      market: "ETH",
    });
    const result = plan([eth, sell2, buy2, buy0]);
    assertNoFill(result);
    assert.deepEqual([...result.nextActive.keys()], ["buy0", "buy2", "sell2"]);
    assert.deepEqual(cancelIds(result.intents), ["eth"]);
    assert.equal(result.nextActive.has("eth"), false);
  });

  it("D-10 stale-epoch owned orders cancel; current-epoch valid order is retained", () => {
    const current = live({ id: "cur", exchangeOrderId: "cur", side: "buy", level: 0 });
    const stale = live({
      id: "old",
      exchangeOrderId: "old",
      side: "buy",
      level: 0,
      clientOrderId: cid("buy", 0, EPOCH - 1),
    });
    const result = plan([stale, current]);
    assertNoFill(result);
    assert.deepEqual([...result.nextActive.keys()], ["cur"]);
    assert.deepEqual(cancelIds(result.intents), ["old"]);
    assert.ok(codes(result.diagnostics).includes("STALE_EPOCH_OWNED"));
  });

  it("D-11 price tolerance is inclusive at the boundary and exclusive just outside", () => {
    const tol = SPACING * PLANNER_PRICE_TOLERANCE_SPACING_FRAC;
    const inside = live({
      id: "in",
      exchangeOrderId: "in",
      side: "buy",
      level: 0,
      price: LEVELS[0]! + tol,
    });
    const outside = live({
      id: "out",
      exchangeOrderId: "out",
      side: "buy",
      level: 0,
      price: LEVELS[0]! + tol + 1,
      clientOrderId: cid("buy", 0),
    });
    const inPlan = plan([inside]);
    assert.deepEqual([...inPlan.nextActive.keys()], ["in"]);
    assert.equal(cancelIds(inPlan.intents).includes("in"), false);
    const outPlan = plan([outside]);
    assert.equal(outPlan.nextActive.has("out"), false);
    assert.deepEqual(cancelIds(outPlan.intents), ["out"]);
    assert.ok(codes(outPlan.diagnostics).includes("MALFORMED_OWNED"));
  });

  it("D-12 size tolerance is inclusive at the boundary and exclusive just outside", () => {
    const tol = plannerSizeTolerance(SIZE);
    assert.equal(tol, Math.max(PLANNER_SIZE_TOLERANCE_MIN, SIZE * PLANNER_SIZE_TOLERANCE_FRAC));
    const inside = live({
      id: "in",
      exchangeOrderId: "in",
      side: "buy",
      level: 0,
      size: SIZE + tol,
    });
    const outside = live({
      id: "out",
      exchangeOrderId: "out",
      side: "buy",
      level: 0,
      size: SIZE + tol + tol,
    });
    const inPlan = plan([inside]);
    assert.deepEqual([...inPlan.nextActive.keys()], ["in"]);
    const outPlan = plan([outside]);
    assert.equal(outPlan.nextActive.has("out"), false);
    assert.deepEqual(cancelIds(outPlan.intents), ["out"]);
  });

  it("D-13 identical stable ID with identical fields is one observation and does not self-cancel", () => {
    const row = live({ id: "same", exchangeOrderId: "same", side: "buy", level: 0 });
    const result = plan([row, { ...row }, { ...row }]);
    assertNoFill(result);
    assert.deepEqual([...result.nextActive.keys()], ["same"]);
    assert.equal(cancelIds(result.intents).includes("same"), false);
    assert.equal(result.intents.filter((i) => i.type === "cancel" && i.orderId === "same").length, 0);
  });

  it("D-14 same stable ID with conflicting fields requires reconciliation and does not place that slot", () => {
    const a = live({ id: "same", exchangeOrderId: "same", side: "buy", level: 0, size: SIZE });
    const b = live({ id: "same", exchangeOrderId: "same", side: "buy", level: 0, size: SIZE * 2 });
    const result = plan([a, b]);
    assertNoFill(result);
    assert.equal(result.nextActive.size, 0);
    assert.equal(result.intents.some((i) => i.type === "cancel" && i.orderId === "same"), false);
    assert.equal(placeLevels(result.intents).includes(0), false);
    assert.ok(codes(result.diagnostics).includes("RECONCILIATION_REQUIRED"));
  });

  it("D-15 maxWritesPerTick 1/2/3 emits the same cancel subset and cancels before place", () => {
    const orders = [
      live({ id: "z", exchangeOrderId: "z", side: "buy", level: 0 }),
      live({ id: "m", exchangeOrderId: "m", side: "buy", level: 0 }),
      live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 }),
    ];
    const expectedCancels = ["m", "z"];
    for (const maxWrites of [1, 2, 3] as const) {
      const first = serializePlan(plan(orders, { maxWrites }));
      for (const openOrders of permutations(orders)) {
        assert.equal(serializePlan(plan(openOrders, { maxWrites })), first);
      }
      const result = plan(orders, { maxWrites });
      const kinds = result.intents.map((i) => i.type);
      const firstPlace = kinds.indexOf("place");
      const lastCancel = kinds.lastIndexOf("cancel");
      if (firstPlace >= 0 && lastCancel >= 0) assert.ok(lastCancel < firstPlace);
      assert.deepEqual(cancelIds(result.intents), expectedCancels.slice(0, maxWrites));
      if (maxWrites < expectedCancels.length) {
        assert.equal(result.intents.some((i) => i.type === "place"), false);
      }
    }
  });

  it("D-16 maxOpenOrders counts unowned orders and does not claim them as owned", () => {
    const unowned = [
      live({ id: "u1", side: "buy", level: 0, clientOrderId: "manual-1" }),
      live({ id: "u2", side: "sell", level: 2, clientOrderId: "manual-2" }),
    ];
    const result = plan(unowned, { maxOpenOrders: 2 });
    assert.equal(result.intents.some((i) => i.type === "place"), false);
    assert.equal(result.intents.some((i) => i.type === "cancel"), false);
    assert.equal(result.nextActive.size, 0);
    const mixed = plan(
      [unowned[0]!, live({ id: "owned", exchangeOrderId: "owned", side: "sell", level: 2 })],
      { maxOpenOrders: 2 }
    );
    assert.deepEqual([...mixed.nextActive.keys()], ["owned"]);
    assert.equal(mixed.nextActive.has("u1"), false);
    assert.equal(cancelIds(mixed.intents).includes("u1"), false);
    assert.equal(mixed.intents.some((i) => i.type === "place"), false);
  });

  it("D-17 the same canonical input serializes identically across 100 invocations", () => {
    const orders = [
      live({ id: "10", exchangeOrderId: "10", side: "buy", level: 0 }),
      live({ id: "0010", exchangeOrderId: "0010", side: "buy", level: 0 }),
      live({ id: "manual", side: "sell", level: 2, clientOrderId: "manual" }),
    ];
    const first = serializePlan(plan(orders));
    for (let i = 0; i < 100; i++) {
      assert.equal(serializePlan(plan(orders)), first);
    }
  });

  it("D-18 planner dedup never emits FILL and keeps completedRungs at 0", () => {
    const gonePrev = new Map([
      ["gone", { levelIndex: 2, side: "sell" as const, price: 101_000, size: SIZE }],
    ]);
    const result = plan(
      [
        live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 }),
        live({ id: "b", exchangeOrderId: "b", side: "buy", level: 0 }),
      ],
      { prevActive: gonePrev }
    );
    assertNoFill(result);
    const src = fs.readFileSync(new URL("../src/grid.ts", import.meta.url), "utf8");
    assert.match(src, /Never infers FILL from disappearance/);
    assert.doesNotMatch(src, /Number\(o\.id\)|Number\(o\.exchangeOrderId\)|Number\(.*orderId/);
    assert.doesNotMatch(src, /\.localeCompare\s*\(/);
  });

  it("D-19 Checkpoint C journal, cursor persistence, and C-C16..C-C24 remain", () => {
    const execution = fs.readFileSync(
      new URL("./experiment-v02-execution.test.ts", import.meta.url),
      "utf8"
    );
    const stream = fs.readFileSync(
      new URL("../src/venues/extendedAccountStream.ts", import.meta.url),
      "utf8"
    );
    const loop = fs.readFileSync(new URL("../src/loop.ts", import.meta.url), "utf8");
    for (const name of [
      "C-C16",
      "C-C17",
      "C-C18",
      "C-C19",
      "C-C20",
      "C-C21",
      "C-C22",
      "C-C23",
      "C-C24",
    ]) {
      assert.match(execution, new RegExp(`it\\("${name} `));
    }
    assert.match(stream, /persistCursor/);
    assert.match(stream, /COMMITTED/);
    assert.match(stream, /PRE_RENAME_FAILURE/);
    assert.match(stream, /cursorFailedClosed/);
    assert.match(stream, /authoritativeExecutions/);
    assert.match(loop, /filterRiskIncreasingIntents/);
    assert.match(loop, /assertExperimentLeaseCurrent/);
    assert.match(loop, /maxWritesPerTick/);
    assert.match(loop, /ORDER_DISAPPEARED/);
    assert.match(loop, /drainExecutionJournal/);
    assert.match(loop, /resolveExecutionCursorPath/);
    assert.doesNotMatch(loop, /for \(const f of plan\.filled\)/);
  });

  it("D-20 prior node:test files and grid.test.ts remain registered", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const testScript = String(pkg.scripts.test);
    for (const file of [
      "test/grid.test.ts",
      "test/experiment-config.test.ts",
      "test/experiment-v02-config.test.ts",
      "test/experiment-risk.test.ts",
      "test/experiment-ack-authority.test.ts",
      "test/experiment-gate0-corrective.test.ts",
      "test/experiment-telemetry.test.ts",
      "test/experiment-killswitch.test.ts",
      "test/experiment-resume.test.ts",
      "test/experiment-storage.test.ts",
      "test/runtime-lease.test.ts",
      "test/extended-observation.test.ts",
      "test/experiment-v02-reduction.test.ts",
      "test/experiment-v02-execution.test.ts",
      "test/experiment-v02-planner-dedup.test.ts",
    ]) {
      assert.ok(testScript.includes(file), file);
    }
  });

  it("D-21 dry-run performs zero network mutation / zero live write", async () => {
    const gridSrc = fs.readFileSync(new URL("../src/grid.ts", import.meta.url), "utf8");
    assert.doesNotMatch(gridSrc, /\bfetch\s*\(/);
    assert.doesNotMatch(gridSrc, /WebSocket/);
    assert.doesNotMatch(HERE, /LIVE_CONFIRM|API_SECRET|PRIVATE_KEY/);
    const executor = new ExtendedExecutor(true);
    await executor.connect();
    const result = plan([
      live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 }),
      live({ id: "b", exchangeOrderId: "b", side: "buy", level: 0 }),
    ]);
    const applied = await executor.apply(result.intents);
    assert.equal(applied.failed, 0);
    const drain = executor.drainExecutionJournal?.();
    assert.equal(drain?.executions.length ?? 0, 0);
    executor.disconnect();
  });
});
