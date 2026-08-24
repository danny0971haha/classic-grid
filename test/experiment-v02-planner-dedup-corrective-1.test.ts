import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyPlannerIntentGate as applyPlannerIntentGateFromGrid,
  expectedOwnedClientOrderId,
  planFromFillsAndSeed,
} from "../src/grid.js";
import { applyPlannerIntentGate } from "../src/loop.js";
import type { Intent, LiveOrder, PlannerDiagnostic } from "../src/types.js";

const MARKET = "BTC";
const PREFIX = "cg:test:";
const EPOCH = 42;
const LEVELS = [99_000, 100_000, 101_000];
const SPACING = 1_000;
const SIZE = 0.001;

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
    currentSnapshotVenueCount: result.currentSnapshotVenueCount,
    plannedCancelCount: result.plannedCancelCount,
    capacityAfterAuthoritativeSnapshot: result.capacityAfterAuthoritativeSnapshot,
    plannerDisposition: result.plannerDisposition,
    riskIncreaseBlocked: result.riskIncreaseBlocked,
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

function placeCount(intents: Intent[]): number {
  return intents.filter((i) => i.type === "place").length;
}

function codes(diagnostics: PlannerDiagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

describe("Checkpoint D corrective 1 capacity and reconciliation", () => {
  it("D-C1-01 maxOpenOrders equal to visible count yields zero place even with duplicate cancel", () => {
    const orders = [
      live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 }),
      live({ id: "m", exchangeOrderId: "m", side: "buy", level: 0 }),
    ];
    const result = plan(orders, { maxOpenOrders: 2 });
    assert.equal(result.currentSnapshotVenueCount, 2);
    assert.equal(result.plannedCancelCount, 1);
    assert.equal(result.capacityAfterAuthoritativeSnapshot, 0);
    assert.equal(result.plannerDisposition, "CLEAR");
    assert.equal(result.riskIncreaseBlocked, false);
    assert.deepEqual(cancelIds(result.intents), ["m"]);
    assert.equal(placeCount(result.intents), 0);
  });

  it("D-C1-02 cancel candidate still occupies the only extra hole", () => {
    const orders = [
      live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 }),
      live({ id: "m", exchangeOrderId: "m", side: "buy", level: 0 }),
    ];
    const result = plan(orders, { maxOpenOrders: 3 });
    assert.equal(result.currentSnapshotVenueCount, 2);
    assert.equal(result.plannedCancelCount, 1);
    assert.equal(result.capacityAfterAuthoritativeSnapshot, 1);
    assert.equal(placeCount(result.intents), 1);
    assert.equal(result.intents.some((i) => i.type === "place" && i.order.level === 0), false);
  });

  it("D-C1-03 only a later authoritative snapshot absence releases capacity", () => {
    const keep = live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 });
    const drop = live({ id: "m", exchangeOrderId: "m", side: "buy", level: 0 });
    const first = plan([keep, drop], { maxOpenOrders: 2 });
    assert.equal(first.currentSnapshotVenueCount, 2);
    assert.equal(first.capacityAfterAuthoritativeSnapshot, 0);
    assert.equal(placeCount(first.intents), 0);
    const afterAbsence = plan([keep], { maxOpenOrders: 2 });
    assert.equal(afterAbsence.currentSnapshotVenueCount, 1);
    assert.equal(afterAbsence.capacityAfterAuthoritativeSnapshot, 1);
    assert.equal(placeCount(afterAbsence.intents), 1);
    assert.equal(afterAbsence.intents.some((i) => i.type === "place" && i.order.level === 2), true);
  });

  it("D-C1-04 cancel REJECTED / UNKNOWN fixture does not release capacity", () => {
    const orders = [
      live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 }),
      live({ id: "m", exchangeOrderId: "m", side: "buy", level: 0 }),
    ];
    const afterIntent = plan(orders, { maxOpenOrders: 2 });
    assert.equal(afterIntent.plannedCancelCount, 1);
    const rejectedOrUnknown = plan(orders, { maxOpenOrders: 2 });
    assert.equal(rejectedOrUnknown.currentSnapshotVenueCount, 2);
    assert.equal(rejectedOrUnknown.capacityAfterAuthoritativeSnapshot, 0);
    assert.equal(placeCount(rejectedOrUnknown.intents), 0);
    const plannerSrc = fs.readFileSync(new URL("../src/grid.ts", import.meta.url), "utf8");
    assert.doesNotMatch(plannerSrc, /emittedCancelIds/);
    assert.doesNotMatch(plannerSrc, /cancelStatus|CANCEL_ACK|cancelAck/);
  });

  it("D-C1-05 unemitted cancel candidates still count toward capacity and keep the slot blocked", () => {
    const orders = [
      live({ id: "z", exchangeOrderId: "z", side: "buy", level: 0 }),
      live({ id: "m", exchangeOrderId: "m", side: "buy", level: 0 }),
      live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 }),
    ];
    const result = plan(orders, { maxWrites: 1, maxOpenOrders: 4 });
    assert.equal(result.currentSnapshotVenueCount, 3);
    assert.equal(result.plannedCancelCount, 1);
    assert.equal(result.capacityAfterAuthoritativeSnapshot, 1);
    assert.notEqual(result.capacityAfterAuthoritativeSnapshot, 2);
    assert.equal(placeCount(result.intents), 0);
    assert.deepEqual([...result.nextActive.keys()], ["a"]);
    assert.equal(result.intents.some((i) => i.type === "place" && i.order.level === 0), false);
  });

  it("D-C1-06 cross-market owned order is fail-closed Option A", () => {
    const eth = live({
      id: "eth",
      exchangeOrderId: "eth",
      side: "buy",
      level: 0,
      market: "ETH",
    });
    const result = plan([eth]);
    assert.equal(result.plannerDisposition, "RISK_INCREASE_BLOCKED");
    assert.equal(result.riskIncreaseBlocked, true);
    assert.equal(result.nextActive.size, 0);
    assert.equal(result.intents.length, 0);
    assert.equal(placeCount(result.intents), 0);
    assert.ok(codes(result.diagnostics).includes("CROSS_MARKET_OWNED_ORDER"));
    assert.equal(result.currentSnapshotVenueCount, 1);
  });

  it("D-C1-07 cross-market order never emits a cancel on p.market", () => {
    const eth = live({
      id: "eth",
      exchangeOrderId: "eth",
      side: "buy",
      level: 0,
      market: "ETH",
    });
    const owned = live({ id: "btc", exchangeOrderId: "btc", side: "sell", level: 2 });
    const result = plan([eth, owned]);
    assert.equal(
      result.intents.some((i) => i.type === "cancel" && i.orderId === "eth"),
      false
    );
    assert.equal(
      result.intents.some((i) => i.type === "cancel" && i.market === MARKET && i.orderId === "eth"),
      false
    );
    assert.equal(result.nextActive.has("eth"), false);
    assert.equal(placeCount(result.intents), 0);
    assert.equal(result.plannerDisposition, "RISK_INCREASE_BLOCKED");
  });

  it("D-C1-08 unlocatable ambiguous owned order blocks all new risk", () => {
    const row = live({
      id: "",
      side: "buy",
      price: 50_000,
      clientOrderId: `${PREFIX}zzzz`,
    });
    const result = plan([row]);
    assert.equal(result.plannerDisposition, "RISK_INCREASE_BLOCKED");
    assert.equal(result.riskIncreaseBlocked, true);
    assert.equal(placeCount(result.intents), 0);
    assert.equal(result.intents.some((i) => i.type === "cancel"), false);
    assert.equal(result.nextActive.size, 0);
    assert.ok(
      codes(result.diagnostics).includes("AMBIGUOUS_ORDER") ||
        codes(result.diagnostics).includes("MISSING_CANCEL_IDENTITY")
    );
  });

  it("D-C1-09 unlocatable same-ID conflict blocks place globally", () => {
    const a = live({
      id: "same",
      exchangeOrderId: "same",
      side: "buy",
      price: 50_000,
      size: SIZE,
      clientOrderId: `${PREFIX}nope`,
    });
    const b = live({
      id: "same",
      exchangeOrderId: "same",
      side: "buy",
      price: 50_000,
      size: SIZE * 2,
      clientOrderId: `${PREFIX}nope`,
    });
    const result = plan([a, b]);
    assert.equal(result.plannerDisposition, "RISK_INCREASE_BLOCKED");
    assert.equal(placeCount(result.intents), 0);
    assert.equal(result.nextActive.size, 0);
    assert.equal(result.intents.some((i) => i.type === "cancel"), false);
    assert.ok(codes(result.diagnostics).includes("RECONCILIATION_REQUIRED"));
  });

  it("D-C1-10 loop-level wiring consumes plannerDisposition from a real plan", () => {
    assert.equal(applyPlannerIntentGate, applyPlannerIntentGateFromGrid);
    const keep = live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 });
    const drop = live({ id: "m", exchangeOrderId: "m", side: "buy", level: 0 });
    const conflictA = live({
      id: "same",
      exchangeOrderId: "same",
      side: "buy",
      price: 50_000,
      size: SIZE,
      clientOrderId: `${PREFIX}nope`,
    });
    const conflictB = live({
      id: "same",
      exchangeOrderId: "same",
      side: "buy",
      price: 50_000,
      size: SIZE * 2,
      clientOrderId: `${PREFIX}nope`,
    });
    const planned = plan([keep, drop, conflictA, conflictB]);
    assert.equal(planned.plannerDisposition, "RISK_INCREASE_BLOCKED");
    assert.deepEqual(cancelIds(planned.intents), ["m"]);
    assert.equal(placeCount(planned.intents), 0);
    const gated = applyPlannerIntentGate(planned);
    assert.deepEqual(cancelIds(gated.intents), ["m"]);
    assert.equal(placeCount(gated.intents), 0);
    const injected = applyPlannerIntentGate({
      ...planned,
      intents: [
        ...planned.intents,
        {
          type: "place" as const,
          order: { market: MARKET, side: "sell" as const, price: 101_000, size: SIZE, level: 2 },
        },
      ],
    });
    assert.equal(placeCount(injected.intents), 0);
    assert.deepEqual(cancelIds(injected.intents), ["m"]);
    const loop = fs.readFileSync(new URL("../src/loop.ts", import.meta.url), "utf8");
    assert.match(loop, /applyPlannerIntentGate\s*\(\s*\n\s*planFromFillsAndSeed/);
  });

  it("D-C1-11 permutations stay byte-identical after disposition fields", () => {
    const orders = [
      live({ id: "z", exchangeOrderId: "z", side: "buy", level: 0 }),
      live({ id: "m", exchangeOrderId: "m", side: "buy", level: 0 }),
      live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 }),
      live({ id: "manual", side: "sell", level: 2, clientOrderId: "manual-bot" }),
    ];
    const serialized = new Set<string>();
    for (const openOrders of permutations(orders)) {
      serialized.add(serializePlan(plan(openOrders, { maxOpenOrders: 5 })));
    }
    assert.equal(serialized.size, 1);
    const sample = plan(orders, { maxOpenOrders: 5 });
    assert.equal(typeof sample.plannerDisposition, "string");
    assert.equal(typeof sample.riskIncreaseBlocked, "boolean");
    assert.equal(typeof sample.currentSnapshotVenueCount, "number");
    assert.equal(typeof sample.plannedCancelCount, "number");
  });

  it("D-C1-12 prior D-01..D-21, C-C16..C-C24, and the 301-test registration remain", () => {
    const prior = fs.readFileSync(
      new URL("./experiment-v02-planner-dedup.test.ts", import.meta.url),
      "utf8"
    );
    const execution = fs.readFileSync(
      new URL("./experiment-v02-execution.test.ts", import.meta.url),
      "utf8"
    );
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const testScript = String(pkg.scripts.test);
    for (let i = 1; i <= 21; i++) {
      const id = `D-${String(i).padStart(2, "0")}`;
      assert.match(prior, new RegExp(`it\\("${id} `));
    }
    for (const name of ["C-C16", "C-C17", "C-C18", "C-C19", "C-C20", "C-C21", "C-C22", "C-C23", "C-C24"]) {
      assert.match(execution, new RegExp(`it\\("${name} `));
    }
    for (const file of [
      "test/experiment-v02-planner-dedup.test.ts",
      "test/experiment-v02-planner-dedup-corrective-1.test.ts",
      "test/experiment-v02-execution.test.ts",
    ]) {
      assert.ok(testScript.includes(file), file);
    }
    assert.equal(String(pkg.scripts["test:checkpoint-d-corrective"]).includes("corrective-1"), true);
  });
});
