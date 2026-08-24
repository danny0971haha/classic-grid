import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
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

type RecordedEvent = {
  receivedAt: number;
  seq: number;
  type: ExtendedAccountEventType;
  markets: Set<string>;
};

type PersistedCursor = {
  version: 1;
  connectionId: string;
  lastSeq: number;
  authority: "trusted" | "invalidated";
  seenDedupeKeys: string[];
  lineageCumulative: Record<string, number>;
  authoritativeCount: number;
};

const INITIAL_TYPES = new Set<ExtendedAccountEventType>(["BALANCE", "POSITION", "ORDER"]);
const RELEVANT_TYPES = new Set<ExtendedAccountEventType>(["BALANCE", "POSITION", "ORDER", "TRADE"]);
const JOURNAL_LIMIT = 2_000;
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
  private readonly executions: ExecutionRecord[] = [];
  private readonly faults: ExecutionFault[] = [];
  private readonly lineageCumulative = new Map<string, number>();
  private drainExecOffset = 0;
  private drainFaultOffset = 0;
  private cursorFailedClosed = false;
  private readonly cursorPath?: string;

  constructor(now: () => number = Date.now, opts?: { cursorPath?: string }) {
    super();
    this.now = now;
    this.cursorPath = opts?.cursorPath;
    this.loadCursor();
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
      executions: this.executions.slice(),
      faults: this.faults.slice(),
      authoritativeCount: this.authoritativeCount(),
    };
  }

  drainJournal(): ExecutionJournalDrain {
    const executions = this.executions.slice(this.drainExecOffset);
    const faults = this.faults.slice(this.drainFaultOffset);
    this.drainExecOffset = this.executions.length;
    this.drainFaultOffset = this.faults.length;
    return {
      executions,
      faults,
      authority: this.executionAuthority,
      authoritativeCount: this.authoritativeCount(),
    };
  }

  private trustedCount = 0;

  private authoritativeCount(): number {
    return this.trustedCount;
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
      this.lineageCumulative.set(lineageKey, cumulative);
    }

    const dedupeKey = `extended|${market}|trade|${exchangeTradeId}`;
    if (this.seenDedupeKeys.has(dedupeKey)) return;
    this.seenDedupeKeys.add(dedupeKey);

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
    };
    this.executions.push(record);
    if (this.executions.length > JOURNAL_LIMIT) this.executions.splice(0, this.executions.length - JOURNAL_LIMIT);
    if (this.executionAuthority === "trusted") this.trustedCount += 1;
    this.persistCursor();
  }

  private invalidateExecutionAuthority(code: ExecutionFaultCode, seq?: number): void {
    const wasTrusted = this.executionAuthority === "trusted";
    this.executionAuthority = "invalidated";
    this.recordFault(code, seq);
    if (wasTrusted) this.persistCursor();
  }

  private recordFault(code: ExecutionFaultCode, seq?: number): void {
    const last = this.faults[this.faults.length - 1];
    if (last && last.code === code && last.streamConnectionId === this.connectionId && last.streamSequence === seq) {
      return;
    }
    this.faults.push({
      event: "EXECUTION_RECONCILIATION_REQUIRED",
      code,
      observedAt: new Date(this.now()).toISOString(),
      streamConnectionId: this.connectionId,
      ...(seq != null ? { streamSequence: seq } : {}),
    });
    if (this.faults.length > JOURNAL_LIMIT) this.faults.splice(0, this.faults.length - JOURNAL_LIMIT);
  }

  private loadCursor(): void {
    if (!this.cursorPath) return;
    if (!fs.existsSync(this.cursorPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cursorPath, "utf8")) as Partial<PersistedCursor>;
      if (
        parsed.version !== 1
        || (parsed.authority !== "trusted" && parsed.authority !== "invalidated")
        || !Array.isArray(parsed.seenDedupeKeys)
        || parsed.seenDedupeKeys.some((key) => typeof key !== "string")
        || typeof parsed.lineageCumulative !== "object"
        || parsed.lineageCumulative == null
        || typeof parsed.authoritativeCount !== "number"
        || !Number.isFinite(parsed.authoritativeCount)
        || parsed.authoritativeCount < 0
      ) {
        this.cursorFailedClosed = true;
        this.executionAuthority = "invalidated";
        this.recordFault("CURSOR_CONFLICT");
        return;
      }
      for (const key of parsed.seenDedupeKeys) this.seenDedupeKeys.add(key);
      for (const [key, value] of Object.entries(parsed.lineageCumulative)) {
        if (typeof value === "number" && Number.isFinite(value)) this.lineageCumulative.set(key, value);
      }
      this.trustedCount = parsed.authoritativeCount;
      this.executionAuthority = parsed.authority;
      if (parsed.authority === "invalidated") this.recordFault("CURSOR_CONFLICT");
    } catch {
      this.cursorFailedClosed = true;
      this.executionAuthority = "invalidated";
      this.recordFault("CURSOR_CONFLICT");
    }
  }

  private persistCursor(): void {
    if (!this.cursorPath) return;
    const payload: PersistedCursor = {
      version: 1,
      connectionId: this.connectionId,
      lastSeq: this.lastSeq,
      authority: this.executionAuthority,
      seenDedupeKeys: [...this.seenDedupeKeys],
      lineageCumulative: Object.fromEntries(this.lineageCumulative),
      authoritativeCount: this.trustedCount,
    };
    try {
      fs.mkdirSync(path.dirname(this.cursorPath), { recursive: true });
      const tmp = `${this.cursorPath}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, this.cursorPath);
    } catch {
      this.cursorFailedClosed = true;
      this.executionAuthority = "invalidated";
      this.recordFault("CURSOR_CONFLICT");
    }
  }
}

export type ExtendedAccountStreamOptions = {
  apiUrl: string;
  apiKey: string;
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
    const base = this.options.apiUrl.replace(/\/$/, "").replace(/^http/, "ws");
    return `${base}/stream.extended.exchange/v1/account`;
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
