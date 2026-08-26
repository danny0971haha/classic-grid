import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createChecksummedEnvelopeV2, serializeChecksummedEnvelopeV2, sha256Canonical } from "../src/experimentStorage.js";
import { publishExecutionJournal } from "../src/experimentTelemetry.js";
import { applyPlannerIntentGate, expectedOwnedClientOrderId, planFromFillsAndSeed } from "../src/grid.js";
import {
  STRATEGY_LEDGER_KIND,
  STRATEGY_LEDGER_SCHEMA_VERSION,
  applyReplacementDispositions,
  authoritativeMetrics,
  emptyStrategyLedger,
  ingestAuthoritativeDrain,
  loadStrategyLedger,
  markObligationsSubmitting,
  persistStrategyLedger,
  plannerFilledFromLedger,
  plannerObligationsFromLedger,
  replacementSizeByClientOrderId,
  resolveStrategyLedgerPath,
  strategyLedgerIdentity,
  type StrategyLedgerPayload,
} from "../src/strategyExecutionLedger.js";
import { ExtendedAccountStreamState } from "../src/venues/extendedAccountStream.js";
import type { ExecutionFault, ExecutionRecord, Intent, LiveOrder, Side } from "../src/types.js";
import { hardKillFWorker, spawnFWorker } from "./helpers/strategyLedgerCrash.js";

const PREFIX = "cg:test:";
const EPOCH = 42;
const LEVELS = [99_000, 100_000, 101_000];
const SPACING = 1_000;
const SIZE = 0.001;
const MARKET = "BTC";

function cid(side: Side, level: number): string {
  return expectedOwnedClientOrderId(PREFIX, EPOCH, side, level);
}

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `classic-f-${label}-`));
}

function identity(experimentId = "test") {
  return strategyLedgerIdentity({
    experimentId,
    scopeKey: "dry-run:extended:BTC",
    venue: "extended",
    market: MARKET,
    anchorEpoch: EPOCH,
  });
}

function ledgerPath(dir: string, experimentId = "test"): string {
  return resolveStrategyLedgerPath({
    experimentId,
    scopeKey: "dry-run:extended:BTC",
    venue: "extended",
    market: MARKET,
    anchorEpoch: EPOCH,
    baseDir: dir,
  });
}

function exec(p: {
  tid: string;
  side?: Side;
  level?: number;
  qty?: number;
  cid?: string;
  oid?: string;
  cum?: number;
  remaining?: number;
  venue?: ExecutionRecord["venue"];
  market?: string;
  authoritative?: boolean;
  seq?: number;
}): ExecutionRecord {
  const side = p.side ?? "buy";
  const level = p.level ?? 0;
  return {
    source: "exchange",
    venue: p.venue ?? "extended",
    market: p.market ?? "BTC-USD",
    side,
    price: LEVELS[level]!,
    quantity: p.qty ?? SIZE,
    exchangeTradeId: p.tid,
    ...(p.oid !== undefined ? { exchangeOrderId: p.oid } : { exchangeOrderId: `ord-${p.tid}` }),
    ...(p.cid !== undefined ? (p.cid ? { clientOrderId: p.cid } : {}) : { clientOrderId: cid(side, level) }),
    ...(p.cum !== undefined ? { cumulativeFilledQuantity: p.cum } : {}),
    ...(p.remaining !== undefined ? { remainingQuantity: p.remaining } : {}),
    observedAt: new Date(EPOCH).toISOString(),
    streamConnectionId: "conn-1",
    streamSequence: p.seq ?? 2,
    dedupeKey: `extended|${p.market ?? "BTC-USD"}|trade|${p.tid}`,
    authoritative: p.authoritative ?? true,
  };
}

function drainOf(records: ExecutionRecord[], faults: ExecutionFault[] = [], authority: "trusted" | "invalidated" = "trusted") {
  return { authoritativeExecutions: records, faults, authority, executions: records, authoritativeCount: records.length };
}

function ingest(dir: string, records: ExecutionRecord[], extra: {
  faults?: ExecutionFault[];
  authority?: "trusted" | "invalidated";
  openOrders?: LiveOrder[];
  options?: Parameters<typeof ingestAuthoritativeDrain>[0]["options"];
  experimentId?: string;
} = {}) {
  const experimentId = extra.experimentId ?? "test";
  return ingestAuthoritativeDrain({
    path: ledgerPath(dir, experimentId),
    identity: identity(experimentId),
    drain: drainOf(records, extra.faults, extra.authority),
    ownershipPrefix: PREFIX,
    levels: LEVELS,
    spacing: SPACING,
    sizeBase: SIZE,
    mode: "neutral",
    openOrders: extra.openOrders,
    options: extra.options,
  });
}

function live(p: {
  id: string;
  side?: Side;
  level?: number;
  price?: number;
  size?: number;
  market?: string;
  clientOrderId?: string;
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

function plan(openOrders: LiveOrder[], ledger: StrategyLedgerPayload | null, extra: Record<string, unknown> = {}) {
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
    replacementObligations: ledger ? plannerObligationsFromLedger(ledger) : [],
    replacementSizes: ledger ? replacementSizeByClientOrderId(ledger) : {},
    forceCancelOnly: Boolean(ledger?.reconciliationRequired),
    authoritativeFilled: ledger ? plannerFilledFromLedger(ledger) : [],
    authoritativeCompletedRungs: ledger ? ledger.authoritativeCompletedRungs : 0,
    ...extra,
  });
}

function placeIntents(intents: Intent[]) {
  return intents.filter((intent): intent is Extract<Intent, { type: "place" }> => intent.type === "place");
}

function replacementPlaces(intents: Intent[]) {
  return placeIntents(intents).filter((intent) => String(intent.order.clientOrderId || "").includes("-r-"));
}

describe("Checkpoint F authoritative execution consumption", () => {
  it("F-01 full buy fill -> exact upper sell replacement", () => {
    const dir = tmpDir("f01");
    const result = ingest(dir, [exec({ tid: "tr-buy", side: "buy", level: 0, qty: SIZE, cum: SIZE })]);
    assert.equal(result.proven, true);
    assert.equal(result.ledger?.obligations.length, 1);
    const obl = result.ledger!.obligations[0]!;
    assert.equal(obl.sourceSide, "buy");
    assert.equal(obl.sourceLevelIndex, 0);
    assert.equal(obl.targetSide, "sell");
    assert.equal(obl.targetLevelIndex, 1);
    assert.equal(obl.authoritativeExecutedQuantity, SIZE);
    assert.equal(obl.outstandingQuantity, SIZE);
    assert.equal(obl.lifecycle, "READY");
    const planned = plan([], result.ledger);
    const reps = replacementPlaces(planned.intents);
    assert.equal(reps.length, 1);
    assert.equal(reps[0]!.order.side, "sell");
    assert.equal(reps[0]!.order.level, 1);
    assert.equal(reps[0]!.order.size, SIZE);
    assert.equal(reps[0]!.order.clientOrderId, obl.replacementClientOrderId);
  });

  it("F-02 full sell fill -> exact lower buy replacement", () => {
    const dir = tmpDir("f02");
    const result = ingest(dir, [exec({ tid: "tr-sell", side: "sell", level: 2, qty: SIZE, cum: SIZE })]);
    assert.equal(result.proven, true);
    const obl = result.ledger!.obligations[0]!;
    assert.equal(obl.targetSide, "buy");
    assert.equal(obl.targetLevelIndex, 1);
    assert.equal(obl.outstandingQuantity, SIZE);
    const reps = replacementPlaces(plan([], result.ledger).intents);
    assert.equal(reps.length, 1);
    assert.equal(reps[0]!.order.side, "buy");
    assert.equal(reps[0]!.order.level, 1);
    assert.equal(reps[0]!.order.size, SIZE);
  });

  it("F-03 lower/upper edge -> terminal no-op", () => {
    const dir = tmpDir("f03");
    const lower = ingest(dir, [exec({ tid: "tr-edge-sell", side: "sell", level: 0, qty: SIZE })]);
    assert.equal(lower.ledger!.obligations[0]!.lifecycle, "TERMINAL_EDGE_NOOP");
    assert.equal(lower.ledger!.obligations[0]!.replacementClientOrderId, null);
    const dir2 = tmpDir("f03b");
    const upper = ingest(dir2, [exec({ tid: "tr-edge-buy", side: "buy", level: 2, qty: SIZE })]);
    assert.equal(upper.ledger!.obligations[0]!.lifecycle, "TERMINAL_EDGE_NOOP");
    assert.equal(replacementPlaces(plan([], upper.ledger).intents).length, 0);
    assert.equal(replacementPlaces(plan([], lower.ledger).intents).length, 0);
  });

  it("F-04 first partial fill", () => {
    const dir = tmpDir("f04");
    const result = ingest(dir, [exec({ tid: "tr-p1", side: "buy", level: 0, qty: 0.0004, cum: 0.0004, remaining: 0.0006 })]);
    const obl = result.ledger!.obligations[0]!;
    assert.equal(obl.authoritativeExecutedQuantity, 0.0004);
    assert.equal(obl.outstandingQuantity, 0.0004);
    assert.notEqual(obl.outstandingQuantity, SIZE);
    const reps = replacementPlaces(plan([], result.ledger).intents);
    assert.equal(reps[0]!.order.size, 0.0004);
  });

  it("F-05 multiple partial fills, exact residual", () => {
    const dir = tmpDir("f05");
    const result = ingest(dir, [
      exec({ tid: "tr-a", side: "buy", level: 0, qty: 0.0004, cum: 0.0004, remaining: 0.0006, seq: 2, oid: "ord-src" }),
      exec({ tid: "tr-b", side: "buy", level: 0, qty: 0.0006, cum: 0.001, remaining: 0, seq: 3, oid: "ord-src" }),
    ]);
    assert.equal(result.ledger!.obligations.length, 2);
    const qtys = result.ledger!.obligations.map((row) => row.outstandingQuantity).sort();
    assert.deepEqual(qtys, [0.0004, 0.0006]);
    assert.equal(result.ledger!.obligations.reduce((s, row) => s + row.authoritativeExecutedQuantity, 0), 0.001);
    const reps = replacementPlaces(plan([], result.ledger).intents);
    assert.equal(reps.length, 2);
    const sizes = reps.map((row) => row.order.size).sort();
    assert.deepEqual(sizes, [0.0004, 0.0006]);
    assert.equal(reps.every((row) => row.order.size !== SIZE || sizes.includes(0.0004)), true);
    assert.equal(reps.some((row) => row.order.size === SIZE && !sizes.includes(0.0004)), false);
  });

  it("F-06 duplicate trade replay", () => {
    const dir = tmpDir("f06");
    const row = exec({ tid: "tr-dup", side: "buy", level: 0, qty: SIZE });
    const first = ingest(dir, [row]);
    const second = ingest(dir, [row]);
    assert.equal(first.ledger!.obligations.length, 1);
    assert.equal(second.ledger!.obligations.length, 1);
    assert.deepEqual(second.newlyIngestedDedupeKeys, []);
    assert.equal(second.ledger!.obligations[0]!.outstandingQuantity, SIZE);
  });

  it("F-07 cumulative and incremental quantity cannot double count", () => {
    const dir = tmpDir("f07");
    const first = ingest(dir, [exec({
      tid: "tr-1",
      side: "buy",
      level: 0,
      qty: 0.0004,
      cum: 0.0004,
      remaining: 0.0006,
      oid: "ord-src",
    })]);
    assert.equal(first.ledger!.obligations[0]!.authoritativeExecutedQuantity, 0.0004);
    const second = ingest(dir, [exec({ tid: "tr-2", side: "buy", level: 0, qty: 0.001, cum: 0.001, seq: 3, oid: "ord-src" })]);
    assert.equal(second.proven, true);
    assert.equal(second.ledger!.reconciliationRequired, true);
    assert.ok(second.ledger!.reconciliationCodes.includes("QUANTITY_CONFLICT"));
    const acceptedQty = second.ledger!.obligations
      .filter((row) => row.lifecycle !== "RECONCILIATION_REQUIRED" || row.authoritativeExecutedQuantity > 0)
      .reduce((s, row) => s + (row.lifecycle === "READY" ? row.authoritativeExecutedQuantity : 0), 0);
    assert.equal(acceptedQty, 0.0004);
    assert.equal(second.ledger!.ingested.filter((row) => row.accepted).reduce((s, row) => s + row.incrementalQuantity, 0), 0.0004);
    const third = ingest(dir, [exec({
      tid: "tr-3",
      side: "buy",
      level: 0,
      qty: 0.0001,
      cum: 0.002,
      remaining: 0,
      seq: 4,
      oid: "ord-src",
    })]);
    assert.ok(third.ledger!.reconciliationCodes.includes("CUMULATIVE_EXCEEDS_ORIGINAL"));
    assert.equal(third.ledger!.ingested.filter((row) => row.accepted).reduce((s, row) => s + row.incrementalQuantity, 0), 0.0004);
  });

  it("F-08 telemetry failure does not lose strategy obligation", () => {
    const dir = tmpDir("f08");
    const record = exec({ tid: "tr-tel", side: "buy", level: 0, qty: SIZE });
    const result = ingest(dir, [record]);
    assert.equal(result.proven, true);
    const published = publishExecutionJournal(() => false, drainOf([record]));
    assert.deepEqual(published, []);
    const loaded = loadStrategyLedger({ path: ledgerPath(dir), identity: identity() });
    assert.equal(loaded.condition, "VALID");
    assert.equal(loaded.ledger.obligations.length, 1);
    assert.equal(loaded.ledger.obligations[0]!.lifecycle, "READY");
  });

  it("F-09 strategy ledger failure prevents telemetry ACK and risk increase", () => {
    const dir = tmpDir("f09");
    const record = exec({ tid: "tr-fail", side: "buy", level: 0, qty: SIZE });
    const result = ingest(dir, [record], {
      options: {
        onAtomicWriteStep(step) {
          if (step === "AFTER_WRITE") throw new Error("injected ledger failure");
        },
      },
    });
    assert.equal(result.proven, false);
    assert.equal(result.riskIncreaseBlocked, true);
    assert.deepEqual(result.newlyIngestedDedupeKeys, []);
    const published = result.proven ? publishExecutionJournal(() => true, drainOf([record])) : [];
    const ack = published.filter((key) => result.ackEligibleDedupeKeys.includes(key));
    assert.deepEqual(ack, []);
    const planned = applyPlannerIntentGate(plan([], emptyStrategyLedger(identity()), { forceCancelOnly: true }));
    assert.equal(planned.plannerDisposition, "CANCEL_ONLY_RECONCILIATION");
    assert.equal(placeIntents(planned.intents).length, 0);
    const loaded = loadStrategyLedger({ path: ledgerPath(dir), identity: identity() });
    assert.equal(loaded.condition, "MISSING");
  });

  it("F-10 crash before durable ingest", async () => {
    const dir = tmpDir("f10");
    const experimentId = "test";
    const cursorPath = path.join(dir, "cursor.json");
    const file = ledgerPath(dir, experimentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const killed = await hardKillFWorker({
      action: "ingest",
      ledgerPath: file,
      experimentId,
      tradeId: "tr-f10",
      crashAt: "BEFORE_TEMP_OPEN",
      cursorPath,
    });
    assert.equal(killed.method, "SIGKILL");
    const child = spawnFWorker({
      CLASSIC_F_ACTION: "inspect",
      CLASSIC_F_LEDGER_PATH: file,
      CLASSIC_F_EXPERIMENT_ID: experimentId,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.lastJson.obligationCount, 0);
    const replay = spawnFWorker({
      CLASSIC_F_ACTION: "replay",
      CLASSIC_F_LEDGER_PATH: file,
      CLASSIC_F_CURSOR_PATH: cursorPath,
      CLASSIC_F_EXPERIMENT_ID: experimentId,
      CLASSIC_F_TRADE_ID: "tr-f10",
    });
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(replay.lastJson.obligationCount, 1);
    assert.equal(replay.lastJson.drainCount, 1);
  });

  it("F-11 crash after durable ingest before submit", async () => {
    const dir = tmpDir("f11");
    const file = ledgerPath(dir);
    const first = spawnFWorker({
      CLASSIC_F_ACTION: "ingest",
      CLASSIC_F_LEDGER_PATH: file,
      CLASSIC_F_EXPERIMENT_ID: "test",
      CLASSIC_F_TRADE_ID: "tr-f11",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.lastJson.obligationCount, 1);
    const cid1 = first.lastJson.cids[0];
    const killed = await hardKillFWorker({
      action: "submit",
      ledgerPath: file,
      experimentId: "test",
      tradeId: "tr-f11",
      crashAt: "BEFORE_TEMP_OPEN",
    });
    assert.equal(killed.method, "SIGKILL");
    const inspect = spawnFWorker({
      CLASSIC_F_ACTION: "inspect",
      CLASSIC_F_LEDGER_PATH: file,
      CLASSIC_F_EXPERIMENT_ID: "test",
    });
    assert.deepEqual(inspect.lastJson.lifecycles, ["READY"]);
    assert.deepEqual(inspect.lastJson.cids, [cid1]);
    const loaded = loadStrategyLedger({ path: file, identity: identity() });
    assert.equal(loaded.condition, "VALID");
    const reps = replacementPlaces(plan([], loaded.ledger).intents);
    assert.equal(reps.length, 1);
    assert.equal(reps[0]!.order.clientOrderId, cid1);
  });

  it("F-12 crash after submit before response", async () => {
    const dir = tmpDir("f12");
    const file = ledgerPath(dir);
    const ingestChild = spawnFWorker({
      CLASSIC_F_ACTION: "ingest",
      CLASSIC_F_LEDGER_PATH: file,
      CLASSIC_F_EXPERIMENT_ID: "test",
      CLASSIC_F_TRADE_ID: "tr-f12",
    });
    assert.equal(ingestChild.status, 0, ingestChild.stderr);
    const killed = await hardKillFWorker({
      action: "submit",
      ledgerPath: file,
      experimentId: "test",
      tradeId: "tr-f12",
      crashAt: "AFTER_DIRECTORY_FSYNC",
    });
    assert.equal(killed.method, "SIGKILL");
    const inspect = spawnFWorker({
      CLASSIC_F_ACTION: "inspect",
      CLASSIC_F_LEDGER_PATH: file,
      CLASSIC_F_EXPERIMENT_ID: "test",
    });
    const lifecycles: string[] = inspect.lastJson.lifecycles;
    assert.ok(lifecycles.includes("SUBMITTING"));
    const loaded = loadStrategyLedger({ path: file, identity: identity() });
    assert.equal(loaded.condition, "VALID");
    assert.equal(loaded.ledger.obligations[0]!.lifecycle, "SUBMITTING");
    assert.equal(replacementPlaces(plan([], loaded.ledger).intents).length, 0);
    const cid = loaded.ledger.obligations[0]!.replacementClientOrderId;
    const again = markObligationsSubmitting({
      path: file,
      identity: identity(),
      clientOrderIds: cid ? [cid] : [],
    });
    assert.equal(again.ledger?.obligations[0]!.replacementClientOrderId, cid);
    assert.equal(again.ledger?.obligations[0]!.lifecycle, "SUBMITTING");
  });

  it("F-13 crash after confirmed observation before terminal persist", async () => {
    const dir = tmpDir("f13");
    const file = ledgerPath(dir);
    const killed = await hardKillFWorker({
      action: "confirm",
      ledgerPath: file,
      experimentId: "test",
      tradeId: "tr-f13",
      crashAt: "SECOND_BEFORE_TEMP_OPEN",
    });
    assert.equal(killed.method, "SIGKILL");
    const inspect = spawnFWorker({
      CLASSIC_F_ACTION: "inspect",
      CLASSIC_F_LEDGER_PATH: file,
      CLASSIC_F_EXPERIMENT_ID: "test",
    });
    const lifecycles: string[] = inspect.lastJson.lifecycles;
    assert.equal(lifecycles.includes("TERMINAL_FILLED_OR_REPLACED"), false);
    assert.ok(lifecycles.includes("CONFIRMED_OPEN"));
    const loaded = loadStrategyLedger({ path: file, identity: identity() });
    assert.equal(loaded.condition, "VALID");
    const obl = loaded.ledger.obligations[0]!;
    assert.equal(obl.lifecycle, "CONFIRMED_OPEN");
    const openOrders = [live({
      id: "rep-1",
      side: obl.targetSide ?? "sell",
      level: obl.targetLevelIndex ?? 1,
      size: obl.placementQuantity || SIZE,
      clientOrderId: obl.replacementClientOrderId || "",
      exchangeOrderId: "ex-rep",
    })];
    const completed = applyReplacementDispositions({
      path: file,
      identity: identity(),
      applyResult: { placed: 0, cancelled: 0, failed: 0, errors: [] },
      placedClientOrderIds: [],
      openOrders,
    });
    assert.equal(completed.ledger?.obligations[0]!.lifecycle, "TERMINAL_FILLED_OR_REPLACED");
    assert.equal(replacementPlaces(plan(openOrders, completed.ledger).intents).length, 0);
  });

  it("F-14 crash after strategy completion before telemetry ACK", () => {
    const dir = tmpDir("f14");
    const cursorPath = path.join(dir, "cursor.json");
    const file = ledgerPath(dir);
    const replay1 = spawnFWorker({
      CLASSIC_F_ACTION: "replay",
      CLASSIC_F_LEDGER_PATH: file,
      CLASSIC_F_CURSOR_PATH: cursorPath,
      CLASSIC_F_EXPERIMENT_ID: "test",
      CLASSIC_F_TRADE_ID: "tr-f14",
    });
    assert.equal(replay1.status, 0, replay1.stderr);
    assert.equal(replay1.lastJson.obligationCount, 1);
    const replay2 = spawnFWorker({
      CLASSIC_F_ACTION: "replay",
      CLASSIC_F_LEDGER_PATH: file,
      CLASSIC_F_CURSOR_PATH: cursorPath,
      CLASSIC_F_EXPERIMENT_ID: "test",
      CLASSIC_F_TRADE_ID: "tr-f14",
    });
    assert.equal(replay2.lastJson.obligationCount, 1);
    assert.deepEqual(replay2.lastJson.newly, []);
  });

  it("F-15 stale anchor epoch", () => {
    const dir = tmpDir("f15");
    const result = ingest(dir, [exec({ tid: "tr-stale", cid: `${PREFIX}41-buy-0` })]);
    assert.equal(result.ledger!.reconciliationRequired, true);
    assert.ok(result.ledger!.reconciliationCodes.includes("STALE_ANCHOR_EPOCH"));
    assert.equal(plannerObligationsFromLedger(result.ledger!).length, 0);
    assert.equal(placeIntents(applyPlannerIntentGate(plan([], result.ledger)).intents).filter((i) => i.order.clientOrderId?.includes("-r-")).length, 0);
  });

  it("F-16 wrong market", () => {
    const dir = tmpDir("f16");
    const result = ingest(dir, [exec({ tid: "tr-mkt", market: "ETH-USD" })]);
    assert.ok(result.ledger!.reconciliationCodes.includes("WRONG_MARKET"));
    assert.equal(plannerObligationsFromLedger(result.ledger!).length, 0);
  });

  it("F-17 wrong venue", () => {
    const dir = tmpDir("f17");
    const result = ingest(dir, [exec({ tid: "tr-ven", venue: "risex" })]);
    assert.ok(result.ledger!.reconciliationCodes.includes("WRONG_VENUE"));
    assert.equal(plannerObligationsFromLedger(result.ledger!).length, 0);
  });

  it("F-18 malformed ownership prefix", () => {
    const dir = tmpDir("f18");
    const result = ingest(dir, [exec({ tid: "tr-pre", cid: "other:42-buy-0" })]);
    assert.ok(result.ledger!.reconciliationCodes.includes("MALFORMED_OWNERSHIP_PREFIX"));
    assert.equal(plannerObligationsFromLedger(result.ledger!).length, 0);
  });

  it("F-19 unknown order identity", () => {
    const dir = tmpDir("f19");
    const result = ingest(dir, [exec({ tid: "tr-unk", cid: "", oid: "ord-unknown" })]);
    assert.ok(result.ledger!.reconciliationCodes.includes("UNKNOWN_ORDER_IDENTITY"));
    assert.equal(plannerObligationsFromLedger(result.ledger!).length, 0);
  });

  it("F-20 alias conflict", () => {
    const dir = tmpDir("f20");
    const first = ingest(dir, [exec({ tid: "tr-alias-1", cid: cid("buy", 0), oid: "shared" })]);
    assert.equal(first.proven, true);
    const second = ingest(dir, [exec({ tid: "tr-alias-2", side: "sell", level: 2, cid: cid("sell", 2), oid: "shared", seq: 3 })]);
    assert.ok(second.ledger!.reconciliationCodes.includes("ALIAS_CONFLICT"));
    assert.equal(second.riskIncreaseBlocked, true);
  });

  it("F-21 sequence gap", () => {
    const dir = tmpDir("f21");
    const result = ingest(dir, [exec({ tid: "tr-gap" })], {
      faults: [{
        event: "EXECUTION_RECONCILIATION_REQUIRED",
        code: "SEQUENCE_GAP",
        observedAt: new Date().toISOString(),
        streamConnectionId: "conn-1",
        streamSequence: 9,
      }],
    });
    assert.ok(result.ledger!.reconciliationCodes.includes("SEQUENCE_GAP"));
    assert.equal(result.riskIncreaseBlocked, true);
    assert.equal(placeIntents(applyPlannerIntentGate(plan([], result.ledger)).intents).length, 0);
  });

  it("F-22 cursor conflict", () => {
    const dir = tmpDir("f22");
    const result = ingest(dir, [exec({ tid: "tr-cur" })], {
      faults: [{
        event: "EXECUTION_RECONCILIATION_REQUIRED",
        code: "CURSOR_CONFLICT",
        observedAt: new Date().toISOString(),
        streamConnectionId: "conn-1",
      }],
    });
    assert.ok(result.ledger!.reconciliationCodes.includes("CURSOR_CONFLICT"));
    assert.equal(result.riskIncreaseBlocked, true);
  });

  it("F-23 journal capacity fault", () => {
    const dir = tmpDir("f23");
    const result = ingest(dir, [exec({ tid: "tr-cap" })], {
      faults: [{
        event: "EXECUTION_RECONCILIATION_REQUIRED",
        code: "JOURNAL_CAPACITY",
        observedAt: new Date().toISOString(),
        streamConnectionId: "conn-1",
      }],
    });
    assert.ok(result.ledger!.reconciliationCodes.includes("JOURNAL_CAPACITY"));
    assert.equal(result.riskIncreaseBlocked, true);
  });

  it("F-24 apply REJECTED", () => {
    const dir = tmpDir("f24");
    const result = ingest(dir, [exec({ tid: "tr-rej" })]);
    const obl = plannerObligationsFromLedger(result.ledger!)[0]!;
    markObligationsSubmitting({
      path: ledgerPath(dir),
      identity: identity(),
      clientOrderIds: [obl.replacementClientOrderId],
    });
    const applied = applyReplacementDispositions({
      path: ledgerPath(dir),
      identity: identity(),
      applyResult: { placed: 0, cancelled: 0, failed: 1, errors: ["REJECTED"] },
      placedClientOrderIds: [obl.replacementClientOrderId],
      openOrders: [],
    });
    assert.equal(applied.ledger!.obligations[0]!.lastApplyDisposition, "REJECTED");
    assert.equal(applied.ledger!.obligations[0]!.lifecycle, "READY");
    assert.equal(applied.ledger!.obligations[0]!.replacementClientOrderId, obl.replacementClientOrderId);
    const reps = replacementPlaces(plan([], applied.ledger).intents);
    assert.equal(reps.length, 1);
    assert.equal(reps[0]!.order.clientOrderId, obl.replacementClientOrderId);
  });

  it("F-25 apply UNKNOWN / ambiguous", () => {
    const dir = tmpDir("f25");
    const result = ingest(dir, [exec({ tid: "tr-unk-apply" })]);
    const obl = plannerObligationsFromLedger(result.ledger!)[0]!;
    markObligationsSubmitting({
      path: ledgerPath(dir),
      identity: identity(),
      clientOrderIds: [obl.replacementClientOrderId],
    });
    const applied = applyReplacementDispositions({
      path: ledgerPath(dir),
      identity: identity(),
      applyResult: { placed: 0, cancelled: 0, failed: 0, errors: [], ambiguous: true },
      placedClientOrderIds: [obl.replacementClientOrderId],
      openOrders: [],
    });
    assert.equal(applied.ledger!.obligations[0]!.lifecycle, "SUBMIT_UNKNOWN");
    assert.equal(applied.ledger!.obligations[0]!.lastApplyDisposition, "UNKNOWN");
    assert.equal(replacementPlaces(plan([], applied.ledger).intents).length, 0);
    const sameCid = applied.ledger!.obligations[0]!.replacementClientOrderId;
    markObligationsSubmitting({
      path: ledgerPath(dir),
      identity: identity(),
      clientOrderIds: ["fresh-second-id"],
    });
    const loaded = loadStrategyLedger({ path: ledgerPath(dir), identity: identity() });
    assert.equal(loaded.condition, "VALID");
    assert.equal(loaded.ledger.obligations[0]!.replacementClientOrderId, sameCid);
  });

  it("F-26 existing exact replacement -> no duplicate", () => {
    const dir = tmpDir("f26");
    const result = ingest(dir, [exec({ tid: "tr-exist" })]);
    const obl = plannerObligationsFromLedger(result.ledger!)[0]!;
    const openOrders = [live({
      id: "already",
      side: obl.targetSide,
      level: obl.targetLevelIndex,
      size: obl.outstandingQuantity,
      clientOrderId: obl.replacementClientOrderId,
      exchangeOrderId: "ex-already",
    })];
    const planned = plan(openOrders, result.ledger);
    assert.equal(replacementPlaces(planned.intents).length, 0);
  });

  it("F-27 target occupied by unowned order -> no cancel and risk increase blocked", () => {
    const dir = tmpDir("f27");
    const result = ingest(dir, [exec({ tid: "tr-unown" })]);
    const obl = plannerObligationsFromLedger(result.ledger!)[0]!;
    const openOrders = [live({
      id: "manual",
      side: obl.targetSide,
      level: obl.targetLevelIndex,
      clientOrderId: "manual-bot",
    })];
    const planned = applyPlannerIntentGate(plan(openOrders, result.ledger));
    assert.equal(planned.intents.some((intent) => intent.type === "cancel" && intent.orderId === "manual"), false);
    assert.equal(planned.riskIncreaseBlocked, true);
    assert.equal(placeIntents(planned.intents).length, 0);
  });

  it("F-28 target occupied by malformed owned order", () => {
    const dir = tmpDir("f28");
    const result = ingest(dir, [exec({ tid: "tr-mal" })]);
    const obl = plannerObligationsFromLedger(result.ledger!)[0]!;
    const openOrders = [live({
      id: "bad",
      side: obl.targetSide,
      level: obl.targetLevelIndex,
      size: SIZE * 4,
      clientOrderId: cid(obl.targetSide, obl.targetLevelIndex),
      exchangeOrderId: "ex-bad",
    })];
    const planned = plan(openOrders, result.ledger);
    assert.ok(planned.intents.some((intent) => intent.type === "cancel" && intent.orderId === "bad"));
    assert.equal(replacementPlaces(planned.intents).length, 0);
  });

  it("F-29 no fill inference from open-order disappearance", () => {
    const prev = new Map([["gone", { levelIndex: 0, side: "buy" as const, price: LEVELS[0]!, size: SIZE }]]);
    const planned = plan([], null, { prevActive: prev });
    assert.deepEqual(planned.filled, []);
    assert.equal(planned.completedRungs, 0);
    assert.equal(replacementPlaces(planned.intents).length, 0);
  });

  it("F-30 no fill inference from position delta", () => {
    const dir = tmpDir("f30");
    const result = ingest(dir, []);
    assert.equal(result.ledger!.obligations.length, 0);
    const metrics = authoritativeMetrics(result.ledger!);
    assert.equal(metrics.pairedQuantity, 0);
    assert.equal(metrics.grossProfitUsd, 0);
    const planned = plan([], result.ledger);
    assert.deepEqual(planned.filled, []);
    assert.equal(planned.completedRungs, 0);
  });

  it("F-31 restart replay exactly once", () => {
    const dir = tmpDir("f31");
    const row = exec({ tid: "tr-once" });
    const first = ingest(dir, [row]);
    const second = ingest(dir, [row]);
    assert.equal(first.ledger!.obligations.length, 1);
    assert.equal(second.ledger!.obligations.length, 1);
    assert.deepEqual(second.newlyIngestedDedupeKeys, []);
    assert.equal(second.ledger!.obligations[0]!.obligationId, first.ledger!.obligations[0]!.obligationId);
  });

  it("F-32 deterministic clientOrderId collision protection", () => {
    const dir = tmpDir("f32");
    const plantedId = strategyLedgerIdentity({
      experimentId: "test",
      scopeKey: "dry-run:extended:BTC",
      venue: "extended",
      market: MARKET,
      anchorEpoch: EPOCH,
    });
    const file = ledgerPath(dir);
    const incoming = exec({ tid: "tr-collide" });
    const token = sha256Canonical(`ex:${incoming.dedupeKey}`).slice(0, 16);
    const collisionCid = `${PREFIX}${EPOCH}-sell-1-r-${token}`;
    const payload = emptyStrategyLedger(plantedId);
    payload.obligations.push({
      obligationId: "ex:other",
      sourceDedupeKey: "extended|BTC-USD|trade|other",
      sourceOrderIdentity: cid("buy", 0),
      sourceSide: "buy",
      sourceLevelIndex: 0,
      targetSide: "sell",
      targetLevelIndex: 1,
      authoritativeExecutedQuantity: SIZE,
      alreadyRepresentedQuantity: 0,
      outstandingQuantity: SIZE,
      placementQuantity: SIZE,
      anchorEpoch: EPOCH,
      lifecycle: "READY",
      replacementClientOrderId: collisionCid,
      lastApplyDisposition: null,
      retryCount: 0,
      ingestSequence: 1,
      createdAt: new Date(EPOCH).toISOString(),
      updatedAt: new Date(EPOCH).toISOString(),
    });
    payload.nextSequence = 2;
    const persisted = persistStrategyLedger({ path: file, identity: plantedId, ledger: payload });
    assert.equal(persisted.proven, true);
    const result = ingest(dir, [incoming]);
    assert.ok(result.ledger!.reconciliationCodes.includes("CLIENT_ORDER_ID_COLLISION"));
    const colliding = result.ledger!.obligations.filter((row) => row.sourceDedupeKey === incoming.dedupeKey);
    assert.equal(colliding[0]!.lifecycle, "RECONCILIATION_REQUIRED");
    assert.equal(colliding[0]!.replacementClientOrderId, null);
  });

  it("F-33 ledger corrupt/truncated/wrong-scope", () => {
    const dir = tmpDir("f33");
    const file = ledgerPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{", "utf8");
    const truncated = ingestAuthoritativeDrain({
      path: file,
      identity: identity(),
      drain: drainOf([exec({ tid: "tr-trunc" })]),
      ownershipPrefix: PREFIX,
      levels: LEVELS,
      spacing: SPACING,
      sizeBase: SIZE,
      mode: "neutral",
    });
    assert.equal(truncated.proven, false);
    assert.equal(truncated.riskIncreaseBlocked, true);

    const dir2 = tmpDir("f33b");
    const file2 = ledgerPath(dir2);
    fs.mkdirSync(path.dirname(file2), { recursive: true });
    fs.writeFileSync(file2, JSON.stringify({ schemaVersion: 2, kind: STRATEGY_LEDGER_KIND, payload: { nope: true } }), "utf8");
    const corrupt = ingestAuthoritativeDrain({
      path: file2,
      identity: identity(),
      drain: drainOf([exec({ tid: "tr-cor" })]),
      ownershipPrefix: PREFIX,
      levels: LEVELS,
      spacing: SPACING,
      sizeBase: SIZE,
      mode: "neutral",
    });
    assert.equal(corrupt.proven, false);

    const dir3 = tmpDir("f33c");
    const ident = identity();
    const empty = emptyStrategyLedger(ident);
    const envelope = createChecksummedEnvelopeV2({
      kind: STRATEGY_LEDGER_KIND,
      experimentId: ident.experimentId,
      scopeKey: "other-scope",
      storeGeneration: 1,
      leaseGeneration: null,
      createdAt: new Date(EPOCH).toISOString(),
      writtenAt: new Date(EPOCH).toISOString(),
      previousEnvelopeSha256: null,
      payload: { ...empty, scopeKey: "other-scope" },
    });
    const file3 = ledgerPath(dir3);
    fs.mkdirSync(path.dirname(file3), { recursive: true });
    fs.writeFileSync(file3, serializeChecksummedEnvelopeV2(envelope), "utf8");
    const scoped = ingestAuthoritativeDrain({
      path: file3,
      identity: ident,
      drain: drainOf([exec({ tid: "tr-scope" })]),
      ownershipPrefix: PREFIX,
      levels: LEVELS,
      spacing: SPACING,
      sizeBase: SIZE,
      mode: "neutral",
    });
    assert.equal(scoped.proven, false);
    assert.equal(scoped.riskIncreaseBlocked, true);

    const dir4 = tmpDir("f33d");
    const wrongMarket = emptyStrategyLedger(ident);
    wrongMarket.market = "ETH-USD";
    const envMarket = createChecksummedEnvelopeV2({
      kind: STRATEGY_LEDGER_KIND,
      experimentId: ident.experimentId,
      scopeKey: ident.scopeKey,
      storeGeneration: 1,
      leaseGeneration: null,
      createdAt: new Date(EPOCH).toISOString(),
      writtenAt: new Date(EPOCH).toISOString(),
      previousEnvelopeSha256: null,
      payload: wrongMarket,
    });
    const file4 = ledgerPath(dir4);
    fs.mkdirSync(path.dirname(file4), { recursive: true });
    fs.writeFileSync(file4, serializeChecksummedEnvelopeV2(envMarket), "utf8");
    const marketMismatch = ingestAuthoritativeDrain({
      path: file4,
      identity: ident,
      drain: drainOf([exec({ tid: "tr-mkt-led" })]),
      ownershipPrefix: PREFIX,
      levels: LEVELS,
      spacing: SPACING,
      sizeBase: SIZE,
      mode: "neutral",
    });
    assert.equal(marketMismatch.proven, false);
    assert.equal(marketMismatch.riskIncreaseBlocked, true);

    const dir5 = tmpDir("f33e");
    const wrongEpoch = emptyStrategyLedger(ident);
    wrongEpoch.anchorEpoch = 7;
    const envEpoch = createChecksummedEnvelopeV2({
      kind: STRATEGY_LEDGER_KIND,
      experimentId: ident.experimentId,
      scopeKey: ident.scopeKey,
      storeGeneration: 1,
      leaseGeneration: null,
      createdAt: new Date(EPOCH).toISOString(),
      writtenAt: new Date(EPOCH).toISOString(),
      previousEnvelopeSha256: null,
      payload: wrongEpoch,
    });
    const file5 = ledgerPath(dir5);
    fs.mkdirSync(path.dirname(file5), { recursive: true });
    fs.writeFileSync(file5, serializeChecksummedEnvelopeV2(envEpoch), "utf8");
    const epochMismatch = ingestAuthoritativeDrain({
      path: file5,
      identity: ident,
      drain: drainOf([exec({ tid: "tr-epoch-led" })]),
      ownershipPrefix: PREFIX,
      levels: LEVELS,
      spacing: SPACING,
      sizeBase: SIZE,
      mode: "neutral",
    });
    assert.equal(epochMismatch.proven, false);
    assert.equal(epochMismatch.riskIncreaseBlocked, true);
  });

  it("F-34 authoritative metrics require execution-pair proof", () => {
    const dir = tmpDir("f34");
    const buy = ingest(dir, [exec({ tid: "tr-buy-m", side: "buy", level: 0, qty: 0.0004, cum: 0.0004 })]);
    const afterBuy = authoritativeMetrics(buy.ledger!);
    assert.equal(afterBuy.pairedQuantity, 0);
    assert.equal(afterBuy.grossProfitUsd, 0);
    assert.equal(afterBuy.feeBasis, "gross");
    const paired = ingest(dir, [exec({ tid: "tr-sell-m", side: "sell", level: 1, qty: 0.0004, cum: 0.0004, seq: 3, oid: "ord-sell" })]);
    const metrics = authoritativeMetrics(paired.ledger!);
    assert.equal(metrics.pairedQuantity, 0.0004);
    assert.equal(metrics.grossProfitUsd, SPACING * 0.0004);
    assert.equal(metrics.completedRungs, 0.0004 / SIZE);
    assert.equal(metrics.feeBasis, "gross");
    const emptyMetrics = authoritativeMetrics(emptyStrategyLedger(identity()));
    assert.equal(emptyMetrics.pairedQuantity, 0);
  });

  it("F-35 telemetry cursor and strategy consumption state remain independent", () => {
    const dir = tmpDir("f35");
    const cursorPath = path.join(dir, "cursor.json");
    const state = new ExtendedAccountStreamState(Date.now, {
      cursorPath,
      cursorIdentity: {
        experimentId: "test",
        scopeKey: "dry-run:extended:BTC",
        venue: "extended",
        market: "BTC",
      },
    });
    const ts = Date.now();
    state.ingest({ type: "BALANCE", data: { balance: { equity: "50" } }, ts, seq: 1 });
    state.ingest({ type: "POSITION", data: { positions: [] }, ts, seq: 1 });
    state.ingest({ type: "ORDER", data: { orders: [] }, ts, seq: 1 });
    state.ingest({
      type: "TRADE",
      ts: ts + 1,
      seq: 2,
      data: {
        trades: [{
          id: "tr-ind",
          market: "BTC-USD",
          side: "BUY",
          price: "99000",
          qty: "0.001",
          orderId: "ord-1",
          externalId: cid("buy", 0),
          filledQty: "0.001",
          remainingQty: "0",
        }],
      },
    });
    const drain = state.drainJournal();
    assert.equal(drain.authoritativeExecutions.length, 1);
    const result = ingestAuthoritativeDrain({
      path: ledgerPath(dir),
      identity: identity(),
      drain,
      ownershipPrefix: PREFIX,
      levels: LEVELS,
      spacing: SPACING,
      sizeBase: SIZE,
      mode: "neutral",
    });
    assert.equal(result.proven, true);
    assert.equal(result.ledger!.obligations.length, 1);
    const again = state.drainJournal();
    assert.equal(again.authoritativeExecutions.length, 1);
    const published = publishExecutionJournal(() => false, again);
    assert.deepEqual(published, []);
    const still = state.drainJournal();
    assert.equal(still.authoritativeExecutions.length, 1);
    const replay = ingestAuthoritativeDrain({
      path: ledgerPath(dir),
      identity: identity(),
      drain: still,
      ownershipPrefix: PREFIX,
      levels: LEVELS,
      spacing: SPACING,
      sizeBase: SIZE,
      mode: "neutral",
    });
    assert.deepEqual(replay.newlyIngestedDedupeKeys, []);
    assert.equal(replay.ledger!.obligations.length, 1);
    const okPublish = publishExecutionJournal(() => true, still);
    assert.equal(okPublish.length, 1);
    state.acknowledgeJournal(okPublish);
    const afterAck = state.drainJournal();
    assert.equal(afterAck.authoritativeExecutions.length, 0);
    const loaded = loadStrategyLedger({ path: ledgerPath(dir), identity: identity() });
    assert.equal(loaded.condition, "VALID");
    assert.equal(loaded.ledger.obligations.length, 1);
  });

  it("F-36 non-authoritative and inferred executions are ignored", () => {
    const dir = tmpDir("f36");
    const rejected = ingest(dir, [exec({ tid: "tr-na", authoritative: false })]);
    assert.ok(rejected.ledger!.reconciliationCodes.includes("NOT_AUTHORITATIVE"));
    assert.equal(plannerObligationsFromLedger(rejected.ledger!).length, 0);
    const inferred = exec({ tid: "tr-inf" });
    const ignored = ingestAuthoritativeDrain({
      path: ledgerPath(dir, "inf"),
      identity: identity("inf"),
      drain: {
        executions: [inferred],
        authoritativeExecutions: [],
        faults: [],
        authority: "trusted",
        authoritativeCount: 0,
      },
      ownershipPrefix: PREFIX,
      levels: LEVELS,
      spacing: SPACING,
      sizeBase: SIZE,
      mode: "neutral",
    });
    assert.equal(ignored.proven, true);
    assert.equal(ignored.ledger!.obligations.length, 0);
    assert.equal(ignored.newlyIngestedDedupeKeys.length, 0);
  });

  it("F-37 empty or malformed dedupeKey fails closed", () => {
    const dir = tmpDir("f37");
    const emptyKey = { ...exec({ tid: "tr-empty" }), dedupeKey: "" };
    const result = ingestAuthoritativeDrain({
      path: ledgerPath(dir),
      identity: identity(),
      drain: drainOf([emptyKey]),
      ownershipPrefix: PREFIX,
      levels: LEVELS,
      spacing: SPACING,
      sizeBase: SIZE,
      mode: "neutral",
    });
    assert.equal(result.proven, true);
    assert.ok(result.ledger!.reconciliationCodes.includes("MALFORMED_IDENTITY"));
    assert.equal(plannerObligationsFromLedger(result.ledger!).length, 0);
    assert.equal(result.riskIncreaseBlocked, true);
  });

  it("F-38 non-finite quantity fails closed", () => {
    const dir = tmpDir("f38");
    const nanQty = ingest(dir, [exec({ tid: "tr-nan", qty: Number.NaN })]);
    assert.ok(nanQty.ledger!.reconciliationCodes.includes("NON_FINITE_FIELDS"));
    assert.equal(plannerObligationsFromLedger(nanQty.ledger!).length, 0);
    const infQty = ingest(tmpDir("f38b"), [exec({ tid: "tr-inf-qty", qty: Number.POSITIVE_INFINITY })]);
    assert.ok(infQty.ledger!.reconciliationCodes.includes("NON_FINITE_FIELDS"));
    assert.equal(plannerObligationsFromLedger(infQty.ledger!).length, 0);
  });

  it("F-39 overfill against proven original quantity fails closed", () => {
    const dir = tmpDir("f39");
    const first = ingest(dir, [exec({
      tid: "tr-of1",
      qty: 0.0004,
      cum: 0.0004,
      remaining: 0.0006,
      oid: "ord-over",
    })]);
    assert.equal(first.ledger!.obligations[0]!.authoritativeExecutedQuantity, 0.0004);
    const over = ingest(dir, [exec({
      tid: "tr-of2",
      qty: 0.0008,
      cum: 0.0012,
      remaining: 0,
      seq: 3,
      oid: "ord-over",
    })]);
    assert.ok(over.ledger!.reconciliationCodes.includes("CUMULATIVE_EXCEEDS_ORIGINAL"));
    assert.equal(over.ledger!.ingested.filter((row) => row.accepted).reduce((s, row) => s + row.incrementalQuantity, 0), 0.0004);
    assert.equal(plannerObligationsFromLedger(over.ledger!).length, 1);
    assert.equal(plannerObligationsFromLedger(over.ledger!)[0]!.outstandingQuantity, 0.0004);
  });

  it("F-40 truncated clientOrderId cannot collide with or claim an exact replacement", () => {
    const dir = tmpDir("f40");
    const first = ingest(dir, [exec({ tid: "tr-trunc-src" })]);
    const exact = first.ledger!.obligations[0]!.replacementClientOrderId!;
    assert.match(exact, /-r-[a-f0-9]{16}$/);
    const truncated = exact.slice(0, -2);
    assert.notEqual(truncated, exact);
    const parsedTrunc = truncated.startsWith(PREFIX);
    assert.equal(parsedTrunc, true);
    const replay = ingest(dir, [exec({
      tid: "tr-trunc-fill",
      cid: truncated,
      side: "sell",
      level: 1,
      seq: 3,
      oid: "ord-trunc",
    })]);
    assert.ok(replay.ledger!.reconciliationCodes.includes("MALFORMED_OWNERSHIP_PREFIX"));
    const exactRow = replay.ledger!.obligations.find((row) => row.replacementClientOrderId === exact);
    assert.ok(exactRow);
    assert.equal(exactRow!.lifecycle, "READY");
    assert.equal(replay.ledger!.obligations.filter((row) => row.replacementClientOrderId === truncated).length, 0);
    const openOrders = [live({
      id: "rep-exact",
      side: "sell",
      level: 1,
      clientOrderId: exact,
    })];
    assert.equal(replacementPlaces(plan(openOrders, replay.ledger).intents).length, 0);
  });
});

void STRATEGY_LEDGER_SCHEMA_VERSION;
