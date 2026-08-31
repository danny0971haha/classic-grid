import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  EXECUTION_CURSOR_SCHEMA_VERSION,
  executionCursorIdentity,
  type ExecutionCursorIdentity,
} from "../experimentTelemetry.js";
import type {
  ExecutionFault,
  ExecutionFaultCode,
  ExecutionJournalDrain,
  ExecutionRecord,
  Side,
} from "../types.js";

export type ExtendedAccountEventType =
  | "ORDER"
  | "TRADE"
  | "BALANCE"
  | "POSITION"
  | "SPOT_BALANCE";

export type ExtendedAccountStreamMessage = {
  type: ExtendedAccountEventType;
  data: Record<string, unknown>;
  ts: number;
  seq: number;
};

export type AccountStreamCheckpoint = {
  connectionId: string;
  initialized: boolean;
  valid: boolean;
  seq: number;
  lastActivityAt: number;
  errorCode?: string;
};

export type ExecutionJournalSnapshot = {
  authority: "trusted" | "invalidated";
  connectionId: string;
  lastSeq: number;
  executions: ExecutionRecord[];
  faults: ExecutionFault[];
  authoritativeCount: number;
};

export type ExecutionCursorBind = {
  experimentId: string;
  scopeKey: string;
  venue: string;
  market: string;
};

/** Test-only persist fault boundaries. Production never installs a hook. */
export type CursorPersistFaultBoundary =
  | "BEFORE_TEMP_OPEN"
  | "AFTER_TEMP_OPEN"
  | "AFTER_WRITE"
  | "AFTER_FILE_FSYNC"
  | "AFTER_CLOSE"
  | "BEFORE_RENAME"
  | "AFTER_RENAME"
  | "BEFORE_DIRECTORY_FSYNC"
  | "AFTER_DIRECTORY_FSYNC"
  | "BEFORE_READBACK"
  | "AFTER_READBACK"
  | "BEFORE_MEMORY_COMMIT"
  | "BEFORE_PUBLICATION";

export type CursorPersistDisposition =
  | "COMMITTED"
  | "PRE_RENAME_FAILURE"
  | "RENAME_OR_DURABILITY_UNCERTAIN"
  | "READBACK_UNPROVEN"
  | "VALIDATION_FAILURE";

export type CursorPersistFaultHook = (
  boundary: CursorPersistFaultBoundary,
  ctx: { cursorPath: string; phase: "accept" | "ack" | "invalidate" },
) => void;

export const CURSOR_PERSIST_PRE_COMMIT_BOUNDARIES: readonly CursorPersistFaultBoundary[] = [
  "BEFORE_TEMP_OPEN",
  "AFTER_TEMP_OPEN",
  "AFTER_WRITE",
  "AFTER_FILE_FSYNC",
  "AFTER_CLOSE",
  "BEFORE_RENAME",
];

export const CURSOR_PERSIST_POST_WRITE_FAILURE_BOUNDARIES: readonly CursorPersistFaultBoundary[] = [
  "AFTER_WRITE",
  "AFTER_FILE_FSYNC",
  "BEFORE_RENAME",
  "AFTER_RENAME",
  "BEFORE_DIRECTORY_FSYNC",
  "AFTER_DIRECTORY_FSYNC",
  "AFTER_READBACK",
];

export function cursorPersistShouldFsyncDirectory(): boolean {
  return process.platform === "linux" || process.env.GITHUB_ACTIONS === "true";
}

type RecordedEvent = {
  receivedAt: number;
  seq: number;
  type: ExtendedAccountEventType;
  markets: Set<string>;
};

type PersistedCursorV2 = {
  version: 2;
  identity: ExecutionCursorIdentity | null;
  connectionId: string;
  lastSeq: number;
  authority: "trusted" | "invalidated";
  seenDedupeKeys: string[];
  publishedDedupeKeys: string[];
  pendingAuthoritative: ExecutionRecord[];
  lineageCumulative: Record<string, number>;
  authoritativeCount: number;
};

const INITIAL_TYPES = new Set<ExtendedAccountEventType>(["BALANCE", "POSITION", "ORDER"]);
const RELEVANT_TYPES = new Set<ExtendedAccountEventType>(["BALANCE", "POSITION", "ORDER", "TRADE"]);
const JOURNAL_LIMIT = 2_000;
/** Bounded in-memory journal / pending / fault capacity. */
export const EXECUTION_JOURNAL_LIMIT = JOURNAL_LIMIT;
/** Documented Extended decimal remainder tolerance for cumulative vs original qty. */
export const EXTENDED_EXECUTION_QTY_EPS = 1e-8;

function marketSet(message: ExtendedAccountStreamMessage): Set<string> {
  const values: unknown[] = [];
  for (const key of ["orders", "trades", "positions"]) {
    const rows = message.data[key];
    if (Array.isArray(rows)) values.push(...rows);
  }
  const direct = message.data.market;
  if (direct != null) values.push({ market: direct });
  return new Set(
    values
      .map((value) =>
        value && typeof value === "object" ? String((value as Record<string, unknown>).market || "") : ""
      )
      .filter(Boolean)
  );
}

function parseMessage(raw: unknown): ExtendedAccountStreamMessage {
  const parsed =
    typeof raw === "string"
      ? JSON.parse(raw)
      : Buffer.isBuffer(raw)
        ? JSON.parse(raw.toString("utf8"))
        : raw;
  if (!parsed || typeof parsed !== "object") throw new Error("EXTENDED_WS_INVALID_MESSAGE");
  const row = parsed as Record<string, unknown>;
  const type = String(row.type || "").toUpperCase() as ExtendedAccountEventType;
  if (!INITIAL_TYPES.has(type) && type !== "TRADE" && type !== "SPOT_BALANCE") {
    throw new Error("EXTENDED_WS_UNKNOWN_MESSAGE_TYPE");
  }
  const seq = Number(row.seq);
  const ts = Number(row.ts);
  if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isFinite(ts) || ts <= 0) {
    throw new Error("EXTENDED_WS_INVALID_SEQUENCE");
  }
  if (!row.data || typeof row.data !== "object") throw new Error("EXTENDED_WS_INVALID_DATA");
  return { type, data: row.data as Record<string, unknown>, ts, seq };
}

function exactId(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function normalizeSide(value: unknown): Side | undefined {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "buy" || raw === "bid") return "buy";
  if (raw === "sell" || raw === "ask") return "sell";
  return undefined;
}

function isoTimestamp(value: unknown, envelopeTs: number): string | undefined {
  if (value == null || value === "") {
    return Number.isFinite(envelopeTs) && envelopeTs > 0 ? new Date(envelopeTs).toISOString() : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return value.trim();
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

function tradeRows(data: Record<string, unknown>): Record<string, unknown>[] {
  const trades = data.trades ?? data.fills;
  if (Array.isArray(trades)) {
    return trades.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  }
  if (data.trade && typeof data.trade === "object") return [data.trade as Record<string, unknown>];
  if (
    data.id != null
    || data.tradeId != null
    || data.trade_id != null
    || data.price != null
  ) {
    return [data];
  }
  return [];
}

function boundCursorIdentity(bind: ExecutionCursorBind): ExecutionCursorIdentity {
  return executionCursorIdentity(bind);
}

function identitiesEqual(left: ExecutionCursorIdentity, right: ExecutionCursorIdentity): boolean {
  return (
    left.schemaVersion === right.schemaVersion
    && left.experimentId === right.experimentId
    && left.scopeKey === right.scopeKey
    && left.venue === right.venue
    && left.market === right.market
  );
}

function isPersistedExecutionRecord(value: unknown): value is ExecutionRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as ExecutionRecord;
  return (
    row.source === "exchange"
    && row.venue === "extended"
    && typeof row.market === "string"
    && (row.side === "buy" || row.side === "sell")
    && Number.isFinite(row.price)
    && row.price > 0
    && Number.isFinite(row.quantity)
    && row.quantity > 0
    && typeof row.dedupeKey === "string"
    && row.dedupeKey.length > 0
    && row.authoritative === true
    && typeof row.observedAt === "string"
    && typeof row.streamConnectionId === "string"
    && Number.isSafeInteger(row.streamSequence)
  );
}

export class ExtendedAccountStreamState extends EventEmitter {
  private connectionId = randomUUID();
  private initializedTypes = new Set<ExtendedAccountEventType>();
  private lastSeq = 0;
  private lastActivityAt = 0;
  private valid = true;
  private errorCode: string | undefined;
  private readonly events: RecordedEvent[] = [];
  private connectionEpoch = 0;
  private executionAuthority: "trusted" | "invalidated" = "trusted";
  private readonly seenDedupeKeys = new Set<string>();
  private readonly publishedDedupeKeys = new Set<string>();
  private readonly pendingAuthoritative: ExecutionRecord[] = [];
  private readonly diagnosticExecutions: ExecutionRecord[] = [];
  private readonly faults: ExecutionFault[] = [];
  private readonly lineageCumulative = new Map<string, number>();
  private trustedCount = 0;
  private cursorFailedClosed = false;
  private persistDisposition: CursorPersistDisposition | null = null;
  private persistPhase: "accept" | "ack" | "invalidate" = "accept";
  private faultCapacityExceeded = false;
  private readonly cursorPath?: string;
  private readonly cursorIdentity?: ExecutionCursorIdentity;
  private readonly onCursorPersistStep?: CursorPersistFaultHook;

  constructor(now: () => number = Date.now, opts?: {
    cursorPath?: string;
    cursorIdentity?: ExecutionCursorBind;
    onCursorPersistStep?: CursorPersistFaultHook;
  }) {
    super();
    this.now = now;
    this.cursorPath = opts?.cursorPath;
    this.cursorIdentity = opts?.cursorIdentity ? boundCursorIdentity(opts.cursorIdentity) : undefined;
    this.onCursorPersistStep = opts?.onCursorPersistStep;
    this.loadCursor();
  }

  cursorPersistenceBlocked(): boolean {
    return this.cursorFailedClosed;
  }

  cursorPersistDisposition(): CursorPersistDisposition | null {
    return this.persistDisposition;
  }

  private readonly now: () => number;

  reset(connectionId = randomUUID()): void {
    const reconnect = this.connectionEpoch > 0 || this.lastSeq > 0;
    this.connectionEpoch += 1;
    this.connectionId = connectionId;
    this.initializedTypes = new Set();
    this.lastSeq = 0;
    this.lastActivityAt = this.now();
    this.valid = true;
    this.errorCode = undefined;
    this.events.length = 0;
    if (reconnect) this.invalidateExecutionAuthority("DISCONNECTED");
    this.emit("change");
  }

  invalidate(errorCode: string): void {
    this.valid = false;
    this.errorCode = errorCode;
    if (errorCode === "EXTENDED_WS_DISCONNECTED" || errorCode === "EXTENDED_WS_CONNECTION_ERROR") {
      this.invalidateExecutionAuthority("DISCONNECTED");
    }
    this.emit("change");
  }

  touch(): void {
    this.lastActivityAt = this.now();
    this.emit("change");
  }

  ingest(raw: unknown): ExtendedAccountStreamMessage {
    let message: ExtendedAccountStreamMessage;
    try {
      message = parseMessage(raw);
    } catch (error) {
      this.invalidate(String((error as Error).message || "EXTENDED_WS_INVALID_MESSAGE"));
      throw error;
    }
    if (!this.valid) throw new Error(this.errorCode || "EXTENDED_WS_INVALID");

    const duplicateInitial =
      this.lastSeq > 0 &&
      message.seq === this.lastSeq &&
      !this.initializedTypes.has(message.type) &&
      INITIAL_TYPES.has(message.type) &&
      !this.initialized;
    const sameSeqReplay =
      this.lastSeq > 0 &&
      message.seq === this.lastSeq &&
      !duplicateInitial;

    if (this.lastSeq > 0 && message.seq !== this.lastSeq + 1 && !duplicateInitial && !sameSeqReplay) {
      const code = message.seq < this.lastSeq ? "OUT_OF_ORDER" : "SEQUENCE_GAP";
      this.invalidateExecutionAuthority(code, message.seq);
      try {
        this.observePayload(message);
      } catch {
        /* diagnostic observation must not hide the sequence fault */
      }
      this.invalidate("EXTENDED_WS_SEQUENCE_GAP");
      throw new Error("EXTENDED_WS_SEQUENCE_GAP");
    }

    if (!sameSeqReplay) {
      this.lastSeq = Math.max(this.lastSeq, message.seq);
    }
    if (INITIAL_TYPES.has(message.type)) this.initializedTypes.add(message.type);
    const receivedAt = this.now();
    this.lastActivityAt = receivedAt;
    if (!sameSeqReplay) {
      this.events.push({
        receivedAt,
        seq: message.seq,
        type: message.type,
        markets: marketSet(message),
      });
      if (this.events.length > JOURNAL_LIMIT) this.events.splice(0, this.events.length - JOURNAL_LIMIT);
    }
    this.observePayload(message);
    this.emit("message", message);
    this.emit("change");
    return message;
  }

  get initialized(): boolean {
    return [...INITIAL_TYPES].every((type) => this.initializedTypes.has(type));
  }

  checkpoint(): AccountStreamCheckpoint {
    return {
      connectionId: this.connectionId,
      initialized: this.initialized,
      valid: this.valid,
      seq: this.lastSeq,
      lastActivityAt: this.lastActivityAt,
      errorCode: this.errorCode,
    };
  }

  relevantEventsBetween(startedAt: number, completedAt: number, market: string): number {
    return this.events.filter(
      (event) =>
        event.receivedAt >= startedAt &&
        event.receivedAt <= completedAt &&
        RELEVANT_TYPES.has(event.type) &&
        (event.type === "BALANCE" || event.markets.size === 0 || event.markets.has(market))
    ).length;
  }

  journalSnapshot(): ExecutionJournalSnapshot {
    return {
      authority: this.executionAuthority,
      connectionId: this.connectionId,
      lastSeq: this.lastSeq,
      executions: this.observedExecutions(),
      faults: this.faults.slice(),
      authoritativeCount: this.trustedCount,
    };
  }

  drainJournal(): ExecutionJournalDrain {
    const hideAuthoritative = this.cursorFailedClosed;
    const authoritativeExecutions = hideAuthoritative ? [] : this.pendingAuthoritative.slice();
    const diagnostics = this.diagnosticExecutions.slice();
    const faults = this.faults.slice();
    if (this.faultCapacityExceeded && !faults.some((fault) => fault.code === "JOURNAL_CAPACITY")) {
      faults.push({
        event: "EXECUTION_RECONCILIATION_REQUIRED",
        code: "JOURNAL_CAPACITY",
        observedAt: new Date(this.now()).toISOString(),
        streamConnectionId: this.connectionId,
      });
    }
    this.diagnosticExecutions.length = 0;
    this.faults.length = 0;
    this.faultCapacityExceeded = false;
    return {
      executions: hideAuthoritative ? diagnostics : [...authoritativeExecutions, ...diagnostics],
      authoritativeExecutions,
      faults,
      authority: this.executionAuthority,
      authoritativeCount: this.trustedCount,
    };
  }

  acknowledgeJournal(publishedDedupeKeys: string[]): void {
    if (publishedDedupeKeys.length === 0) return;
    if (this.cursorFailedClosed) return;
    const want = new Set(publishedDedupeKeys);
    const remaining: ExecutionRecord[] = [];
    const newlyPublished: string[] = [];
    for (const record of this.pendingAuthoritative) {
      if (want.has(record.dedupeKey) && record.authoritative) {
        newlyPublished.push(record.dedupeKey);
      } else {
        remaining.push(record);
      }
    }
    if (newlyPublished.length === 0) return;
    const candidate = this.cursorSnapshot({
      publishedDedupeKeys: [...this.publishedDedupeKeys, ...newlyPublished],
      pendingAuthoritative: remaining,
    });
    const disposition = this.persistCursor(candidate, "ack");
    if (disposition !== "COMMITTED") {
      this.latchCursorPersistence(disposition);
      return;
    }
    try {
      this.notifyCursorFault("BEFORE_MEMORY_COMMIT");
    } catch {
      this.latchCursorPersistence("READBACK_UNPROVEN");
      return;
    }
    this.applyCursorSnapshot(candidate);
  }

  private observedExecutions(): ExecutionRecord[] {
    return [...this.pendingAuthoritative, ...this.diagnosticExecutions];
  }

  private observePayload(message: ExtendedAccountStreamMessage): void {
    if (message.type !== "TRADE") return;
    for (const row of tradeRows(message.data)) {
      this.acceptTrade(row, message);
    }
  }

  private acceptTrade(row: Record<string, unknown>, message: ExtendedAccountStreamMessage): void {
    if (this.cursorFailedClosed) {
      if (this.executionAuthority === "trusted") {
        this.invalidateExecutionAuthority("CURSOR_CONFLICT", message.seq);
      }
      return;
    }
    const market = exactId(row.market ?? row.symbol ?? message.data.market);
    const side = normalizeSide(row.side);
    const price = finiteNumber(row.price ?? row.fillPrice ?? row.fill_price);
    const quantity = finiteNumber(
      row.qty ?? row.quantity ?? row.size ?? row.executedQty ?? row.execQty ?? row.lastFillQty
    );
    if (!market || !side) {
      this.recordFault("MALFORMED_IDENTITY", message.seq);
      this.invalidateExecutionAuthority("MALFORMED_IDENTITY", message.seq);
      return;
    }
    if (price === undefined || quantity === undefined || Number.isNaN(price) || Number.isNaN(quantity)) {
      this.recordFault("NON_FINITE_FIELDS", message.seq);
      return;
    }
    if (!(price > 0) || !(quantity > 0)) {
      this.recordFault("NON_FINITE_FIELDS", message.seq);
      return;
    }

    const exchangeTradeId = exactId(row.tradeId ?? row.trade_id ?? row.executionId ?? row.execution_id ?? row.id);
    const exchangeOrderId = exactId(
      row.orderId ?? row.order_id ?? row.exchangeOrderId ?? row.exchange_order_id
    );
    const clientOrderId = exactId(
      row.clientOrderId ?? row.client_order_id ?? row.externalId ?? row.external_id ?? row.externalOrderId
    );
    if (!exchangeTradeId) {
      this.recordFault("MALFORMED_IDENTITY", message.seq);
      this.invalidateExecutionAuthority("MALFORMED_IDENTITY", message.seq);
      return;
    }

    const cumulative = finiteNumber(
      row.cumulativeFilledQty ?? row.cumulativeQty ?? row.filledQty ?? row.filled_qty ?? row.cumulativeFilledQuantity
    );
    const remaining = finiteNumber(
      row.remainingQty ?? row.remaining_qty ?? row.remaining ?? row.unfilledQty
    );
    const original = finiteNumber(row.orderQty ?? row.originalQty ?? row.totalQty ?? row.order_qty);
    if (cumulative !== undefined && Number.isNaN(cumulative)) {
      this.recordFault("NON_FINITE_FIELDS", message.seq);
      return;
    }
    if (remaining !== undefined && Number.isNaN(remaining)) {
      this.recordFault("NON_FINITE_FIELDS", message.seq);
      return;
    }
    if (cumulative !== undefined && cumulative < 0) {
      this.recordFault("NON_FINITE_FIELDS", message.seq);
      return;
    }
    if (remaining !== undefined && remaining < 0) {
      this.recordFault("NON_FINITE_FIELDS", message.seq);
      return;
    }

    const lineageId = exchangeOrderId || clientOrderId;
    const nextLineage = Object.fromEntries(this.lineageCumulative);
    if (lineageId && cumulative !== undefined) {
      const lineageKey = `extended|${market}|${lineageId}`;
      const prior = this.lineageCumulative.get(lineageKey);
      if (prior !== undefined && cumulative + EXTENDED_EXECUTION_QTY_EPS < prior) {
        this.recordFault("CUMULATIVE_REGRESSION", message.seq);
        this.invalidateExecutionAuthority("CUMULATIVE_REGRESSION", message.seq);
        return;
      }
      if (original !== undefined && !Number.isNaN(original) && cumulative > original + EXTENDED_EXECUTION_QTY_EPS) {
        this.recordFault("CUMULATIVE_EXCEEDS_ORIGINAL", message.seq);
        this.invalidateExecutionAuthority("CUMULATIVE_EXCEEDS_ORIGINAL", message.seq);
        return;
      }
      nextLineage[lineageKey] = cumulative;
    }

    const dedupeKey = `extended|${market}|trade|${exchangeTradeId}`;
    if (this.seenDedupeKeys.has(dedupeKey) || this.publishedDedupeKeys.has(dedupeKey)) return;

    const authoritative = this.executionAuthority === "trusted";
    if (authoritative) {
      if (this.pendingAuthoritative.length >= JOURNAL_LIMIT) {
        this.invalidateExecutionAuthority("JOURNAL_CAPACITY", message.seq);
        return;
      }
    } else if (this.diagnosticExecutions.length >= JOURNAL_LIMIT) {
      this.invalidateExecutionAuthority("JOURNAL_CAPACITY", message.seq);
      return;
    }

    const record: ExecutionRecord = {
      source: "exchange",
      venue: "extended",
      market,
      side,
      price,
      quantity,
      exchangeTradeId,
      ...(exchangeOrderId ? { exchangeOrderId } : {}),
      ...(clientOrderId ? { clientOrderId } : {}),
      ...(cumulative !== undefined ? { cumulativeFilledQuantity: cumulative } : {}),
      ...(remaining !== undefined ? { remainingQuantity: remaining } : {}),
      ...(isoTimestamp(row.timestamp ?? row.time ?? row.createdAt ?? row.createdTime, message.ts)
        ? { exchangeTimestamp: isoTimestamp(row.timestamp ?? row.time ?? row.createdAt ?? row.createdTime, message.ts) }
        : {}),
      observedAt: new Date(this.now()).toISOString(),
      streamConnectionId: this.connectionId,
      streamSequence: message.seq,
      dedupeKey,
      authoritative,
    };
    const candidate = this.cursorSnapshot({
      seenDedupeKeys: [...this.seenDedupeKeys, dedupeKey],
      pendingAuthoritative: authoritative
        ? [...this.pendingAuthoritative, record]
        : this.pendingAuthoritative.slice(),
      lineageCumulative: nextLineage,
      authoritativeCount: authoritative ? this.trustedCount + 1 : this.trustedCount,
    });
    const disposition = this.persistCursor(candidate, "accept");
    if (disposition !== "COMMITTED") {
      this.latchCursorPersistence(disposition);
      return;
    }
    try {
      this.notifyCursorFault("BEFORE_MEMORY_COMMIT");
    } catch {
      this.latchCursorPersistence("READBACK_UNPROVEN");
      return;
    }
    this.applyCursorSnapshot(candidate);
    if (!authoritative) this.diagnosticExecutions.push(record);
    try {
      this.notifyCursorFault("BEFORE_PUBLICATION");
    } catch {
      this.latchCursorPersistence("READBACK_UNPROVEN");
    }
  }

  private invalidateExecutionAuthority(code: ExecutionFaultCode, seq?: number): void {
    const wasTrusted = this.executionAuthority === "trusted";
    this.executionAuthority = "invalidated";
    this.recordFault(code, seq);
    if (!wasTrusted) return;
    const disposition = this.persistCursor(this.cursorSnapshot(), "invalidate");
    if (disposition !== "COMMITTED") this.latchCursorPersistence(disposition);
  }

  private recordFault(code: ExecutionFaultCode, seq?: number): void {
    const last = this.faults[this.faults.length - 1];
    if (last && last.code === code && last.streamConnectionId === this.connectionId && last.streamSequence === seq) {
      return;
    }
    if (this.faults.length >= JOURNAL_LIMIT) {
      this.executionAuthority = "invalidated";
      this.faultCapacityExceeded = true;
      return;
    }
    this.faults.push({
      event: "EXECUTION_RECONCILIATION_REQUIRED",
      code,
      observedAt: new Date(this.now()).toISOString(),
      streamConnectionId: this.connectionId,
      ...(seq != null ? { streamSequence: seq } : {}),
    });
  }

  private failClosedCursor(): void {
    this.cursorFailedClosed = true;
    this.executionAuthority = "invalidated";
    this.seenDedupeKeys.clear();
    this.publishedDedupeKeys.clear();
    this.pendingAuthoritative.length = 0;
    this.diagnosticExecutions.length = 0;
    this.lineageCumulative.clear();
    this.trustedCount = 0;
    this.persistDisposition = "VALIDATION_FAILURE";
    this.recordFault("CURSOR_CONFLICT");
  }

  private latchCursorPersistence(disposition: CursorPersistDisposition): void {
    this.cursorFailedClosed = true;
    this.persistDisposition = disposition;
    this.executionAuthority = "invalidated";
    this.recordFault("CURSOR_CONFLICT");
  }

  private notifyCursorFault(boundary: CursorPersistFaultBoundary): void {
    if (!this.onCursorPersistStep) return;
    this.onCursorPersistStep(boundary, {
      cursorPath: this.cursorPath ?? "",
      phase: this.persistPhase,
    });
  }

  private cursorSnapshot(overrides: Partial<PersistedCursorV2> = {}): PersistedCursorV2 {
    return {
      version: 2,
      identity: this.cursorIdentity ?? null,
      connectionId: this.connectionId,
      lastSeq: this.lastSeq,
      authority: this.executionAuthority,
      seenDedupeKeys: [...this.seenDedupeKeys],
      publishedDedupeKeys: [...this.publishedDedupeKeys],
      pendingAuthoritative: this.pendingAuthoritative.slice(),
      lineageCumulative: Object.fromEntries(this.lineageCumulative),
      authoritativeCount: this.trustedCount,
      ...overrides,
    };
  }

  private applyCursorSnapshot(snapshot: PersistedCursorV2): void {
    this.seenDedupeKeys.clear();
    for (const key of snapshot.seenDedupeKeys) this.seenDedupeKeys.add(key);
    this.publishedDedupeKeys.clear();
    for (const key of snapshot.publishedDedupeKeys) this.publishedDedupeKeys.add(key);
    this.pendingAuthoritative.length = 0;
    this.pendingAuthoritative.push(...snapshot.pendingAuthoritative);
    this.lineageCumulative.clear();
    for (const [key, value] of Object.entries(snapshot.lineageCumulative)) {
      if (typeof value === "number" && Number.isFinite(value)) this.lineageCumulative.set(key, value);
    }
    this.trustedCount = snapshot.authoritativeCount;
    this.executionAuthority = snapshot.authority;
  }

  private cursorMatchesCandidate(actual: unknown, expected: PersistedCursorV2): boolean {
    if (!actual || typeof actual !== "object") return false;
    const parsed = actual as PersistedCursorV2;
    if (parsed.version !== 2) return false;
    if (parsed.authority !== expected.authority) return false;
    if (parsed.authoritativeCount !== expected.authoritativeCount) return false;
    if (JSON.stringify(parsed.identity) !== JSON.stringify(expected.identity)) return false;
    if (JSON.stringify(parsed.seenDedupeKeys) !== JSON.stringify(expected.seenDedupeKeys)) return false;
    if (JSON.stringify(parsed.publishedDedupeKeys) !== JSON.stringify(expected.publishedDedupeKeys)) return false;
    if (!Array.isArray(parsed.pendingAuthoritative)) return false;
    if (parsed.pendingAuthoritative.length !== expected.pendingAuthoritative.length) return false;
    if (!parsed.pendingAuthoritative.every(isPersistedExecutionRecord)) return false;
    for (let i = 0; i < expected.pendingAuthoritative.length; i++) {
      if (parsed.pendingAuthoritative[i]!.dedupeKey !== expected.pendingAuthoritative[i]!.dedupeKey) return false;
    }
    if (this.cursorIdentity) {
      const stored = parsed.identity;
      if (!stored || !identitiesEqual(stored, this.cursorIdentity)) return false;
      if (!expected.identity || !identitiesEqual(expected.identity, this.cursorIdentity)) return false;
    }
    return true;
  }

  private loadCursor(): void {
    if (!this.cursorPath) return;
    if (!fs.existsSync(this.cursorPath)) return;
    try {
      const raw = fs.readFileSync(this.cursorPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedCursorV2>;
      if (
        parsed.version !== 2
        || (parsed.authority !== "trusted" && parsed.authority !== "invalidated")
        || !Array.isArray(parsed.seenDedupeKeys)
        || parsed.seenDedupeKeys.some((key) => typeof key !== "string")
        || !Array.isArray(parsed.publishedDedupeKeys)
        || parsed.publishedDedupeKeys.some((key) => typeof key !== "string")
        || !Array.isArray(parsed.pendingAuthoritative)
        || typeof parsed.lineageCumulative !== "object"
        || parsed.lineageCumulative == null
        || typeof parsed.authoritativeCount !== "number"
        || !Number.isFinite(parsed.authoritativeCount)
        || parsed.authoritativeCount < 0
      ) {
        this.failClosedCursor();
        return;
      }
      if (this.cursorIdentity) {
        const stored = parsed.identity;
        if (
          !stored
          || typeof stored !== "object"
          || stored.schemaVersion !== EXECUTION_CURSOR_SCHEMA_VERSION
          || typeof stored.experimentId !== "string"
          || typeof stored.scopeKey !== "string"
          || typeof stored.venue !== "string"
          || typeof stored.market !== "string"
          || !identitiesEqual(stored as ExecutionCursorIdentity, this.cursorIdentity)
        ) {
          this.failClosedCursor();
          return;
        }
      }
      if (!parsed.pendingAuthoritative.every(isPersistedExecutionRecord)) {
        this.failClosedCursor();
        return;
      }
      const pendingKeys = new Set<string>();
      for (const record of parsed.pendingAuthoritative) {
        if (pendingKeys.has(record.dedupeKey) || parsed.publishedDedupeKeys.includes(record.dedupeKey)) {
          this.failClosedCursor();
          return;
        }
        pendingKeys.add(record.dedupeKey);
      }
      for (const key of parsed.seenDedupeKeys) this.seenDedupeKeys.add(key);
      for (const key of parsed.publishedDedupeKeys) this.publishedDedupeKeys.add(key);
      for (const record of parsed.pendingAuthoritative) {
        this.pendingAuthoritative.push(record);
        this.seenDedupeKeys.add(record.dedupeKey);
      }
      for (const [key, value] of Object.entries(parsed.lineageCumulative)) {
        if (typeof value === "number" && Number.isFinite(value)) this.lineageCumulative.set(key, value);
      }
      this.trustedCount = parsed.authoritativeCount;
      this.executionAuthority = parsed.authority;
      if (parsed.authority === "invalidated") this.recordFault("CURSOR_CONFLICT");
    } catch {
      this.failClosedCursor();
    }
  }

  private persistCursor(
    candidate: PersistedCursorV2,
    phase: "accept" | "ack" | "invalidate",
  ): CursorPersistDisposition {
    this.persistPhase = phase;
    if (!this.cursorPath) {
      this.persistDisposition = "COMMITTED";
      return "COMMITTED";
    }
    if (this.cursorFailedClosed) {
      const blocked = this.persistDisposition && this.persistDisposition !== "COMMITTED"
        ? this.persistDisposition
        : "PRE_RENAME_FAILURE";
      this.persistDisposition = blocked;
      return blocked;
    }

    const serialized = `${JSON.stringify(candidate)}\n`;
    const dir = path.dirname(this.cursorPath);
    const tmp = path.join(dir, `.${path.basename(this.cursorPath)}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | null = null;
    let directoryFd: number | null = null;
    let renameAttempted = false;
    let renameCompleted = false;
    let dirFsyncCompleted = false;
    let readbackStarted = false;

    const classify = (): CursorPersistDisposition => {
      if (!renameAttempted) return "PRE_RENAME_FAILURE";
      if (!renameCompleted || !dirFsyncCompleted) return "RENAME_OR_DURABILITY_UNCERTAIN";
      if (readbackStarted) return "READBACK_UNPROVEN";
      return "RENAME_OR_DURABILITY_UNCERTAIN";
    };

    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch { /* restrictive best-effort */ }

      this.notifyCursorFault("BEFORE_TEMP_OPEN");
      fd = fs.openSync(tmp, "wx", 0o600);
      this.notifyCursorFault("AFTER_TEMP_OPEN");
      fs.writeFileSync(fd, serialized, "utf8");
      this.notifyCursorFault("AFTER_WRITE");
      fs.fsyncSync(fd);
      this.notifyCursorFault("AFTER_FILE_FSYNC");
      fs.closeSync(fd);
      fd = null;
      this.notifyCursorFault("AFTER_CLOSE");

      this.notifyCursorFault("BEFORE_RENAME");
      renameAttempted = true;
      fs.renameSync(tmp, this.cursorPath);
      renameCompleted = true;
      this.notifyCursorFault("AFTER_RENAME");
      try { fs.chmodSync(this.cursorPath, 0o600); } catch { /* created 0600 */ }

      this.notifyCursorFault("BEFORE_DIRECTORY_FSYNC");
      if (cursorPersistShouldFsyncDirectory()) {
        directoryFd = fs.openSync(dir, "r");
        fs.fsyncSync(directoryFd);
        fs.closeSync(directoryFd);
        directoryFd = null;
      }
      dirFsyncCompleted = true;
      this.notifyCursorFault("AFTER_DIRECTORY_FSYNC");

      this.notifyCursorFault("BEFORE_READBACK");
      readbackStarted = true;
      const raw = fs.readFileSync(this.cursorPath, "utf8");
      this.notifyCursorFault("AFTER_READBACK");
      if (raw !== serialized) {
        this.persistDisposition = "VALIDATION_FAILURE";
        return "VALIDATION_FAILURE";
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.persistDisposition = "VALIDATION_FAILURE";
        return "VALIDATION_FAILURE";
      }
      if (!this.cursorMatchesCandidate(parsed, candidate)) {
        this.persistDisposition = "VALIDATION_FAILURE";
        return "VALIDATION_FAILURE";
      }
      this.persistDisposition = "COMMITTED";
      return "COMMITTED";
    } catch {
      if (fd != null) {
        try { fs.closeSync(fd); } catch { /* cleanup only */ }
      }
      if (directoryFd != null) {
        try { fs.closeSync(directoryFd); } catch { /* cleanup only */ }
      }
      if (!renameAttempted) {
        try { fs.unlinkSync(tmp); } catch { /* cleanup only */ }
      }
      const disposition = classify();
      this.persistDisposition = disposition;
      return disposition;
    }
  }
}

export type ExtendedAccountStreamOptions = {
  apiUrl: string;
  apiKey: string;
  websocketBase: string;
  userAgent?: string;
  initializeTimeoutMs?: number;
  reconnectDelayMs?: number;
};

export class ExtendedAccountStream {
  readonly state: ExtendedAccountStreamState;
  private socket: WebSocket | null = null;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: ExtendedAccountStreamOptions,
    state?: ExtendedAccountStreamState
  ) {
    this.state = state ?? new ExtendedAccountStreamState();
  }

  private url(): string {
    const base = this.options.websocketBase.replace(/\/$/, "");
    if (!base) throw new Error("EXTENDED_WS_BASE_REQUIRED");
    return `${base}/account`;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.open();
    await this.waitUntilInitialized(this.options.initializeTimeoutMs ?? 15_000);
  }

  private open(): void {
    if (this.stopped) return;
    const connectionId = randomUUID();
    this.state.reset(connectionId);
    const socket = new WebSocket(this.url(), {
      headers: {
        "X-Api-Key": this.options.apiKey,
        "User-Agent": this.options.userAgent || "ClassicGridExperiment/1.0",
      },
      handshakeTimeout: this.options.initializeTimeoutMs ?? 15_000,
    });
    this.socket = socket;
    socket.on("message", (data) => {
      try {
        this.state.ingest(data);
      } catch {
        socket.terminate();
      }
    });
    socket.on("ping", () => this.state.touch());
    socket.on("pong", () => this.state.touch());
    socket.on("error", () => this.state.invalidate("EXTENDED_WS_CONNECTION_ERROR"));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.state.invalidate("EXTENDED_WS_DISCONNECTED");
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(
          () => this.open(),
          this.options.reconnectDelayMs ?? 1_000
        );
        this.reconnectTimer.unref?.();
      }
    });
  }

  private waitUntilInitialized(timeoutMs: number): Promise<void> {
    const current = this.state.checkpoint();
    if (current.initialized && current.valid) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("EXTENDED_WS_INITIAL_STATE_TIMEOUT"));
      }, timeoutMs);
      const onChange = () => {
        const checkpoint = this.state.checkpoint();
        if (!checkpoint.valid) {
          cleanup();
          reject(new Error(checkpoint.errorCode || "EXTENDED_WS_INVALID"));
        } else if (checkpoint.initialized) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.state.off("change", onChange);
      };
      this.state.on("change", onChange);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}
