import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { experimentDir } from "./experimentRisk.js";
import { assertSafeExperimentId, sha256Canonical, sha256Json } from "./experimentStorage.js";
import type { ExecutionFault, ExecutionJournalDrain, ExecutionRecord } from "./types.js";

/** Stored inside the cursor payload. Never interpolated into filesystem paths. */
export const EXECUTION_CURSOR_SCHEMA_VERSION = "classic-grid.execution-cursor.v2";

export type ExecutionCursorIdentity = {
  schemaVersion: typeof EXECUTION_CURSOR_SCHEMA_VERSION;
  experimentId: string;
  scopeKey: string;
  venue: string;
  market: string;
};

export function normalizeExecutionCursorMarket(market: string): string {
  const normalized = String(market || "").trim().toUpperCase();
  if (!normalized) return "";
  return normalized.includes("-") ? normalized : `${normalized}-USD`;
}

export function executionCursorIdentity(p: {
  experimentId: string;
  scopeKey: string;
  venue: string;
  market: string;
}): ExecutionCursorIdentity {
  return {
    schemaVersion: EXECUTION_CURSOR_SCHEMA_VERSION,
    experimentId: assertSafeExperimentId(p.experimentId),
    scopeKey: String(p.scopeKey ?? ""),
    venue: String(p.venue || "").trim().toLowerCase(),
    market: normalizeExecutionCursorMarket(p.market),
  };
}

/**
 * Stable cursor path under the experiment state directory.
 * Filename is a bounded hash of the identity; raw scope strings are not path components.
 */
export function resolveExecutionCursorPath(p: {
  experimentId: string;
  scopeKey: string;
  venue: string;
  market: string;
  baseDir?: string;
}): string {
  const identity = executionCursorIdentity(p);
  const digest = sha256Canonical(identity).slice(0, 32);
  return path.join(experimentDir(p.experimentId, p.baseDir), "execution-cursors", `${digest}.json`);
}

export type ExperimentMode = "dry-run" | "sandbox" | "live";

export type ExperimentManifest = {
  experiment_spec_version: string;
  experiment_id: string;
  run_id: string;
  bot: "classic-grid" | "ritmex-bot";
  repo: string;
  commit_sha: string;
  started_at: string;
  mode: ExperimentMode;
  starting_capital_usd: number;
  leverage: number;
  max_margin_budget_usd: number;
  max_planned_gross_notional_usd: number;
  grid_half_band_pct: number;
  grid_level_count: number;
  daily_loss_limit_usd: number;
  max_drawdown_usd: number;
  boundary_buffer_pct: number;
  venue: string;
  symbol: string;
  scope_key: string;
  lease_generation: string;
};

export type ExperimentEventName =
  | "SNAPSHOT" | "ORDER_SUBMIT" | "ORDER_ACK" | "FILL" | "CANCEL"
  | "RESTART" | "ERROR" | "RISK_HALT"
  | "ORDER_DISAPPEARED" | "EXECUTION_RECONCILIATION_REQUIRED"
  | "REDUCTION_STARTED" | "REDUCTION_SUBMITTED" | "REDUCTION_VERIFIED" | "REDUCTION_FAILED";

export type ExperimentEvent = {
  schema_version: "2.0";
  event_id: string;
  run_id: string;
  manifest_sha256: string;
  ts: string;
  exchange_ts: string | null;
  experiment_id: string;
  bot: string;
  commit_sha: string;
  mode: ExperimentMode;
  venue: string;
  symbol: string;
  event: ExperimentEventName;
  intent_id: string | null;
  client_order_id: string | null;
  exchange_order_id: string | null;
  exchange_trade_id: string | null;
  account_scope: string | null;
  anchor_epoch: number | null;
  lease_generation: string;
  source: string;
  order_status: string | null;
  filled_qty: number | null;
  remaining_qty: number | null;
  anchor: number | null;
  grid_lower: number | null;
  grid_upper: number | null;
  grid_level: number | null;
  side: string | null;
  mid: number | null;
  equity_usd: number | null;
  free_margin_usd: number | null;
  leverage: number | null;
  position_qty: number | null;
  position_notional_usd: number | null;
  planned_gross_notional_usd: number | null;
  margin_used_usd: number | null;
  open_order_count: number | null;
  order_id: string | null;
  order_price: number | null;
  order_qty: number | null;
  fee_usd: number | null;
  funding_usd: number | null;
  realized_pnl_usd: number | null;
  unrealized_pnl_usd: number | null;
  net_pnl_usd: number | null;
  grid_profit_estimate_usd: number | null;
  api_latency_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  restart_count: number;
  reconnect_count: number;
  risk_flags: string[];
};

export function readCommitSha(): string {
  if (process.env.COMMIT_SHA?.trim()) return process.env.COMMIT_SHA.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return "unknown"; }
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeCode(value: unknown): string | null {
  if (value == null) return null;
  const clean = String(value).toUpperCase().replace(/[^A-Z0-9_.:-]/g, "_").slice(0, 80);
  return clean || null;
}

export function createExperimentTelemetry(opts: {
  experimentId: string;
  bot?: "classic-grid" | "ritmex-bot";
  mode: ExperimentMode;
  venue: string;
  symbol: string;
  scopeKey?: string;
  leaseGeneration?: string;
  commitSha?: string;
  runId?: string;
  baseDir?: string;
  repo?: string;
  manifestFields: Omit<ExperimentManifest,
    "experiment_id" | "run_id" | "bot" | "repo" | "commit_sha" | "started_at" |
    "mode" | "venue" | "symbol" | "scope_key" | "lease_generation"> &
    Partial<Pick<ExperimentManifest, "repo">>;
}): {
  dir: string;
  manifestPath: string;
  eventsPath: string;
  manifest: ExperimentManifest;
  manifestSha256: string;
  droppedEvents: () => number;
  emit: (event: ExperimentEventName, fields?: Partial<ExperimentEvent>) => boolean;
} {
  const experimentId = assertSafeExperimentId(opts.experimentId);
  const commitSha = opts.commitSha || readCommitSha();
  if (opts.mode === "live" && !/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error("live experiment requires a full git commit sha");
  }
  const runId = opts.runId || `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const dir = path.join(
    opts.baseDir || path.resolve(process.cwd(), "data", "experiments"),
    experimentId,
    "runs",
    assertSafeExperimentId(runId)
  );
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
  const manifest: ExperimentManifest = {
    experiment_spec_version: opts.manifestFields.experiment_spec_version,
    experiment_id: experimentId,
    run_id: runId,
    bot: opts.bot || "classic-grid",
    repo: opts.manifestFields.repo || opts.repo || "https://github.com/danny0971haha/classic-grid",
    commit_sha: commitSha,
    started_at: new Date().toISOString(),
    mode: opts.mode,
    starting_capital_usd: opts.manifestFields.starting_capital_usd,
    leverage: opts.manifestFields.leverage,
    max_margin_budget_usd: opts.manifestFields.max_margin_budget_usd,
    max_planned_gross_notional_usd: opts.manifestFields.max_planned_gross_notional_usd,
    grid_half_band_pct: opts.manifestFields.grid_half_band_pct,
    grid_level_count: opts.manifestFields.grid_level_count,
    daily_loss_limit_usd: opts.manifestFields.daily_loss_limit_usd,
    max_drawdown_usd: opts.manifestFields.max_drawdown_usd,
    boundary_buffer_pct: opts.manifestFields.boundary_buffer_pct,
    venue: opts.venue,
    symbol: opts.symbol,
    scope_key: opts.scopeKey || `${opts.venue}:${opts.symbol}`,
    lease_generation: opts.leaseGeneration || "dry-run-no-lease",
  };
  const manifestPath = path.join(dir, "manifest.json");
  const eventsPath = path.join(dir, "events.jsonl");
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, manifestText, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const manifestSha256 = sha256Json(manifest);
  let dropped = 0;

  const emit = (event: ExperimentEventName, fields: Partial<ExperimentEvent> = {}): boolean => {
    try {
      const row: ExperimentEvent = {
        schema_version: "2.0",
        event_id: crypto.randomUUID(),
        run_id: runId,
        manifest_sha256: manifestSha256,
        ts: new Date().toISOString(),
        exchange_ts: fields.exchange_ts ? String(fields.exchange_ts) : null,
        experiment_id: experimentId,
        bot: opts.bot || "classic-grid",
        commit_sha: commitSha,
        mode: opts.mode,
        venue: String(fields.venue ?? opts.venue),
        symbol: String(fields.symbol ?? opts.symbol),
        event,
        intent_id: fields.intent_id ? String(fields.intent_id) : null,
        client_order_id: fields.client_order_id ? String(fields.client_order_id) : null,
        exchange_order_id: fields.exchange_order_id ? String(fields.exchange_order_id) : null,
        exchange_trade_id: fields.exchange_trade_id ? String(fields.exchange_trade_id) : null,
        account_scope: fields.account_scope ? String(fields.account_scope) : null,
        anchor_epoch: nullableNumber(fields.anchor_epoch),
        lease_generation: opts.leaseGeneration || "dry-run-no-lease",
        source: String(fields.source || "classic-grid"),
        order_status: safeCode(fields.order_status),
        filled_qty: nullableNumber(fields.filled_qty),
        remaining_qty: nullableNumber(fields.remaining_qty),
        anchor: nullableNumber(fields.anchor), grid_lower: nullableNumber(fields.grid_lower), grid_upper: nullableNumber(fields.grid_upper),
        grid_level: nullableNumber(fields.grid_level), side: fields.side ? String(fields.side) : null,
        mid: nullableNumber(fields.mid), equity_usd: nullableNumber(fields.equity_usd), free_margin_usd: nullableNumber(fields.free_margin_usd),
        leverage: nullableNumber(fields.leverage), position_qty: nullableNumber(fields.position_qty), position_notional_usd: nullableNumber(fields.position_notional_usd),
        planned_gross_notional_usd: nullableNumber(fields.planned_gross_notional_usd), margin_used_usd: nullableNumber(fields.margin_used_usd),
        open_order_count: nullableNumber(fields.open_order_count), order_id: fields.order_id ? String(fields.order_id) : null,
        order_price: nullableNumber(fields.order_price), order_qty: nullableNumber(fields.order_qty), fee_usd: nullableNumber(fields.fee_usd),
        funding_usd: nullableNumber(fields.funding_usd), realized_pnl_usd: nullableNumber(fields.realized_pnl_usd),
        unrealized_pnl_usd: nullableNumber(fields.unrealized_pnl_usd), net_pnl_usd: nullableNumber(fields.net_pnl_usd),
        grid_profit_estimate_usd: nullableNumber(fields.grid_profit_estimate_usd), api_latency_ms: nullableNumber(fields.api_latency_ms),
        error_code: safeCode(fields.error_code),
        // Free-form remote errors can contain credentials. Exact diagnostics remain only in local logs.
        error_message: fields.error_message == null ? null : "diagnostic omitted; see local logs",
        restart_count: nullableNumber(fields.restart_count) ?? 0,
        reconnect_count: nullableNumber(fields.reconnect_count) ?? 0,
        risk_flags: Array.isArray(fields.risk_flags) ? fields.risk_flags.map(safeCode).filter((x): x is string => Boolean(x)) : [],
      };
      const fd = fs.openSync(eventsPath, "a", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(row)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      dropped += 1;
      return false;
    }
  };

  return { dir, manifestPath, eventsPath, manifest, manifestSha256, droppedEvents: () => dropped, emit };
}

export function fillFieldsFromExecution(record: ExecutionRecord): Partial<ExperimentEvent> {
  return {
    source: "exchange",
    venue: record.venue,
    symbol: record.market,
    side: record.side,
    order_price: record.price,
    filled_qty: record.quantity,
    remaining_qty: record.remainingQuantity ?? null,
    exchange_order_id: record.exchangeOrderId ?? null,
    client_order_id: record.clientOrderId ?? null,
    exchange_trade_id: record.exchangeTradeId ?? null,
    order_id: record.exchangeOrderId ?? null,
    exchange_ts: record.exchangeTimestamp ?? null,
  };
}

export function publishExecutionJournal(
  emit: (event: ExperimentEventName, fields?: Partial<ExperimentEvent>) => unknown,
  drain: Pick<ExecutionJournalDrain, "faults" | "authoritativeExecutions">,
): string[] {
  const published: string[] = [];
  try {
    for (const fault of drain.faults) {
      emit("EXECUTION_RECONCILIATION_REQUIRED", {
        source: "classic-grid",
        error_code: fault.code,
        venue: "extended",
      });
    }
    const authoritative = Array.isArray(drain.authoritativeExecutions)
      ? drain.authoritativeExecutions
      : [];
    for (const record of authoritative) {
      if (!record.authoritative) continue;
      const accepted = emit("FILL", fillFieldsFromExecution(record));
      if (accepted === false) break;
      published.push(record.dedupeKey);
    }
  } catch {
    /* telemetry must never control trading; unacked pending records remain drainable */
  }
  return published;
}

export type { ExecutionFault, ExecutionJournalDrain, ExecutionRecord };
