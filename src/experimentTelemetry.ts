import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ExperimentMode = "dry-run" | "live";

export type ExperimentManifest = {
  experiment_spec_version: string;
  experiment_id: string;
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
};

export type ExperimentEventName =
  | "SNAPSHOT"
  | "ORDER_SUBMIT"
  | "ORDER_ACK"
  | "FILL"
  | "CANCEL"
  | "RESTART"
  | "ERROR"
  | "RISK_HALT";

export type ExperimentEvent = {
  schema_version: "1.0";
  ts: string;
  experiment_id: string;
  bot: string;
  commit_sha: string;
  mode: ExperimentMode;
  venue: string;
  symbol: string;
  event: ExperimentEventName;
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
  client_order_id: string | null;
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

const SECRET_RE = /api[_-]?key|secret|private[_-]?key|token|authorization|password/i;

export function readCommitSha(): string {
  if (process.env.COMMIT_SHA?.trim()) return process.env.COMMIT_SHA.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function redact(value: unknown): unknown {
  if (typeof value === "string" && SECRET_RE.test(value)) return "[redacted]";
  return value;
}

export function createExperimentTelemetry(opts: {
  experimentId: string;
  bot?: "classic-grid" | "ritmex-bot";
  mode: ExperimentMode;
  venue: string;
  symbol: string;
  commitSha?: string;
  baseDir?: string;
  repo?: string;
  manifestFields: Omit<
    ExperimentManifest,
    "experiment_id" | "bot" | "repo" | "commit_sha" | "started_at" | "mode" | "venue" | "symbol"
  > &
    Partial<Pick<ExperimentManifest, "repo">>;
}): {
  dir: string;
  manifestPath: string;
  eventsPath: string;
  manifest: ExperimentManifest;
  emit: (event: ExperimentEventName, fields?: Partial<ExperimentEvent>) => void;
} {
  const commitSha = opts.commitSha || readCommitSha();
  const dir = path.join(
    opts.baseDir || path.resolve(process.cwd(), "data", "experiments"),
    opts.experimentId
  );
  fs.mkdirSync(dir, { recursive: true });
  const manifest: ExperimentManifest = {
    experiment_spec_version: opts.manifestFields.experiment_spec_version,
    experiment_id: opts.experimentId,
    bot: opts.bot || "classic-grid",
    repo: opts.manifestFields.repo || opts.repo || "https://github.com/beibei030/classic-grid",
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
  };
  const manifestPath = path.join(dir, "manifest.json");
  const eventsPath = path.join(dir, "events.jsonl");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, "", "utf8");

  const emit = (event: ExperimentEventName, fields: Partial<ExperimentEvent> = {}): void => {
    const row: ExperimentEvent = {
      schema_version: "1.0",
      ts: new Date().toISOString(),
      experiment_id: opts.experimentId,
      bot: opts.bot || "classic-grid",
      commit_sha: commitSha,
      mode: opts.mode,
      venue: fields.venue ?? opts.venue,
      symbol: fields.symbol ?? opts.symbol,
      event,
      anchor: fields.anchor ?? null,
      grid_lower: fields.grid_lower ?? null,
      grid_upper: fields.grid_upper ?? null,
      grid_level: fields.grid_level ?? null,
      side: fields.side ?? null,
      mid: fields.mid ?? null,
      equity_usd: fields.equity_usd ?? null,
      free_margin_usd: fields.free_margin_usd ?? null,
      leverage: fields.leverage ?? null,
      position_qty: fields.position_qty ?? null,
      position_notional_usd: fields.position_notional_usd ?? null,
      planned_gross_notional_usd: fields.planned_gross_notional_usd ?? null,
      margin_used_usd: fields.margin_used_usd ?? null,
      open_order_count: fields.open_order_count ?? null,
      order_id: fields.order_id ?? null,
      client_order_id: fields.client_order_id ?? null,
      order_price: fields.order_price ?? null,
      order_qty: fields.order_qty ?? null,
      fee_usd: fields.fee_usd ?? null,
      funding_usd: fields.funding_usd ?? null,
      realized_pnl_usd: fields.realized_pnl_usd ?? null,
      unrealized_pnl_usd: fields.unrealized_pnl_usd ?? null,
      net_pnl_usd: fields.net_pnl_usd ?? null,
      grid_profit_estimate_usd: fields.grid_profit_estimate_usd ?? null,
      api_latency_ms: fields.api_latency_ms ?? null,
      error_code: fields.error_code ?? null,
      error_message:
        fields.error_message != null ? String(redact(fields.error_message)) : null,
      restart_count: fields.restart_count ?? 0,
      reconnect_count: fields.reconnect_count ?? 0,
      risk_flags: Array.isArray(fields.risk_flags) ? fields.risk_flags.map(String) : [],
    };
    fs.appendFileSync(eventsPath, JSON.stringify(row) + "\n", "utf8");
  };

  return { dir, manifestPath, eventsPath, manifest, emit };
}
