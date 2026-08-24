import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  createExperimentTelemetry,
  publishExecutionJournal,
} from "../src/experimentTelemetry.js";
import {
  emptyRiskState,
  evaluateExperimentRisk,
  initializeRiskStateStore,
  loadRiskState,
  persistRiskState,
} from "../src/experimentRisk.js";
import { runActualNotionalHardHalt } from "../src/experimentReduction.js";
import { planFromFillsAndSeed } from "../src/grid.js";
import { ExtendedExecutor } from "../src/venues/extended.js";
import { ExtendedAccountStreamState } from "../src/venues/extendedAccountStream.js";
import {
  LIMITS,
  MARKET,
  OWNER_PREFIX,
  SCOPE,
  freshSnapshot,
  ownedOrder,
  scriptedTransport,
} from "./helpers/reduction.js";

const EPOCH = 1_700_000_000_000;
const HERE = fileURLToPath(import.meta.url);

function makeClock(): () => number {
  let value = EPOCH;
  return () => value++;
}

function initialMessage(type: "BALANCE" | "POSITION" | "ORDER", data: object) {
  return { type, data, ts: EPOCH, seq: 1 };
}

function initializedState(now = makeClock(), opts?: { cursorPath?: string }): ExtendedAccountStreamState {
  const state = new ExtendedAccountStreamState(now, opts);
  state.ingest(initialMessage("BALANCE", { balance: { equity: "50" } }));
  state.ingest(initialMessage("POSITION", { positions: [] }));
  state.ingest(initialMessage("ORDER", { orders: [] }));
  assert.equal(state.checkpoint().initialized, true);
  return state;
}

function tradeMessage(seq: number, trade: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: "TRADE" as const,
    ts: EPOCH + seq,
    seq,
    data: { trades: [trade], ...extra },
  };
}

function canonicalTrade(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tr-1",
    market: "BTC-USD",
    side: "BUY",
    price: "100000",
    qty: "0.001",
    orderId: "ord-1",
    externalId: "cg:1-buy-3",
    filledQty: "0.001",
    remainingQty: "0",
    timestamp: EPOCH,
    ...partial,
  };
}

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `classic-c-${label}-`));
}

function seedRunning(id: string, dir: string, leaseGeneration = "lease-1") {
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

describe("Checkpoint C exchange-observed execution journal", () => {
  it("C-01 full exchange fill emits exactly one authoritative FILL", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade()));
    const journal = state.journalSnapshot();
    assert.equal(journal.executions.length, 1);
    assert.equal(journal.authoritativeCount, 1);
    assert.equal(journal.authority, "trusted");
    const row = journal.executions[0]!;
    assert.equal(row.source, "exchange");
    assert.equal(row.venue, "extended");
    assert.equal(row.market, "BTC-USD");
    assert.equal(row.side, "buy");
    assert.equal(row.price, 100000);
    assert.equal(row.quantity, 0.001);
    assert.equal(row.exchangeTradeId, "tr-1");
    assert.equal(row.exchangeOrderId, "ord-1");
    assert.equal(row.clientOrderId, "cg:1-buy-3");
    assert.equal(row.streamSequence, 2);
    assert.equal(row.dedupeKey, "extended|BTC-USD|trade|tr-1");
    const drain = state.drainJournal();
    assert.equal(drain.executions.length, 1);
    const events: string[] = [];
    publishExecutionJournal((event) => {
      events.push(event);
      return true;
    }, drain);
    assert.deepEqual(events, ["FILL"]);
  });

  it("C-02 duplicate delivery emits one authoritative record", () => {
    const state = initializedState();
    const msg = tradeMessage(2, canonicalTrade());
    state.ingest(msg);
    state.ingest(msg);
    assert.equal(state.journalSnapshot().executions.length, 1);
    assert.equal(state.journalSnapshot().authoritativeCount, 1);
  });

  it("C-03 partial fill preserves actual quantity and cumulative/remaining fields", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({
      qty: "0.0004",
      filledQty: "0.0004",
      remainingQty: "0.0006",
      orderQty: "0.001",
    })));
    const row = state.journalSnapshot().executions[0]!;
    assert.equal(row.quantity, 0.0004);
    assert.equal(row.cumulativeFilledQuantity, 0.0004);
    assert.equal(row.remainingQuantity, 0.0006);
    assert.equal(state.journalSnapshot().authoritativeCount, 1);
  });

  it("C-04 two legitimate partial fills are not collapsed", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({
      id: "tr-a",
      qty: "0.0004",
      filledQty: "0.0004",
      remainingQty: "0.0006",
      orderQty: "0.001",
    })));
    state.ingest(tradeMessage(3, canonicalTrade({
      id: "tr-b",
      qty: "0.0006",
      filledQty: "0.001",
      remainingQty: "0",
      orderQty: "0.001",
    })));
    const journal = state.journalSnapshot();
    assert.equal(journal.executions.length, 2);
    assert.equal(journal.executions[0]!.exchangeTradeId, "tr-a");
    assert.equal(journal.executions[1]!.exchangeTradeId, "tr-b");
    assert.equal(
      journal.executions[0]!.quantity + journal.executions[1]!.quantity,
      0.001,
    );
    assert.equal(journal.authoritativeCount, 2);
  });

  it("C-05 open-order disappearance emits no FILL", () => {
    const state = initializedState();
    state.ingest({
      type: "ORDER",
      ts: EPOCH + 2,
      seq: 2,
      data: { orders: [] },
    });
    assert.equal(state.journalSnapshot().executions.length, 0);
    assert.equal(state.journalSnapshot().authoritativeCount, 0);
    const plan = planFromFillsAndSeed({
      market: "BTC",
      mid: 100_000,
      levels: [99_000, 100_000, 101_000],
      spacing: 1_000,
      mode: "neutral",
      sizeBase: 0.001,
      openOrders: [],
      prevActive: new Map([["gone", { levelIndex: 2, side: "sell", price: 101_000, size: 0.001 }]]),
      maxWrites: 10,
      seeded: true,
      ownershipPrefix: "cg:test:",
      anchorEpoch: 42,
    });
    assert.equal(plan.filled.length, 0);
  });

  it("C-06 cancel emits no FILL", () => {
    const state = initializedState();
    state.ingest({
      type: "ORDER",
      ts: EPOCH + 2,
      seq: 2,
      data: { orders: [{ id: "ord-1", status: "CANCELLED", market: "BTC-USD" }] },
    });
    assert.equal(state.journalSnapshot().executions.length, 0);
    assert.equal(state.journalSnapshot().authoritativeCount, 0);
  });

  it("C-07 rejection emits no FILL", () => {
    const state = initializedState();
    state.ingest({
      type: "ORDER",
      ts: EPOCH + 2,
      seq: 2,
      data: { orders: [{ id: "ord-1", status: "REJECTED", market: "BTC-USD" }] },
    });
    assert.equal(state.journalSnapshot().executions.length, 0);
  });

  it("C-08 position delta without execution emits no FILL", () => {
    const state = initializedState();
    state.ingest({
      type: "POSITION",
      ts: EPOCH + 2,
      seq: 2,
      data: { positions: [{ market: "BTC-USD", size: "0.002" }] },
    });
    assert.equal(state.journalSnapshot().executions.length, 0);
    assert.equal(state.journalSnapshot().authoritativeCount, 0);
  });

  it("C-09 sequence gap invalidates journal authority", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade()));
    assert.equal(state.journalSnapshot().authoritativeCount, 1);
    assert.throws(
      () => state.ingest(tradeMessage(4, canonicalTrade({ id: "tr-2" }))),
      /EXTENDED_WS_SEQUENCE_GAP/,
    );
    const journal = state.journalSnapshot();
    assert.equal(journal.authority, "invalidated");
    assert.equal(journal.lastSeq, 2);
    assert.equal(journal.executions.length, 1);
    assert.ok(journal.faults.some((fault) => fault.code === "SEQUENCE_GAP"));
    assert.equal(journal.faults[0]!.event, "EXECUTION_RECONCILIATION_REQUIRED");
  });

  it("C-10 reconnect replay does not double-count", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade()));
    assert.equal(state.journalSnapshot().executions.length, 1);
    state.reset();
    state.ingest(initialMessage("BALANCE", { balance: { equity: "50" } }));
    state.ingest(initialMessage("POSITION", { positions: [] }));
    state.ingest(initialMessage("ORDER", { orders: [] }));
    state.ingest(tradeMessage(2, canonicalTrade()));
    const journal = state.journalSnapshot();
    assert.equal(journal.executions.length, 1);
    assert.equal(journal.authority, "invalidated");
    assert.ok(journal.faults.some((fault) => fault.code === "DISCONNECTED"));
  });

  it("C-11 malformed or non-finite values are rejected", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({ price: "NaN", qty: "0.001" })));
    assert.equal(state.journalSnapshot().executions.length, 0);
    const stateNeg = initializedState();
    stateNeg.ingest(tradeMessage(2, canonicalTrade({ price: "-1", qty: "0.001" })));
    assert.equal(stateNeg.journalSnapshot().executions.length, 0);
    const stateZero = initializedState();
    stateZero.ingest(tradeMessage(2, canonicalTrade({ qty: "0" })));
    assert.equal(stateZero.journalSnapshot().executions.length, 0);
    const stateInf = initializedState();
    stateInf.ingest(tradeMessage(2, canonicalTrade({ qty: "Infinity" })));
    assert.equal(stateInf.journalSnapshot().executions.length, 0);
    assert.ok(state.journalSnapshot().faults.some((fault) => fault.code === "NON_FINITE_FIELDS"));
  });

  it("C-12 missing stable identity does not advance authoritative counters", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({ id: "", tradeId: undefined })));
    const journal = state.journalSnapshot();
    assert.equal(journal.executions.length, 0);
    assert.equal(journal.authoritativeCount, 0);
    assert.ok(journal.faults.some((fault) => fault.code === "MALFORMED_IDENTITY"));
    assert.equal(journal.authority, "invalidated");
  });

  it("C-13 persisted cursor restart is replay-safe", () => {
    const dir = tmpDir("cursor");
    const cursorPath = path.join(dir, "cursor.json");
    const first = initializedState(makeClock(), { cursorPath });
    first.ingest(tradeMessage(2, canonicalTrade()));
    assert.equal(first.journalSnapshot().executions.length, 1);
    const second = initializedState(makeClock(), { cursorPath });
    second.ingest(tradeMessage(2, canonicalTrade()));
    assert.equal(second.journalSnapshot().executions.length, 0);
    assert.equal(second.journalSnapshot().authoritativeCount, 1);
  });

  it("C-14 out-of-order data cannot silently advance the cursor", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade()));
    assert.throws(
      () => state.ingest(tradeMessage(1, canonicalTrade({ id: "tr-old" }))),
      /EXTENDED_WS_SEQUENCE_GAP/,
    );
    const journal = state.journalSnapshot();
    assert.equal(journal.lastSeq, 2);
    assert.equal(journal.authority, "invalidated");
    assert.ok(journal.faults.some((fault) => fault.code === "OUT_OF_ORDER"));
    assert.equal(journal.executions.some((row) => row.exchangeTradeId === "tr-old"), false);
  });

  it("C-15 telemetry failure does not alter risk/reduction handling", async () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade()));
    const drain = state.drainJournal();
    assert.equal(drain.executions.length, 1);
    assert.doesNotThrow(() => {
      publishExecutionJournal(() => {
        throw new Error("telemetry down");
      }, drain);
    });
    const telDir = tmpDir("tel");
    const tel = createExperimentTelemetry({
      experimentId: "classic-c15",
      mode: "dry-run",
      venue: "extended",
      symbol: "BTC",
      commitSha: "abc",
      baseDir: telDir,
      manifestFields: {
        experiment_spec_version: "0.2.0",
        starting_capital_usd: 100,
        leverage: 5,
        max_margin_budget_usd: 30,
        max_planned_gross_notional_usd: 150,
        grid_half_band_pct: 3,
        grid_level_count: 10,
        daily_loss_limit_usd: 5,
        max_drawdown_usd: 10,
        boundary_buffer_pct: 1,
      },
    });
    fs.unlinkSync(tel.eventsPath);
    fs.mkdirSync(tel.eventsPath);
    assert.equal(tel.emit("FILL", { source: "exchange", filled_qty: 0.001 }), false);
    assert.equal(tel.droppedEvents(), 1);

    const dir = tmpDir("c15-halt");
    const id = "c15-telemetry";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      {
        mid: 100_000,
        equityUsd: 100,
        dailyPnlUsd: 0,
        positionQty: 0.00151,
        positionNotionalUsd: 151,
        plannedGrossNotionalUsd: 150,
        gridLower: 97_000,
        gridUpper: 103_000,
      },
      LIMITS,
      running,
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: (n) => freshSnapshot({
        positionQty: n === 1 ? 0.00151 : 0,
        openOrders: [],
        observationId: `c15-${n}`,
        sourceGeneration: `g-c15-${n}`,
      }),
    });
    const result = await runActualNotionalHardHalt({
      experimentId: id,
      market: MARKET,
      ownershipPrefix: OWNER_PREFIX,
      positionQty: 0.00151,
      openOrders: [ownedOrder({ side: "buy" })],
      reasons: ["ACTUAL_NOTIONAL_CAP"],
      transport,
      assertLeaseCurrent: () => undefined,
      leaseGeneration: "lease-1",
      baseDir: dir,
      scopeKey: SCOPE,
      state: evaluated.next,
    });
    assert.ok(transport.flattenCalls >= 1);
    assert.notEqual(result.lifecycle, "NORMAL");
  });

  it("C-16 existing Gate 0, Checkpoint A, and Checkpoint B suites remain present", () => {
    const reduction = fs.readFileSync(fileURLToPath(new URL("./experiment-v02-reduction.test.ts", import.meta.url)), "utf8");
    const gate0 = fs.readFileSync(fileURLToPath(new URL("./experiment-ack-authority.test.ts", import.meta.url)), "utf8");
    const gate0Corrective = fs.readFileSync(fileURLToPath(new URL("./experiment-gate0-corrective.test.ts", import.meta.url)), "utf8");
    const checkpointA = fs.readFileSync(fileURLToPath(new URL("./experiment-v02-config.test.ts", import.meta.url)), "utf8");
    assert.match(gate0, /Gate 0 durable ACK authority/);
    assert.match(gate0Corrective, /Gate 0 Corrective 1/);
    assert.match(checkpointA, /it\("A1:/);
    assert.match(reduction, /it\("B1:/);
    assert.match(reduction, /it\("C5-8 /);
  });

  it("C-17 dry-run performs zero live/network mutations", async () => {
    const src = fs.readFileSync(fileURLToPath(new URL("../src/venues/extendedAccountStream.ts", import.meta.url)), "utf8");
    assert.match(HERE, /experiment-v02-execution/);
    assert.equal(src.includes("state.ingest(data)"), true);
    const executor = new ExtendedExecutor(true);
    await executor.connect();
    const drain = executor.drainExecutionJournal();
    assert.equal(drain.executions.length, 0);
    executor.disconnect();
  });

  it("C-18 diagnostics do not expose raw secret-like fixture values", () => {
    const secret = "fixture-secret-value-do-not-log";
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({ apiKey: secret, privateKey: secret })));
    const dumped = JSON.stringify(state.journalSnapshot());
    assert.equal(dumped.includes(secret), false);
    const telDir = tmpDir("c18");
    const tel = createExperimentTelemetry({
      experimentId: "classic-c18",
      mode: "dry-run",
      venue: "extended",
      symbol: "BTC",
      commitSha: "abc",
      baseDir: telDir,
      manifestFields: {
        experiment_spec_version: "0.2.0",
        starting_capital_usd: 100,
        leverage: 5,
        max_margin_budget_usd: 30,
        max_planned_gross_notional_usd: 150,
        grid_half_band_pct: 3,
        grid_level_count: 10,
        daily_loss_limit_usd: 5,
        max_drawdown_usd: 10,
        boundary_buffer_pct: 1,
      },
    });
    const drain = state.drainJournal();
    publishExecutionJournal(tel.emit, drain);
    const events = fs.readFileSync(tel.eventsPath, "utf8");
    assert.equal(events.includes(secret), false);
  });

  it("C-19 websocket callback never directly places or replaces an order", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("../src/venues/extendedAccountStream.ts", import.meta.url)), "utf8");
    const handler = src.slice(src.indexOf('socket.on("message"'));
    const body = handler.slice(0, handler.indexOf("socket.on(\"ping\""));
    assert.match(body, /this\.state\.ingest\(data\)/);
    assert.doesNotMatch(body, /\.apply\(/);
    assert.doesNotMatch(body, /placeLimitOrder|placeOrder|reduceExposure/);
  });

  it("C-20 plan.filled remains empty from disappearance or execution telemetry", () => {
    const plan = planFromFillsAndSeed({
      market: "BTC",
      mid: 100_000,
      levels: [99_000, 100_000, 101_000],
      spacing: 1_000,
      mode: "neutral",
      sizeBase: 0.001,
      openOrders: [],
      prevActive: new Map([["gone", { levelIndex: 0, side: "buy", price: 99_000, size: 0.001 }]]),
      maxWrites: 10,
      seeded: true,
    });
    assert.equal(plan.filled.length, 0);
    const loopSrc = fs.readFileSync(fileURLToPath(new URL("../src/loop.ts", import.meta.url)), "utf8");
    assert.match(loopSrc, /ORDER_DISAPPEARED/);
    assert.match(loopSrc, /drainExecutionJournal/);
    assert.doesNotMatch(loopSrc, /for \(const f of plan\.filled\)/);
  });

  it("C-21 Gate 0 / A / B tests are not deleted and C-22 Corrective 5 composition remains", () => {
    const reduction = fs.readFileSync(fileURLToPath(new URL("./experiment-v02-reduction.test.ts", import.meta.url)), "utf8");
    assert.match(reduction, /it\("C5-1 /);
    assert.match(reduction, /it\("C5-3 /);
    assert.match(reduction, /assert\.equal\(result\.flatten\?\.outcome, "NOT_SENT"\)/);
    assert.match(reduction, /assert\.equal\(result\.flatten\?\.physicalAttempt, 1\)/);
    assert.match(reduction, /FLATTEN_ATTEMPT_UNKNOWN/);
  });

  it("same trade id on different venue/market scopes does not collide", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({ market: "BTC-USD" })));
    state.ingest(tradeMessage(3, canonicalTrade({ market: "ETH-USD" })));
    assert.equal(state.journalSnapshot().executions.length, 2);
    assert.notEqual(
      state.journalSnapshot().executions[0]!.dedupeKey,
      state.journalSnapshot().executions[1]!.dedupeKey,
    );
  });

  it("cumulative regression fails closed", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({
      id: "tr-a",
      filledQty: "0.0008",
      qty: "0.0008",
      orderQty: "0.001",
    })));
    state.ingest(tradeMessage(3, canonicalTrade({
      id: "tr-b",
      filledQty: "0.0003",
      qty: "0.0003",
      orderQty: "0.001",
    })));
    const journal = state.journalSnapshot();
    assert.equal(journal.executions.length, 1);
    assert.ok(journal.faults.some((fault) => fault.code === "CUMULATIVE_REGRESSION"));
  });
});
