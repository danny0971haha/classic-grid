import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

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

type RecordedEvent = {
  receivedAt: number;
  seq: number;
  type: ExtendedAccountEventType;
  markets: Set<string>;
};

const INITIAL_TYPES = new Set<ExtendedAccountEventType>(["BALANCE", "POSITION", "ORDER"]);
const RELEVANT_TYPES = new Set<ExtendedAccountEventType>(["BALANCE", "POSITION", "ORDER", "TRADE"]);

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

export class ExtendedAccountStreamState extends EventEmitter {
  private connectionId = randomUUID();
  private initializedTypes = new Set<ExtendedAccountEventType>();
  private lastSeq = 0;
  private lastActivityAt = 0;
  private valid = true;
  private errorCode: string | undefined;
  private readonly events: RecordedEvent[] = [];

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  reset(connectionId = randomUUID()): void {
    this.connectionId = connectionId;
    this.initializedTypes = new Set();
    this.lastSeq = 0;
    this.lastActivityAt = this.now();
    this.valid = true;
    this.errorCode = undefined;
    this.events.length = 0;
    this.emit("change");
  }

  invalidate(errorCode: string): void {
    this.valid = false;
    this.errorCode = errorCode;
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
    if (this.lastSeq > 0 && message.seq !== this.lastSeq + 1 && !duplicateInitial) {
      this.invalidate("EXTENDED_WS_SEQUENCE_GAP");
      throw new Error("EXTENDED_WS_SEQUENCE_GAP");
    }
    this.lastSeq = Math.max(this.lastSeq, message.seq);
    if (INITIAL_TYPES.has(message.type)) this.initializedTypes.add(message.type);
    const receivedAt = this.now();
    this.lastActivityAt = receivedAt;
    this.events.push({
      receivedAt,
      seq: message.seq,
      type: message.type,
      markets: marketSet(message),
    });
    if (this.events.length > 2_000) this.events.splice(0, this.events.length - 2_000);
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
