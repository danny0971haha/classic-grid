import fs from "node:fs";
import path from "node:path";
import type { StorageOptions } from "../../src/experimentStorage.js";
import { publishExecutionJournal } from "../../src/experimentTelemetry.js";
import { ExtendedAccountStreamState } from "../../src/venues/extendedAccountStream.js";
import {
  applyReplacementDispositions,
  ingestAuthoritativeDrain,
  loadStrategyLedger,
  markObligationsSubmitting,
  plannerObligationsFromLedger,
  strategyLedgerIdentity,
} from "../../src/strategyExecutionLedger.js";
import type { ExecutionRecord, LiveOrder } from "../../src/types.js";

const PREFIX = "cg:test:";
const EPOCH = 42;
const LEVELS = [99_000, 100_000, 101_000];
const SIZE = 0.001;

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

function waitAtBoundary(boundary: string): void {
  const crashAt = String(process.env.CLASSIC_F_CRASH_AT || "").trim();
  if (!crashAt || crashAt !== boundary) return;
  const readyFile = String(process.env.CLASSIC_F_READY_FILE || "").trim();
  const payload = JSON.stringify({ ready: true, boundary, pid: process.pid });
  process.stdout.write(`${payload}\n`);
  if (readyFile) {
    fs.mkdirSync(path.dirname(readyFile), { recursive: true });
    fs.writeFileSync(readyFile, `${boundary}\n${process.pid}\n`);
  }
  if (process.env.CLASSIC_F_HARD_KILL === "1") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
}

function identity() {
  return strategyLedgerIdentity({
    experimentId: process.env.CLASSIC_F_EXPERIMENT_ID || "test",
    scopeKey: process.env.CLASSIC_F_SCOPE || "dry-run:extended:BTC",
    venue: "extended",
    market: "BTC",
    anchorEpoch: EPOCH,
  });
}

function tradeMessage(tradeId: string, seq = 2): object {
  const ts = Date.now();
  return {
    type: "TRADE",
    ts,
    seq,
    data: {
      trades: [{
        id: tradeId,
        market: "BTC-USD",
        side: "BUY",
        price: "99000",
        qty: "0.001",
        orderId: "ord-1",
        externalId: `${PREFIX}${EPOCH}-buy-0`,
        filledQty: "0.001",
        remainingQty: "0",
        timestamp: ts,
      }],
    },
  };
}

function initialize(state: ExtendedAccountStreamState): void {
  const ts = Date.now();
  state.ingest({ type: "BALANCE", data: { balance: { equity: "50" } }, ts, seq: 1 });
  state.ingest({ type: "POSITION", data: { positions: [] }, ts, seq: 1 });
  state.ingest({ type: "ORDER", data: { orders: [] }, ts, seq: 1 });
}

function makeCrashOptions(persistWrites: { count: number }): StorageOptions | undefined {
  const crashAt = String(process.env.CLASSIC_F_CRASH_AT || "").trim();
  if (!crashAt) return undefined;
  return {
    onAtomicWriteStep(step) {
      if (crashAt.startsWith("SECOND_") && persistWrites.count < 1) {
        if (step === "AFTER_DIRECTORY_FSYNC") persistWrites.count += 1;
        return;
      }
      const boundary = crashAt.startsWith("SECOND_") ? crashAt.slice("SECOND_".length) : crashAt;
      if (step === boundary) {
        waitAtBoundary(crashAt.startsWith("SECOND_") ? crashAt : step);
      }
      if (step === "AFTER_DIRECTORY_FSYNC") persistWrites.count += 1;
    },
  };
}

function ingestArgs(ledgerPath: string, options?: StorageOptions) {
  return {
    path: ledgerPath,
    identity: identity(),
    ownershipPrefix: PREFIX,
    levels: LEVELS,
    spacing: 1_000,
    sizeBase: SIZE,
    mode: "neutral" as const,
    options,
  };
}

function syntheticBuy(tradeId: string): ExecutionRecord {
  return {
    source: "exchange",
    venue: "extended",
    market: "BTC-USD",
    side: "buy",
    price: 99_000,
    quantity: 0.001,
    exchangeTradeId: tradeId,
    exchangeOrderId: "ord-1",
    clientOrderId: `${PREFIX}${EPOCH}-buy-0`,
    observedAt: new Date().toISOString(),
    streamConnectionId: "conn",
    streamSequence: 2,
    dedupeKey: `extended|BTC-USD|trade|${tradeId}`,
    authoritative: true,
  };
}

const action = String(process.env.CLASSIC_F_ACTION || "ingest");
const ledgerPath = required("CLASSIC_F_LEDGER_PATH");
const tradeId = process.env.CLASSIC_F_TRADE_ID || "tr-crash";
const persistWrites = { count: 0 };
const crashOptions = makeCrashOptions(persistWrites);

try {
  if (action === "inspect") {
    const loaded = loadStrategyLedger({ path: ledgerPath, identity: identity() });
    process.stdout.write(`${JSON.stringify({
      label: "inspect",
      condition: loaded.condition,
      obligationCount: loaded.condition === "VALID" || loaded.condition === "MISSING" ? loaded.ledger.obligations.length : 0,
      lifecycles: loaded.condition === "VALID" || loaded.condition === "MISSING"
        ? loaded.ledger.obligations.map((row) => row.lifecycle)
        : [],
      cids: loaded.condition === "VALID" || loaded.condition === "MISSING"
        ? loaded.ledger.obligations.map((row) => row.replacementClientOrderId)
        : [],
      ingested: loaded.condition === "VALID" || loaded.condition === "MISSING"
        ? loaded.ledger.ingested.map((row) => row.dedupeKey)
        : [],
    })}\n`);
    process.exit(0);
  }

  if (action === "ingest") {
    const cursorPath = process.env.CLASSIC_F_CURSOR_PATH || "";
    const drainRecords: ExecutionRecord[] = [];
    let faults: { event: "EXECUTION_RECONCILIATION_REQUIRED"; code: "SEQUENCE_GAP"; observedAt: string; streamConnectionId: string }[] = [];
    let authority: "trusted" | "invalidated" = "trusted";
    if (cursorPath) {
      const state = new ExtendedAccountStreamState(Date.now, {
        cursorPath,
        cursorIdentity: {
          experimentId: identity().experimentId,
          scopeKey: identity().scopeKey,
          venue: "extended",
          market: "BTC",
        },
      });
      initialize(state);
      state.ingest(tradeMessage(tradeId));
      const drain = state.drainJournal();
      drainRecords.push(...drain.authoritativeExecutions);
      faults = drain.faults as typeof faults;
      authority = drain.authority;
    } else {
      drainRecords.push(syntheticBuy(tradeId));
    }
    const result = ingestAuthoritativeDrain({
      ...ingestArgs(ledgerPath, crashOptions),
      drain: { authoritativeExecutions: drainRecords, faults, authority },
    });
    process.stdout.write(`${JSON.stringify({
      label: "ingest",
      proven: result.proven,
      obligationCount: result.ledger?.obligations.length ?? 0,
      cids: result.ledger?.obligations.map((row) => row.replacementClientOrderId) ?? [],
      newly: result.newlyIngestedDedupeKeys,
    })}\n`);
    process.exit(0);
  }

  if (action === "submit") {
    ingestAuthoritativeDrain({
      ...ingestArgs(ledgerPath),
      drain: {
        authoritativeExecutions: [syntheticBuy(tradeId)],
        faults: [],
        authority: "trusted",
      },
    });
    const loaded = loadStrategyLedger({ path: ledgerPath, identity: identity() });
    if (loaded.condition !== "VALID" && loaded.condition !== "MISSING") process.exit(1);
    const cids = plannerObligationsFromLedger(loaded.ledger)
      .map((row) => row.replacementClientOrderId)
      .filter(Boolean);
    const marked = markObligationsSubmitting({
      path: ledgerPath,
      identity: identity(),
      clientOrderIds: cids,
      options: crashOptions,
    });
    process.stdout.write(`${JSON.stringify({
      label: "submit",
      proven: marked.proven,
      lifecycles: marked.ledger?.obligations.map((row) => row.lifecycle) ?? [],
      cids,
    })}\n`);
    process.exit(0);
  }

  if (action === "confirm") {
    ingestAuthoritativeDrain({
      ...ingestArgs(ledgerPath),
      drain: {
        authoritativeExecutions: [syntheticBuy(tradeId)],
        faults: [],
        authority: "trusted",
      },
    });
    const loaded = loadStrategyLedger({ path: ledgerPath, identity: identity() });
    if (loaded.condition !== "VALID" && loaded.condition !== "MISSING") process.exit(1);
    const obl = plannerObligationsFromLedger(loaded.ledger)[0];
    if (!obl) process.exit(1);
    markObligationsSubmitting({
      path: ledgerPath,
      identity: identity(),
      clientOrderIds: [obl.replacementClientOrderId],
    });
    const openOrders: LiveOrder[] = [{
      id: "rep-1",
      market: "BTC",
      side: obl.targetSide,
      price: LEVELS[obl.targetLevelIndex]!,
      size: obl.placementQuantity,
      level: obl.targetLevelIndex,
      clientOrderId: obl.replacementClientOrderId,
      exchangeOrderId: "ex-rep-1",
    }];
    const completed = applyReplacementDispositions({
      path: ledgerPath,
      identity: identity(),
      applyResult: { placed: 1, cancelled: 0, failed: 0, errors: [] },
      placedClientOrderIds: [obl.replacementClientOrderId],
      openOrders,
      persistConfirmedBeforeTerminal: true,
      options: crashOptions,
    });
    process.stdout.write(`${JSON.stringify({
      label: "confirm",
      proven: completed.proven,
      lifecycles: completed.ledger?.obligations.map((row) => row.lifecycle) ?? [],
    })}\n`);
    process.exit(0);
  }

  if (action === "replay") {
    const cursorPath = required("CLASSIC_F_CURSOR_PATH");
    const state = new ExtendedAccountStreamState(Date.now, {
      cursorPath,
      cursorIdentity: {
        experimentId: identity().experimentId,
        scopeKey: identity().scopeKey,
        venue: "extended",
        market: "BTC",
      },
    });
    initialize(state);
    state.ingest(tradeMessage(tradeId));
    const drain = state.drainJournal();
    const ingested = ingestAuthoritativeDrain({
      ...ingestArgs(ledgerPath, crashOptions),
      drain,
    });
    const fills: string[] = [];
    publishExecutionJournal((event, fields) => {
      if (event === "FILL") fills.push(String(fields?.exchange_trade_id ?? ""));
      return true;
    }, drain);
    process.stdout.write(`${JSON.stringify({
      label: "replay",
      proven: ingested.proven,
      obligationCount: ingested.ledger?.obligations.length ?? 0,
      newly: ingested.newlyIngestedDedupeKeys,
      fills,
      drainCount: drain.authoritativeExecutions.length,
    })}\n`);
    process.exit(0);
  }

  process.stderr.write(`unknown action ${action}\n`);
  process.exit(2);
} catch (error) {
  process.stderr.write(`${String((error as Error)?.message || error)}\n`);
  process.exit(1);
}
