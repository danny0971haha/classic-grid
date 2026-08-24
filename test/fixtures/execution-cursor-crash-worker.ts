import fs from "node:fs";
import path from "node:path";
import { publishExecutionJournal } from "../../src/experimentTelemetry.js";
import { ExtendedAccountStreamState } from "../../src/venues/extendedAccountStream.js";

type WorkerAction = "accept" | "inspect" | "replay";

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

function waitAtBoundary(boundary: string): void {
  const crashAt = String(process.env.CLASSIC_CURSOR_CRASH_AT || "").trim();
  if (!crashAt || crashAt !== boundary) return;
  const readyFile = String(process.env.CLASSIC_CURSOR_READY_FILE || "").trim();
  const payload = JSON.stringify({ ready: true, boundary, pid: process.pid });
  process.stdout.write(`${payload}\n`);
  if (readyFile) {
    fs.mkdirSync(path.dirname(readyFile), { recursive: true });
    fs.writeFileSync(readyFile, `${boundary}\n${process.pid}\n`);
  }
  if (process.env.CLASSIC_CURSOR_HARD_KILL === "1") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
}

function bind() {
  return {
    experimentId: process.env.CLASSIC_CURSOR_EXPERIMENT_ID || "classic-cursor-crash",
    scopeKey: process.env.CLASSIC_CURSOR_SCOPE || "dry-run:extended:BTC",
    venue: "extended",
    market: "BTC",
  };
}

function tradeMessage(tradeId: string, seq = 2) {
  const ts = Date.now();
  return {
    type: "TRADE" as const,
    ts,
    seq,
    data: {
      trades: [{
        id: tradeId,
        market: "BTC-USD",
        side: "BUY",
        price: "100000",
        qty: "0.001",
        orderId: "ord-1",
        externalId: "cg:1-buy-3",
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

function landedCursor(cursorPath: string): { exists: boolean; valid: boolean | null; pendingTradeIds: string[]; publishedCount: number } {
  if (!fs.existsSync(cursorPath)) {
    return { exists: false, valid: null, pendingTradeIds: [], publishedCount: 0 };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorPath, "utf8")) as {
      version?: number;
      pendingAuthoritative?: Array<{ exchangeTradeId?: string }>;
      publishedDedupeKeys?: unknown;
    };
    const pending = Array.isArray(parsed.pendingAuthoritative) ? parsed.pendingAuthoritative : [];
    return {
      exists: true,
      valid: parsed.version === 2,
      pendingTradeIds: pending.map((row) => String(row.exchangeTradeId || "")),
      publishedCount: Array.isArray(parsed.publishedDedupeKeys) ? parsed.publishedDedupeKeys.length : 0,
    };
  } catch {
    return { exists: true, valid: false, pendingTradeIds: [], publishedCount: 0 };
  }
}

const action = (process.env.CLASSIC_CURSOR_ACTION || "accept") as WorkerAction;
const cursorPath = required("CLASSIC_CURSOR_PATH");
const tradeId = process.env.CLASSIC_CURSOR_TRADE_ID || "tr-crash";

try {
  if (action === "inspect") {
    const disk = landedCursor(cursorPath);
    const state = new ExtendedAccountStreamState(Date.now, {
      cursorPath,
      cursorIdentity: bind(),
    });
    const snap = state.journalSnapshot();
    const drain = state.drainJournal();
    process.stdout.write(`${JSON.stringify({
      label: "inspect",
      exists: disk.exists,
      landedValid: disk.valid,
      diskPendingTradeIds: disk.pendingTradeIds,
      diskPublishedCount: disk.publishedCount,
      authority: snap.authority,
      blocked: state.cursorPersistenceBlocked(),
      snapshotTradeIds: snap.executions.map((row) => row.exchangeTradeId),
      authoritativeCount: snap.authoritativeCount,
      drainAuthoritativeIds: drain.authoritativeExecutions.map((row) => row.exchangeTradeId),
      faultCodes: [...snap.faults, ...drain.faults].map((fault) => fault.code),
    })}\n`);
    process.exit(0);
  }

  if (action === "replay") {
    const state = new ExtendedAccountStreamState(Date.now, {
      cursorPath,
      cursorIdentity: bind(),
    });
    initialize(state);
    state.ingest(tradeMessage(tradeId));
    const drain = state.drainJournal();
    const fills: string[] = [];
    publishExecutionJournal((event, fields) => {
      if (event === "FILL") fills.push(String(fields?.exchange_trade_id ?? ""));
      return true;
    }, drain);
    process.stdout.write(`${JSON.stringify({
      label: "replay",
      fills,
      drainAuthoritativeIds: drain.authoritativeExecutions.map((row) => row.exchangeTradeId),
      blocked: state.cursorPersistenceBlocked(),
      faultCodes: drain.faults.map((fault) => fault.code),
      authoritativeCount: drain.authoritativeCount,
    })}\n`);
    process.exit(0);
  }

  if (action === "accept") {
    const state = new ExtendedAccountStreamState(Date.now, {
      cursorPath,
      cursorIdentity: bind(),
      onCursorPersistStep(step) {
        waitAtBoundary(step);
      },
    });
    initialize(state);
    state.ingest(tradeMessage(tradeId));
    process.stdout.write(`${JSON.stringify({
      label: "accept",
      blocked: state.cursorPersistenceBlocked(),
      disposition: state.cursorPersistDisposition(),
      authoritativeCount: state.journalSnapshot().authoritativeCount,
    })}\n`);
    process.exit(0);
  }

  process.stderr.write(`unknown action ${action}\n`);
  process.exit(2);
} catch (error) {
  process.stderr.write(`${String((error as Error)?.message || error)}\n`);
  process.exit(1);
}
