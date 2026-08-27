import type { GridParams, VenueId } from "./types.js";
import {
  parseExecutionBoundary,
  qualifySandboxNetworkProfile,
  type ExecutionTarget,
  type ExtendedNetworkId,
  type ExtendedNetworkProfile,
} from "./extendedNetwork.js";
import { loadEnv } from "./loadEnv.js";

/**
 * 以各所启动瞬间 mid 为锚点。
 * - Extended：80 格、30x，带宽约 ±4.6%
 * - Phoenix / Nado：80 格、30x，带宽 ±4.5%（同 Ext 资金模板）
 * - PopDEX：80 格、20x、±4.5%（同 Ext/Phx 带宽；权益默认 800，可 POPDEX_EQUITY_USD 覆盖）
 * - Decibel / N1：80 格、30x、带宽 ±5%（费率偏贵，略加半幅；下单 post-only/maker）
 * - RISEx：46 格、25x、半幅约 ±3%
 * 保证金占用统一 70%（MARGIN_FRAC）；默认权益预算 800U
 */
export const REF_MID = 65_000;
export const HALF_BAND = 3000;
/** RISEx：±3% → 参考半幅 = 0.03 * REF_MID */
export const RISEX_HALF_BAND = Math.round(REF_MID * 0.03);
/** Phoenix：±4.5% */
export const PHOENIX_HALF_BAND = Math.round(REF_MID * 0.045);
/** Decibel / N1：±5%（相对 Ext ±4.6% 略加宽，改善费率边） */
export const DECIBEL_HALF_BAND = Math.round(REF_MID * 0.05);
export const N1_HALF_BAND = Math.round(REF_MID * 0.05);
const EQUITY = 800;
const MARGIN_FRAC = 0.7;
const LEVERAGE = 30;
/** RISEx 所上杠杆上限按 25 处理 */
const RISEX_LEVERAGE = 25;
/** Phoenix：与 Ext 对齐 30x（不再默认 40） */
const PHOENIX_LEVERAGE = 30;

const SHARED = {
  halfBand: HALF_BAND,
  leverage: LEVERAGE,
  feeRate: 0.0005,
  equityUsd: EQUITY,
  marginFraction: MARGIN_FRAC,
  maxWritesPerTick: 10,
  mode: "neutral" as const,
  /**
   * 近价跳过带宽（×spacing）。过小则 mid 在格线上微抖时，
   * 同一档会买完又被 seed 成卖 → 同价开平只亏手续费。
   */
  skipBand: 0.5,
};

/** Ext 模板（兼容旧引用） */
export const GRID: GridParams = {
  ...SHARED,
  lower: 0,
  upper: 0,
  gridCount: 80,
  sizeBase: 0,
};

const VENUE_GRID_COUNT: Record<VenueId, number> = {
  extended: 80,
  phoenix: 80,
  phoenix2: 80,
  nado: 80,
  popdex: 80,
  n1: 80,
  risex: 46,
  decibel: 80,
};

const VENUE_HALF_BAND: Partial<Record<VenueId, number>> = {
  risex: RISEX_HALF_BAND,
  phoenix: PHOENIX_HALF_BAND,
  phoenix2: PHOENIX_HALF_BAND,
  nado: PHOENIX_HALF_BAND,
  popdex: PHOENIX_HALF_BAND,
  decibel: DECIBEL_HALF_BAND,
  n1: N1_HALF_BAND,
};

const VENUE_MAX_OPEN: Partial<Record<VenueId, number>> = {
  extended: 82,
  phoenix: 82,
  phoenix2: 82,
  nado: 82,
  popdex: 82,
  n1: 82,
  risex: 50,
  decibel: 82,
};

/** 分所默认杠杆（可被 env 覆盖） */
const VENUE_LEVERAGE: Record<VenueId, number> = {
  extended: 30,
  phoenix: PHOENIX_LEVERAGE,
  phoenix2: PHOENIX_LEVERAGE,
  nado: 30,
  popdex: 30,
  n1: 30,
  decibel: 30,
  risex: RISEX_LEVERAGE,
};

export const ALL_VENUES: VenueId[] = [
  "extended",
  "risex",
  "decibel",
  "n1",
  "phoenix",
  "phoenix2",
  "nado",
  "popdex",
];

export type ExperimentSpecVersion = "0.1.0" | "0.2.0";

export type ExperimentConfig = {
  enabled: boolean;
  id: string;
  specVersion: ExperimentSpecVersion;
  capitalUsd: number;
  leverage: number;
  marginFraction: number;
  marginBudgetUsd: number;
  gridCount: number;
  halfBandPct: number;
  maxGrossNotionalUsd: number;
  dailyLossUsd: number;
  maxDrawdownUsd: number;
  boundaryBufferPct: number;
};

type ExperimentProfile = {
  capitalUsd: number;
  leverage: number;
  marginFraction: number;
  marginBudgetUsd: number;
  gridCount: number;
  halfBandPct: number;
  maxGrossNotionalUsd: number;
  dailyLossUsd: number;
  maxDrawdownUsd: number;
  boundaryBufferPct: number;
  tickMs: number;
};

const EXPERIMENT_PROFILE_V01 = {
  capitalUsd: 50,
  leverage: 10,
  marginFraction: 0.3,
  marginBudgetUsd: 15,
  gridCount: 12,
  halfBandPct: 0.03,
  maxGrossNotionalUsd: 150,
  dailyLossUsd: 2.5,
  maxDrawdownUsd: 5,
  boundaryBufferPct: 0.01,
  tickMs: 15_000,
} as const satisfies ExperimentProfile;

const EXPERIMENT_PROFILE_V02 = {
  capitalUsd: 100,
  leverage: 5,
  marginFraction: 0.3,
  marginBudgetUsd: 30,
  gridCount: 10,
  halfBandPct: 0.03,
  maxGrossNotionalUsd: 150,
  dailyLossUsd: 5,
  maxDrawdownUsd: 10,
  boundaryBufferPct: 0.01,
  tickMs: 15_000,
} as const satisfies ExperimentProfile;

const EXPERIMENT_PROFILES: Record<ExperimentSpecVersion, ExperimentProfile> = {
  "0.1.0": EXPERIMENT_PROFILE_V01,
  "0.2.0": EXPERIMENT_PROFILE_V02,
};

/** Historical v0.1 defaults. Kept intact; v0.2 uses its own frozen profile. */
const EXPERIMENT_DEFAULTS = EXPERIMENT_PROFILE_V01;

function parseExperimentSpecVersion(enabled: boolean): ExperimentSpecVersion {
  const raw = String(process.env.EXPERIMENT_SPEC_VERSION ?? "").trim();
  if (!enabled) return "0.1.0";
  // Absent version keeps v0.1 historical behavior. It must not select v0.2.
  if (raw === "") return "0.1.0";
  if (raw === "0.1.0" || raw === "0.2.0") return raw;
  throw new Error("EXPERIMENT_SPEC_VERSION_UNSUPPORTED");
}

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes", "YES"].includes(String(v || "").trim());
}

export type RuntimeConfig = {
  dryRun: boolean;
  liveConfirm: boolean;
  executionTarget: ExecutionTarget;
  sandboxConfirm: boolean;
  extendedNetwork: ExtendedNetworkId | null;
  extendedNetworkExplicit: boolean;
  extendedProfile: ExtendedNetworkProfile | null;
  venues: VenueId[];
  markets: string[];
  tickMs: number;
  dashboardPort: number;
  grids: Record<VenueId, GridParams>;
  experiment: ExperimentConfig;
};

export function gridFor(cfg: RuntimeConfig, venue: VenueId): GridParams {
  return cfg.grids[venue];
}

export function anchorGrid(base: GridParams, mid: number): GridParams {
  if (!(mid > 0)) throw new Error(`无效 mid=${mid}`);
  const half =
    base.halfBandPct != null && base.halfBandPct > 0
      ? mid * base.halfBandPct
      : mid * ((base.halfBand || HALF_BAND) / REF_MID);
  const lower = mid - half;
  const upper = mid + half;
  const notional = base.equityUsd * base.marginFraction * base.leverage;
  const sizeBase =
    Math.floor((notional / (base.gridCount * mid)) * 1e8) / 1e8;
  return { ...base, halfBand: half, lower, upper, sizeBase };
}

function numEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function parseExperimentConfig(): ExperimentConfig {
  const enabled = truthy(process.env.EXPERIMENT_MODE);
  const specVersion = parseExperimentSpecVersion(enabled);
  const profile = EXPERIMENT_PROFILES[specVersion];
  const id = String(process.env.EXPERIMENT_ID || "").trim();
  if (specVersion === "0.2.0") {
    return {
      enabled,
      id: id || (enabled ? "grid-ab-v0.1-classic-local" : ""),
      specVersion,
      capitalUsd: profile.capitalUsd,
      leverage: profile.leverage,
      marginFraction: profile.marginFraction,
      marginBudgetUsd: profile.marginBudgetUsd,
      gridCount: profile.gridCount,
      halfBandPct: profile.halfBandPct,
      maxGrossNotionalUsd: profile.maxGrossNotionalUsd,
      dailyLossUsd: profile.dailyLossUsd,
      maxDrawdownUsd: profile.maxDrawdownUsd,
      boundaryBufferPct: profile.boundaryBufferPct,
    };
  }
  const capitalUsd = Math.max(0, numEnv(process.env.EXPERIMENT_CAPITAL_USD, EXPERIMENT_DEFAULTS.capitalUsd));
  const leverage = Math.max(1, numEnv(process.env.EXPERIMENT_LEVERAGE, EXPERIMENT_DEFAULTS.leverage));
  const marginFraction = Math.min(
    1,
    Math.max(0.05, numEnv(process.env.EXPERIMENT_MARGIN_FRAC, EXPERIMENT_DEFAULTS.marginFraction))
  );
  return {
    enabled,
    id: id || (enabled ? "grid-ab-v0.1-classic-local" : ""),
    specVersion,
    capitalUsd,
    leverage,
    marginFraction,
    marginBudgetUsd: Number((capitalUsd * marginFraction).toFixed(6)),
    gridCount: Math.max(2, Math.round(numEnv(process.env.EXPERIMENT_GRID_COUNT, EXPERIMENT_DEFAULTS.gridCount))),
    halfBandPct: Math.max(
      0.0001,
      numEnv(process.env.EXPERIMENT_HALF_BAND_PCT, EXPERIMENT_DEFAULTS.halfBandPct)
    ),
    maxGrossNotionalUsd: Math.max(
      0,
      numEnv(process.env.EXPERIMENT_MAX_GROSS_NOTIONAL_USD, EXPERIMENT_DEFAULTS.maxGrossNotionalUsd)
    ),
    dailyLossUsd: Math.max(
      0,
      numEnv(process.env.EXPERIMENT_DAILY_LOSS_USD, EXPERIMENT_DEFAULTS.dailyLossUsd)
    ),
    maxDrawdownUsd: Math.max(
      0,
      numEnv(process.env.EXPERIMENT_MAX_DRAWDOWN_USD, EXPERIMENT_DEFAULTS.maxDrawdownUsd)
    ),
    boundaryBufferPct: Math.max(
      0,
      numEnv(process.env.EXPERIMENT_BOUNDARY_BUFFER_PCT, EXPERIMENT_DEFAULTS.boundaryBufferPct)
    ),
  };
}

/** 实验模式杠杆覆盖各所 env / 默认值；非实验模式返回 null */
export function readExperimentLeverage(): number | null {
  loadEnv();
  if (!truthy(process.env.EXPERIMENT_MODE)) return null;
  return parseExperimentConfig().leverage;
}

export function formatExperimentBanner(cfg: RuntimeConfig): string {
  const e = cfg.experiment;
  const marginBudget = Number((e.capitalUsd * e.marginFraction).toFixed(6));
  const halfPct = Number((e.halfBandPct * 100).toFixed(6));
  return [
    "EXPERIMENT MODE",
    `capital=${e.capitalUsd}U`,
    `leverage=${e.leverage}x`,
    `marginBudget=${marginBudget}U`,
    `maxGrossNotional=${e.maxGrossNotionalUsd}U`,
    `gridCount=${e.gridCount}`,
    `halfBand=${halfPct}%`,
    `dailyLossLimit=${e.dailyLossUsd}U`,
    `maxDrawdown=${e.maxDrawdownUsd}U`,
  ].join("\n");
}

function leverageFor(
  venue: VenueId,
  fallbackGridLev: number,
  experiment: ExperimentConfig
): number {
  if (experiment.enabled) return experiment.leverage;
  if (venue === "risex") {
    return Math.max(
      1,
      Number(process.env.RISEX_LEVERAGE || process.env.RISE_LEVERAGE || RISEX_LEVERAGE) ||
        RISEX_LEVERAGE
    );
  }
  if (venue === "phoenix" || venue === "phoenix2") {
    const envLev =
      venue === "phoenix2"
        ? process.env.PHOENIX2_LEVERAGE || process.env.PHOENIX_LEVERAGE
        : process.env.PHOENIX_LEVERAGE;
    return Math.max(1, Number(envLev || PHOENIX_LEVERAGE) || PHOENIX_LEVERAGE);
  }
  if (venue === "nado") {
    return Math.max(1, Number(process.env.NADO_LEVERAGE || 30) || 30);
  }
  if (venue === "popdex") {
    return Math.max(1, Number(process.env.POPDEX_LEVERAGE || 30) || 30);
  }
  const envKey =
    venue === "extended"
      ? process.env.EXTENDED_LEVERAGE
      : venue === "decibel"
        ? process.env.DECIBEL_LEVERAGE
        : process.env.N1_LEVERAGE;
  // 分所默认优先于 GRID_LEVERAGE，避免本机 GRID_LEVERAGE 误覆盖定档
  return Math.max(
    1,
    Number(
      envKey ||
        VENUE_LEVERAGE[venue] ||
        process.env.GRID_LEVERAGE ||
        fallbackGridLev
    ) ||
      VENUE_LEVERAGE[venue] ||
      fallbackGridLev
  );
}

function equityFor(venue: VenueId, experiment: ExperimentConfig): number {
  if (experiment.enabled) return experiment.capitalUsd;
  if (venue === "popdex") {
    const n = Number(process.env.POPDEX_EQUITY_USD);
    if (Number.isFinite(n) && n > 0) return n;
    return EQUITY;
  }
  const envKey =
    venue === "decibel"
      ? process.env.DECIBEL_EQUITY_USD
      : venue === "n1"
        ? process.env.N1_EQUITY_USD
        : "";
  const n = Number(envKey);
  if (Number.isFinite(n) && n >= 50) return n;
  return EQUITY;
}

export function loadRuntimeConfig(): RuntimeConfig {
  loadEnv();
  const experiment = parseExperimentConfig();
  const boundary = parseExecutionBoundary();
  const dryRun = boundary.dryRun;
  const liveConfirm = boundary.liveConfirm;
  const venues = String(process.env.VENUES || "extended,risex,decibel,n1")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((v): v is VenueId => (ALL_VENUES as string[]).includes(v));
  const markets = String(process.env.MARKETS || "BTC")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const tickMs = experiment.enabled && experiment.specVersion === "0.2.0"
    ? EXPERIMENT_PROFILE_V02.tickMs
    : Math.max(1000, Number(process.env.TICK_MS || 15_000) || 15_000);
  const leverage = Math.max(
    1,
    Number(process.env.GRID_LEVERAGE || LEVERAGE) || LEVERAGE
  );
  const marginFraction = experiment.enabled
    ? experiment.marginFraction
    : Math.min(
        1,
        Math.max(
          0.05,
          Number(process.env.GRID_MARGIN_FRAC || MARGIN_FRAC) || MARGIN_FRAC
        )
      );
  const halfBand = Math.max(
    100,
    Number(process.env.GRID_HALF_BAND || HALF_BAND) || HALF_BAND
  );
  const dashboardPort = Math.max(
    0,
    Number(process.env.DASHBOARD_PORT || 8088) || 8088
  );

  const grids = {} as Record<VenueId, GridParams>;
  for (const v of ALL_VENUES) {
    const gridCount = experiment.enabled
      ? experiment.gridCount
      : v === "popdex"
        ? Math.max(
            2,
            Number(process.env.POPDEX_GRID_COUNT || VENUE_GRID_COUNT.popdex) ||
              VENUE_GRID_COUNT.popdex
          )
        : VENUE_GRID_COUNT[v];
    const venueLev = leverageFor(v, leverage, experiment);
    const venueHalf =
      v === "risex"
        ? Math.max(
            100,
            Number(process.env.RISEX_HALF_BAND || VENUE_HALF_BAND.risex || RISEX_HALF_BAND) ||
              RISEX_HALF_BAND
          )
        : v === "phoenix" || v === "phoenix2" || v === "nado" || v === "popdex"
          ? Math.max(
              100,
              Number(
                (v === "nado"
                  ? process.env.NADO_HALF_BAND
                  : v === "popdex"
                    ? process.env.POPDEX_HALF_BAND || process.env.PHOENIX_HALF_BAND
                    : v === "phoenix2"
                      ? process.env.PHOENIX2_HALF_BAND || process.env.PHOENIX_HALF_BAND
                      : process.env.PHOENIX_HALF_BAND) ||
                  VENUE_HALF_BAND[v] ||
                  PHOENIX_HALF_BAND
              ) || PHOENIX_HALF_BAND
            )
          : v === "decibel" || v === "n1"
            ? Math.max(
                100,
                Number(
                  (v === "n1"
                    ? process.env.N1_HALF_BAND || process.env.DECIBEL_HALF_BAND
                    : process.env.DECIBEL_HALF_BAND || process.env.N1_HALF_BAND) ||
                    VENUE_HALF_BAND[v] ||
                    DECIBEL_HALF_BAND
                ) || DECIBEL_HALF_BAND
              )
            : halfBand;
    grids[v] = {
      ...SHARED,
      equityUsd: equityFor(v, experiment),
      marginFraction,
      halfBand: experiment.enabled ? REF_MID * experiment.halfBandPct : venueHalf,
      ...(experiment.enabled ? { halfBandPct: experiment.halfBandPct } : {}),
      leverage: venueLev,
      // Phoenix maker 更低；Nado / N1 / Decibel / PopDEX 按所 maker 档
      ...(v === "phoenix" || v === "phoenix2" ? { feeRate: 0.00005 } : {}),
      ...(v === "nado" || v === "n1" ? { feeRate: 0.0001 } : {}),
      ...(v === "popdex" ? { feeRate: 0.00012 } : {}),
      ...(v === "decibel" ? { feeRate: 0.00011 } : {}),
      // 换带宽时加快撤挂收敛（仓位不动，只改单）
      ...(v === "decibel" || v === "n1" ? { maxWritesPerTick: 40 } : {}),
      ...(experiment.enabled
        ? { maxWritesPerTick: Math.max(40, experiment.gridCount + 4) }
        : {}),
      lower: 0,
      upper: 0,
      gridCount,
      sizeBase: 0,
      ...(VENUE_MAX_OPEN[v] != null ? { maxOpenOrders: VENUE_MAX_OPEN[v] } : {}),
    };
  }

  return {
    dryRun,
    liveConfirm,
    executionTarget: boundary.executionTarget,
    sandboxConfirm: boundary.sandboxConfirm,
    extendedNetwork: boundary.extendedNetwork,
    extendedNetworkExplicit: boundary.extendedNetworkExplicit,
    extendedProfile: boundary.profile,
    venues: venues.length ? venues : [...ALL_VENUES],
    markets: markets.length ? markets : ["BTC"],
    tickMs,
    dashboardPort,
    grids,
    experiment,
  };
}

export function assertExecutionAllowed(cfg: RuntimeConfig): void {
  if (cfg.executionTarget === "dry-run") return;
  if (cfg.executionTarget === "sandbox") {
    if (!cfg.extendedProfile) throw new Error("EXTENDED_NETWORK_REQUIRED");
    qualifySandboxNetworkProfile(cfg.extendedProfile);
    if (cfg.liveConfirm || !cfg.sandboxConfirm) {
      throw new Error("EXECUTION_CONFIRMATION_CONFLICT");
    }
    return;
  }
  assertLiveAllowed(cfg);
}

export function assertLiveAllowed(cfg: RuntimeConfig): void {
  if (cfg.dryRun) return;
  if (!cfg.liveConfirm) {
    throw new Error("拒绝实盘：需要 LIVE_CONFIRM=YES（且 DRY_RUN=0）");
  }
  if (!cfg.experiment.enabled) return;
  const e = cfg.experiment;
  if (e.specVersion === "0.2.0") {
    throw new Error("拒绝实盘：v0.2 尚未授权 live（EXPERIMENT_V02_LIVE_FORBIDDEN）");
  }
  if (cfg.venues.length !== 1 || cfg.markets.length !== 1) {
    throw new Error("拒绝实盘：v0.1 实验必须恰好 1 个 venue 与 1 个 market");
  }
  const frozen = [
    ["capitalUsd", e.capitalUsd, 50],
    ["leverage", e.leverage, 10],
    ["marginFraction", e.marginFraction, 0.3],
    ["gridCount", e.gridCount, 12],
    ["halfBandPct", e.halfBandPct, 0.03],
    ["maxGrossNotionalUsd", e.maxGrossNotionalUsd, 150],
    ["dailyLossUsd", e.dailyLossUsd, 2.5],
    ["maxDrawdownUsd", e.maxDrawdownUsd, 5],
    ["boundaryBufferPct", e.boundaryBufferPct, 0.01],
  ] as const;
  for (const [name, actual, expected] of frozen) {
    if (Math.abs(actual - expected) > 1e-9) {
      throw new Error(`拒绝实盘：实验规格 ${name}=${actual}，冻结值必须为 ${expected}`);
    }
  }
  const accountScope = String(process.env.EXPERIMENT_ACCOUNT_SCOPE || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(accountScope)) {
    throw new Error("拒绝实盘：需要非敏感的 EXPERIMENT_ACCOUNT_SCOPE 绑定账户范围");
  }
  if (e.id !== "grid-ab-v0.1-classic-live") {
    throw new Error("拒绝实盘：EXPERIMENT_ID 不在 v0.1 live allowlist");
  }
  if (cfg.venues[0] !== "extended" || cfg.markets[0] !== "BTC") {
    throw new Error("拒绝实盘：v0.1 目前只开放已具备 ownership/leverage readback 的 extended:BTC");
  }
  if (process.env.GRID_SKIP_LEVERAGE === "1" || process.env.RISE_SKIP_LEVERAGE === "1") {
    throw new Error("拒绝实盘：不得跳过杠杆设置与读回验证");
  }
  const marginBudget = e.capitalUsd * e.marginFraction;
  const planned = marginBudget * e.leverage;
  if (marginBudget > 15 + 1e-9) {
    throw new Error(`拒绝实盘：实验保证金预算 ${marginBudget}U > 15U`);
  }
  if (planned > e.maxGrossNotionalUsd + 1e-9) {
    throw new Error(
      `拒绝实盘：实验计划名义 ${planned}U > ${e.maxGrossNotionalUsd}U`
    );
  }
}
