import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  createExperimentTelemetry,
  publishExecutionJournal,
  resolveExecutionCursorPath,
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
import {
  EXECUTION_JOURNAL_LIMIT,
  ExtendedAccountStreamState,
} from "../src/venues/extendedAccountStream.js";
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

function initializedState(
  now = makeClock(),
  opts?: {
    cursorPath?: string;
    cursorIdentity?: { experimentId: string; scopeKey: string; venue: string; market: string };
  },
): ExtendedAccountStreamState {
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
    assert.equal(row.authoritative, true);
    const drain = state.drainJournal();
    assert.equal(drain.executions.length, 1);
    assert.equal(drain.authoritativeExecutions.length, 1);
    assert.equal(drain.authoritativeExecutions[0]!.authoritative, true);
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
    assert.equal(journal.authoritativeCount, 1);
    assert.equal(journal.executions.filter((row) => row.authoritative).length, 1);
    assert.ok(journal.executions.filter((row) => row.exchangeTradeId === "tr-2").every((row) => row.authoritative === false));
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
    assert.equal(second.journalSnapshot().executions.length, 1);
    assert.equal(second.journalSnapshot().executions[0]!.authoritative, true);
    second.ingest(tradeMessage(2, canonicalTrade()));
    assert.equal(second.journalSnapshot().executions.length, 1);
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
    assert.equal(journal.authoritativeCount, 1);
    assert.equal(
      journal.executions.some((row) => row.exchangeTradeId === "tr-old" && row.authoritative),
      false,
    );
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
    assert.equal(drain.authoritativeExecutions.length, 0);
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
    assert.match(loopSrc, /acknowledgeExecutionJournal/);
    assert.match(loopSrc, /setExecutionCursorBind/);
    assert.match(loopSrc, /resolveExecutionCursorPath/);
    assert.doesNotMatch(loopSrc, /experimentTelemetry\.dir.*extended-execution-cursor/);
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

const MANIFEST_FIELDS = {
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
} as const;

function cursorBind(overrides: Partial<{ experimentId: string; scopeKey: string; venue: string; market: string }> = {}) {
  return {
    experimentId: overrides.experimentId ?? "classic-cc",
    scopeKey: overrides.scopeKey ?? "dry-run:extended:BTC",
    venue: overrides.venue ?? "extended",
    market: overrides.market ?? "BTC",
  };
}

function publishedFills(state: ExtendedAccountStreamState) {
  const drain = state.drainJournal();
  const fills: string[] = [];
  const recon: string[] = [];
  const keys = publishExecutionJournal((event, fields) => {
    if (event === "FILL") fills.push(String(fields?.exchange_trade_id ?? ""));
    if (event === "EXECUTION_RECONCILIATION_REQUIRED") recon.push(String(fields?.error_code ?? ""));
    return true;
  }, drain);
  state.acknowledgeJournal(keys);
  return { drain, fills, recon, keys };
}

describe("Checkpoint C Corrective 1 authority, cursor, and journal drain", () => {
  it("C-C1 sequence gap followed by a new unique trade emits reconciliation and zero FILL for the post-gap trade", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({ id: "tr-pre" })));
    assert.throws(
      () => state.ingest(tradeMessage(4, canonicalTrade({ id: "tr-post-gap" }))),
      /EXTENDED_WS_SEQUENCE_GAP/,
    );
    const { fills, recon, drain } = publishedFills(state);
    assert.ok(recon.includes("SEQUENCE_GAP"));
    assert.equal(fills.includes("tr-post-gap"), false);
    assert.equal(drain.authoritativeExecutions.some((row) => row.exchangeTradeId === "tr-post-gap"), false);
    assert.ok(drain.executions.some((row) => row.exchangeTradeId === "tr-post-gap" && row.authoritative === false));
  });

  it("C-C2 reconnect followed by a new unique trade emits zero authoritative FILL for the post-reconnect trade", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({ id: "tr-pre" })));
    state.reset();
    state.ingest(initialMessage("BALANCE", { balance: { equity: "50" } }));
    state.ingest(initialMessage("POSITION", { positions: [] }));
    state.ingest(initialMessage("ORDER", { orders: [] }));
    state.ingest(tradeMessage(2, canonicalTrade({ id: "tr-post-reconnect" })));
    const { fills, drain } = publishedFills(state);
    assert.equal(fills.includes("tr-post-reconnect"), false);
    assert.equal(drain.authoritativeExecutions.some((row) => row.exchangeTradeId === "tr-post-reconnect"), false);
    assert.deepEqual(fills, ["tr-pre"]);
  });

  it("C-C3 trusted trade before a later sequence gap emits exactly one FILL for the pre-gap trade", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({ id: "tr-pre-gap" })));
    assert.throws(
      () => state.ingest(tradeMessage(4, canonicalTrade({ id: "tr-after-gap" }))),
      /EXTENDED_WS_SEQUENCE_GAP/,
    );
    const { fills, recon } = publishedFills(state);
    assert.deepEqual(fills, ["tr-pre-gap"]);
    assert.equal(fills.includes("tr-after-gap"), false);
    assert.ok(recon.includes("SEQUENCE_GAP"));
  });

  it("C-C4 cursor conflict followed by a unique trade emits zero authoritative FILL", () => {
    const dir = tmpDir("cc4");
    const file = path.join(dir, "cursor.json");
    fs.writeFileSync(file, `${JSON.stringify({ version: 99, seenDedupeKeys: ["extended|BTC-USD|trade|foreign"] })}\n`);
    const state = initializedState(makeClock(), { cursorPath: file, cursorIdentity: cursorBind({ experimentId: "classic-cc4" }) });
    state.ingest(tradeMessage(2, canonicalTrade({ id: "tr-after-conflict" })));
    const { fills, recon } = publishedFills(state);
    assert.deepEqual(fills, []);
    assert.ok(recon.includes("CURSOR_CONFLICT"));
  });

  it("C-C5 malformed identity followed by a valid unique trade while invalidated emits no authoritative FILL", () => {
    const state = initializedState();
    state.ingest(tradeMessage(2, canonicalTrade({ id: "", tradeId: undefined })));
    state.ingest(tradeMessage(3, canonicalTrade({ id: "tr-valid-after-malformed" })));
    const { fills, recon, drain } = publishedFills(state);
    assert.deepEqual(fills, []);
    assert.equal(drain.authoritativeCount, 0);
    assert.ok(recon.includes("MALFORMED_IDENTITY"));
    assert.equal(drain.authoritativeExecutions.length, 0);
  });

  it("C-C6 two simulated process starts with different telemetry run IDs resolve the same stable cursor", () => {
    const baseDir = tmpDir("cc6");
    const experimentId = "classic-cc6";
    const scopeKey = "acct:extended:BTC/live-scope";
    const tel1 = createExperimentTelemetry({
      experimentId,
      runId: "run-alpha-1",
      mode: "dry-run",
      venue: "extended",
      symbol: "BTC",
      commitSha: "abc",
      baseDir,
      manifestFields: MANIFEST_FIELDS,
    });
    const tel2 = createExperimentTelemetry({
      experimentId,
      runId: "run-beta-2",
      mode: "dry-run",
      venue: "extended",
      symbol: "BTC",
      commitSha: "abc",
      baseDir,
      manifestFields: MANIFEST_FIELDS,
    });
    assert.notEqual(tel1.dir, tel2.dir);
    assert.ok(tel1.dir.includes("run-alpha-1"));
    assert.ok(tel2.dir.includes("run-beta-2"));
    const first = resolveExecutionCursorPath({
      experimentId,
      scopeKey,
      venue: "extended",
      market: "btc",
      baseDir,
    });
    const second = resolveExecutionCursorPath({
      experimentId,
      scopeKey,
      venue: "extended",
      market: "BTC",
      baseDir,
    });
    assert.equal(first, second);
    assert.equal(first.includes("run-alpha-1"), false);
    assert.equal(first.includes("run-beta-2"), false);
    assert.equal(first.includes(scopeKey), false);
    assert.equal(first.includes("acct:"), false);
    assert.ok(first.includes("execution-cursors"));
    assert.match(path.basename(first), /^[0-9a-f]{32}\.json$/);
    const loopSrc = fs.readFileSync(fileURLToPath(new URL("../src/loop.ts", import.meta.url)), "utf8");
    assert.match(loopSrc, /resolveExecutionCursorPath/);
    assert.doesNotMatch(loopSrc, /experimentTelemetry\.dir/);
  });

  it("C-C7 replay of the same exchangeTradeId after process restart produces no duplicate", () => {
    const dir = tmpDir("cc7");
    const bind = cursorBind({ experimentId: "classic-cc7" });
    const cursorPath = resolveExecutionCursorPath({ ...bind, baseDir: dir });
    const first = initializedState(makeClock(), { cursorPath, cursorIdentity: bind });
    first.ingest(tradeMessage(2, canonicalTrade({ id: "tr-replay" })));
    assert.deepEqual(publishedFills(first).fills, ["tr-replay"]);
    const second = initializedState(makeClock(), { cursorPath, cursorIdentity: bind });
    second.ingest(tradeMessage(2, canonicalTrade({ id: "tr-replay" })));
    assert.deepEqual(publishedFills(second).fills, []);
    assert.equal(second.journalSnapshot().authoritativeCount, 1);
  });

  it("C-C8 a new legitimate trade after clean restart remains observable exactly once", () => {
    const dir = tmpDir("cc8");
    const bind = cursorBind({ experimentId: "classic-cc8" });
    const cursorPath = resolveExecutionCursorPath({ ...bind, baseDir: dir });
    const first = initializedState(makeClock(), { cursorPath, cursorIdentity: bind });
    first.ingest(tradeMessage(2, canonicalTrade({ id: "tr-old" })));
    assert.deepEqual(publishedFills(first).fills, ["tr-old"]);
    const second = initializedState(makeClock(), { cursorPath, cursorIdentity: bind });
    second.ingest(tradeMessage(2, canonicalTrade({ id: "tr-new" })));
    assert.deepEqual(publishedFills(second).fills, ["tr-new"]);
    second.ingest(tradeMessage(3, canonicalTrade({ id: "tr-new" })));
    assert.deepEqual(publishedFills(second).fills, []);
  });

  it("C-C9 cursor scope/venue/market mismatch fails closed", () => {
    const dir = tmpDir("cc9");
    const eth = cursorBind({ experimentId: "classic-cc9", scopeKey: "scope-eth", market: "ETH" });
    const cursorPath = resolveExecutionCursorPath({ ...eth, baseDir: dir });
    const first = initializedState(makeClock(), { cursorPath, cursorIdentity: eth });
    first.ingest(tradeMessage(2, canonicalTrade({ id: "tr-eth", market: "ETH-USD" })));
    const btc = cursorBind({ experimentId: "classic-cc9", scopeKey: "scope-eth", market: "BTC" });
    const second = initializedState(makeClock(), { cursorPath, cursorIdentity: btc });
    assert.equal(second.journalSnapshot().authority, "invalidated");
    second.ingest(tradeMessage(2, canonicalTrade({ id: "tr-btc" })));
    const { fills, recon } = publishedFills(second);
    assert.deepEqual(fills, []);
    assert.ok(recon.includes("CURSOR_CONFLICT"));
  });

  it("C-C10 corrupt and truncated cursor fail closed without leaking payload values", () => {
    const leak = "cursor-payload-must-not-leak-9f3a";
    const bind = cursorBind({ experimentId: "classic-cc10" });
    const truncatedPath = path.join(tmpDir("cc10t"), "cursor.json");
    fs.writeFileSync(truncatedPath, `{"version":2,"identity":{"scopeKey":"${leak}"`);
    const truncated = initializedState(makeClock(), { cursorPath: truncatedPath, cursorIdentity: bind });
    const truncatedDump = JSON.stringify(truncated.journalSnapshot());
    assert.equal(truncatedDump.includes(leak), false);
    assert.equal(truncated.journalSnapshot().authority, "invalidated");

    const corruptPath = path.join(tmpDir("cc10c"), "cursor.json");
    fs.writeFileSync(corruptPath, `${JSON.stringify({
      version: 2,
      identity: {
        schemaVersion: "classic-grid.execution-cursor.v2",
        experimentId: "classic-cc10",
        scopeKey: leak,
        venue: "extended",
        market: "BTC-USD",
      },
      authority: "trusted",
      seenDedupeKeys: [leak],
      publishedDedupeKeys: "not-an-array",
      pendingAuthoritative: [],
      lineageCumulative: {},
      authoritativeCount: 0,
    })}\n`);
    const corrupt = initializedState(makeClock(), { cursorPath: corruptPath, cursorIdentity: bind });
    const corruptDump = JSON.stringify(corrupt.journalSnapshot());
    assert.equal(corruptDump.includes(leak), false);
    const { fills, recon } = publishedFills(corrupt);
    assert.deepEqual(fills, []);
    assert.ok(recon.includes("CURSOR_CONFLICT"));
    assert.equal(JSON.stringify(recon).includes(leak), false);
  });

  it("C-C11 crash/restart between trade acceptance and publication has no-duplicate/no-silent-loss disposition", () => {
    const dir = tmpDir("cc11");
    const bind = cursorBind({ experimentId: "classic-cc11" });
    const cursorPath = resolveExecutionCursorPath({ ...bind, baseDir: dir });
    const first = initializedState(makeClock(), { cursorPath, cursorIdentity: bind });
    first.ingest(tradeMessage(2, canonicalTrade({ id: "tr-crash-window" })));
    assert.equal(first.journalSnapshot().executions[0]!.authoritative, true);
    const st = fs.statSync(cursorPath);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(cursorPath)).mode & 0o777, 0o700);

    const second = initializedState(makeClock(), { cursorPath, cursorIdentity: bind });
    const firstDrain = second.drainJournal();
    assert.equal(firstDrain.authoritativeExecutions.length, 1);
    assert.equal(firstDrain.authoritativeExecutions[0]!.exchangeTradeId, "tr-crash-window");
    const fills: string[] = [];
    publishExecutionJournal((event, fields) => {
      if (event === "FILL") fills.push(String(fields?.exchange_trade_id ?? ""));
      return true;
    }, firstDrain);
    assert.deepEqual(fills, ["tr-crash-window"]);
    second.ingest(tradeMessage(2, canonicalTrade({ id: "tr-crash-window" })));
    const replay = second.drainJournal();
    assert.equal(replay.authoritativeExecutions.length, 1);
    assert.equal(replay.executions.filter((row) => row.exchangeTradeId === "tr-crash-window").length, 1);
  });

  it("C-C12 ingest and drain more than 2,500 unique executions with periodic drains", () => {
    const state = initializedState();
    const fills: string[] = [];
    const total = 2_500;
    for (let i = 0; i < total; i++) {
      state.ingest(tradeMessage(2 + i, canonicalTrade({ id: `tr-${i}` })));
      if ((i + 1) % 100 === 0) {
        fills.push(...publishedFills(state).fills);
      }
    }
    assert.equal(fills.length, total);
    assert.equal(new Set(fills).size, total);
    assert.equal(state.journalSnapshot().faults.some((fault) => fault.code === "JOURNAL_CAPACITY"), false);
  });

  it("C-C13 ingest more than JOURNAL_LIMIT before the first drain", () => {
    const state = initializedState();
    for (let i = 0; i <= EXECUTION_JOURNAL_LIMIT; i++) {
      state.ingest(tradeMessage(2 + i, canonicalTrade({ id: `tr-${i}` })));
    }
    const snap = state.journalSnapshot();
    assert.ok(snap.faults.some((fault) => fault.code === "JOURNAL_CAPACITY"));
    assert.equal(snap.executions.filter((row) => row.authoritative).length, EXECUTION_JOURNAL_LIMIT);
    assert.equal(snap.authoritativeCount, EXECUTION_JOURNAL_LIMIT);
    const drain = state.drainJournal();
    assert.equal(drain.authoritativeExecutions.length, EXECUTION_JOURNAL_LIMIT);
    assert.equal(drain.authoritativeExecutions.some((row) => row.exchangeTradeId === `tr-${EXECUTION_JOURNAL_LIMIT}`), false);
  });

  it("C-C14 fault queue continues draining after more than JOURNAL_LIMIT faults or fail-closes at capacity", () => {
    const periodic = initializedState();
    let drainedFaults = 0;
    const total = EXECUTION_JOURNAL_LIMIT + 100;
    for (let i = 0; i < total; i++) {
      periodic.ingest(tradeMessage(2 + i, canonicalTrade({ id: `bad-${i}`, price: "NaN" })));
      if ((i + 1) % 100 === 0) {
        drainedFaults += periodic.drainJournal().faults.length;
      }
    }
    assert.equal(drainedFaults, total);

    const overflow = initializedState();
    for (let i = 0; i < EXECUTION_JOURNAL_LIMIT + 1; i++) {
      overflow.ingest(tradeMessage(2 + i, canonicalTrade({ id: `cap-${i}`, price: "NaN" })));
    }
    const overflowDrain = overflow.drainJournal();
    assert.ok(overflowDrain.faults.some((fault) => fault.code === "JOURNAL_CAPACITY"));
    assert.ok(overflowDrain.faults.length <= EXECUTION_JOURNAL_LIMIT + 1);
  });

  it("C-C15 no undrained authoritative execution is silently removed", () => {
    const state = initializedState();
    for (let i = 0; i < EXECUTION_JOURNAL_LIMIT; i++) {
      state.ingest(tradeMessage(2 + i, canonicalTrade({ id: `keep-${i}` })));
    }
    const before = state.journalSnapshot().executions.filter((row) => row.authoritative).map((row) => row.exchangeTradeId);
    assert.equal(before.length, EXECUTION_JOURNAL_LIMIT);
    state.ingest(tradeMessage(2 + EXECUTION_JOURNAL_LIMIT, canonicalTrade({ id: "overflow-drop-candidate" })));
    const after = state.journalSnapshot().executions.filter((row) => row.authoritative).map((row) => row.exchangeTradeId);
    assert.deepEqual(after, before);
    assert.equal(after.includes("overflow-drop-candidate"), false);
    assert.ok(state.journalSnapshot().faults.some((fault) => fault.code === "JOURNAL_CAPACITY"));
    const drain = state.drainJournal();
    assert.equal(drain.authoritativeExecutions.length, EXECUTION_JOURNAL_LIMIT);
    assert.deepEqual(
      drain.authoritativeExecutions.map((row) => row.exchangeTradeId),
      before,
    );
    const src = fs.readFileSync(fileURLToPath(new URL("../src/venues/extendedAccountStream.ts", import.meta.url)), "utf8");
    assert.doesNotMatch(src, /this\.pendingAuthoritative\.splice/);
    assert.doesNotMatch(src, /this\.faults\.splice/);
    assert.doesNotMatch(src, /this\.diagnosticExecutions\.splice/);
  });
});
