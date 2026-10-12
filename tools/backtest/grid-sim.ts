/**
 * Candle-driven simulator for the classic-grid strategy (research only, no venue I/O).
 *
 * Two order-management models share the same grid, fills and risk rules:
 * - "reseed":  planFromFillsAndSeed default (non-experiment mode, and experiment mode
 *              before the seedEmptyLevels fix): replacement for each fill if its level is
 *              empty, then every empty level is re-seeded by side of mid
 *              (buy below / sell above, skipping |level - mid| < skipBand * spacing).
 * - "classic": textbook grid: seed once at anchor, afterwards only replacements
 *              (experiment mode: planFromFillsAndSeed with seedEmptyLevels false).
 *
 * Fill model (one bot tick per 1m candle): orders resting at candle open fill when the
 * candle trades through them (buy: low < price, sell: high > price). Orders placed at a
 * tick can only fill from the next candle. Risk is evaluated at candle close.
 */
import { anchorGrid } from "../../src/config.js";
import { buildGrid, replacementFor, seedOrders } from "../../src/grid.js";
import type { GridParams, Side } from "../../src/types.js";

export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type FundingRow = { t: number; rate: number };
export type Strategy = "reseed" | "classic";
export type Placement = { levelIndex: number; side: Side };

export type SimConfig = {
  strategy: Strategy;
  capitalUsd: number;
  leverage: number;
  marginFraction: number;
  gridCount: number;
  halfBandPct: number;
  skipBand: number;
  sizeStep: number;
  makerFee: number;
  takerFee: number;
  dailyLossUsd: number;
  /** null disables the drawdown-from-start halt (long-run economics). */
  maxDrawdownUsd: number | null;
  boundaryBufferPct: number;
  maxGrossNotionalUsd: number;
};

/** Frozen v0.1 experiment profile (src/config.ts EXPERIMENT_PROFILE_V01). */
export const V01_PROFILE = {
  capitalUsd: 50,
  leverage: 10,
  marginFraction: 0.3,
  gridCount: 12,
  halfBandPct: 0.03,
  skipBand: 0.5,
  sizeStep: 0.00001,
  dailyLossUsd: 2.5,
  maxDrawdownUsd: 5,
  boundaryBufferPct: 0.01,
  maxGrossNotionalUsd: 150,
} as const;

export type HaltEvent = { t: number; reasons: string[]; equity: number; closedQty: number; closePnlUsd: number };

export type SimResult = {
  startEquity: number;
  endEquity: number;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  fundingUsd: number;
  maxDrawdownUsd: number;
  minEquity: number;
  fills: number;
  maxAbsPositionUsd: number;
  anchors: number;
  halts: HaltEvent[];
  notionalCapEvents: number;
  stoppedAt: number | null;
  equityByMonth: Array<{ month: string; equity: number }>;
};

const DAY_MS = 86_400_000;
const EPS = 1e-12;

/** Reseed model: same placement rule as planFromFillsAndSeed with replacements consumed at once. */
export function reseedPlacements(p: {
  levels: number[];
  spacing: number;
  skipBand: number;
  mid: number;
  occupied: ReadonlySet<number>;
  filled: Array<{ side: Side; levelIndex: number }>;
}): Placement[] {
  const taken = new Set(p.occupied);
  const out: Placement[] = [];
  for (const f of p.filled) {
    const r = replacementFor(f, p.levels, "neutral");
    if (r && !taken.has(r.levelIndex)) {
      taken.add(r.levelIndex);
      out.push({ levelIndex: r.levelIndex, side: r.side });
    }
  }
  for (const s of seedOrders({ levels: p.levels, price: p.mid, mode: "neutral", spacing: p.spacing, skipBand: p.skipBand })) {
    if (taken.has(s.levelIndex)) continue;
    taken.add(s.levelIndex);
    out.push({ levelIndex: s.levelIndex, side: s.side });
  }
  return out;
}

/** Classic model: only replacements after the initial seed. */
export function classicPlacements(p: {
  levels: number[];
  occupied: ReadonlySet<number>;
  filled: Array<{ side: Side; levelIndex: number }>;
}): Placement[] {
  const taken = new Set(p.occupied);
  const out: Placement[] = [];
  for (const f of p.filled) {
    const r = replacementFor(f, p.levels, "neutral");
    if (r && !taken.has(r.levelIndex)) {
      taken.add(r.levelIndex);
      out.push({ levelIndex: r.levelIndex, side: r.side });
    }
  }
  return out;
}

export function anchorFor(cfg: SimConfig, mid: number): { levels: number[]; spacing: number; lower: number; upper: number; size: number } {
  const base: GridParams = {
    lower: 0,
    upper: 0,
    halfBand: 0,
    halfBandPct: cfg.halfBandPct,
    gridCount: cfg.gridCount,
    sizeBase: 0,
    leverage: cfg.leverage,
    feeRate: cfg.makerFee,
    equityUsd: cfg.capitalUsd,
    marginFraction: cfg.marginFraction,
    maxWritesPerTick: 40,
    mode: "neutral",
    skipBand: cfg.skipBand,
  };
  const anchored = anchorGrid(base, mid);
  const built = buildGrid({ lower: anchored.lower, upper: anchored.upper, gridCount: anchored.gridCount });
  const size = Math.floor(anchored.sizeBase / cfg.sizeStep + 1e-9) * cfg.sizeStep;
  return { levels: built.levels, spacing: built.spacing, lower: anchored.lower, upper: anchored.upper, size };
}

export function simulate(candles: Candle[], funding: FundingRow[], cfg: SimConfig): SimResult {
  let pos = 0;
  let avgPx = 0;
  let realized = 0;
  let fees = 0;
  let fundingUsd = 0;
  let fills = 0;
  let anchors = 0;
  let notionalCapEvents = 0;
  let maxAbsPositionUsd = 0;
  let peak = cfg.capitalUsd;
  let maxDrawdown = 0;
  let minEquity = cfg.capitalUsd;
  let stoppedAt: number | null = null;
  let pausedUntil = 0;
  let fi = 0;
  let day = -1;
  let dayBase = 0;
  let lastMark = candles[0]?.o ?? 0;
  const halts: HaltEvent[] = [];
  const months = new Map<string, number>();
  let grid: ReturnType<typeof anchorFor> | null = null;
  const orders = new Map<number, Side>();

  const trade = (side: Side, price: number, qty: number, feeRate: number): void => {
    const signed = side === "buy" ? qty : -qty;
    if (Math.abs(pos) > EPS && Math.sign(signed) !== Math.sign(pos)) {
      realized += Math.min(qty, Math.abs(pos)) * (price - avgPx) * Math.sign(pos);
    }
    const next = Math.round((pos + signed) * 1e10) / 1e10;
    if (Math.abs(next) < EPS) avgPx = 0;
    else if (Math.abs(pos) < EPS || Math.sign(next) !== Math.sign(pos)) avgPx = price;
    else if (Math.abs(next) > Math.abs(pos)) avgPx = (avgPx * Math.abs(pos) + price * qty) / Math.abs(next);
    pos = Math.abs(next) < EPS ? 0 : next;
    fees += price * qty * feeRate;
    fills += 1;
  };
  const equityAt = (mark: number): number => cfg.capitalUsd + realized - fees + fundingUsd + pos * (mark - avgPx);
  const place = (rows: Placement[]): void => {
    for (const r of rows) orders.set(r.levelIndex, r.side);
  };

  for (const k of candles) {
    while (fi < funding.length && funding[fi]!.t <= k.t) {
      fundingUsd -= pos * lastMark * funding[fi]!.rate;
      fi++;
    }
    const d = Math.floor(k.t / DAY_MS);
    if (d !== day) {
      day = d;
      dayBase = realized - fees + fundingUsd;
    }

    const filled: Array<{ side: Side; levelIndex: number }> = [];
    if (!grid && k.t >= pausedUntil) {
      grid = anchorFor(cfg, k.o);
      anchors++;
      orders.clear();
      place(seedOrders({ levels: grid.levels, price: k.o, mode: "neutral", spacing: grid.spacing, skipBand: cfg.skipBand }));
    }
    if (grid) {
      for (const [levelIndex, side] of [...orders]) {
        const price = grid.levels[levelIndex]!;
        if (side === "buy" ? k.l < price : k.h > price) {
          trade(side, price, grid.size, cfg.makerFee);
          orders.delete(levelIndex);
          filled.push({ side, levelIndex });
        }
      }
    }

    const mid = k.c;
    lastMark = mid;
    const reasons: string[] = [];
    if (grid) {
      const equity = equityAt(mid);
      if (cfg.maxDrawdownUsd != null && cfg.capitalUsd - equity + 1e-9 >= cfg.maxDrawdownUsd) reasons.push("DRAWDOWN_FROM_START");
      if (realized - fees + fundingUsd - dayBase <= -cfg.dailyLossUsd + 1e-9) reasons.push("DAILY_LOSS");
      if ((pos > 0 && mid < grid.lower * (1 - cfg.boundaryBufferPct)) || (pos < 0 && mid > grid.upper * (1 + cfg.boundaryBufferPct))) {
        reasons.push("RISK_BOUNDARY_BREACH");
      }
      if (Math.abs(pos) * mid > cfg.maxGrossNotionalUsd + 1e-9) reasons.push("ACTUAL_NOTIONAL_CAP");
    }
    if (grid && reasons.length > 0) {
      orders.clear();
      const closedQty = Math.abs(pos);
      const before = realized - fees;
      if (closedQty > 0) trade(pos > 0 ? "sell" : "buy", mid, closedQty, cfg.takerFee);
      halts.push({ t: k.t, reasons, equity: equityAt(mid), closedQty, closePnlUsd: realized - fees - before });
      grid = null;
      if (reasons.includes("DRAWDOWN_FROM_START")) stoppedAt = k.t;
      else if (reasons.includes("DAILY_LOSS")) pausedUntil = (d + 1) * DAY_MS;
    } else if (grid) {
      const occupied = new Set(orders.keys());
      const rows = cfg.strategy === "reseed"
        ? reseedPlacements({ levels: grid.levels, spacing: grid.spacing, skipBand: cfg.skipBand, mid, occupied, filled })
        : classicPlacements({ levels: grid.levels, occupied, filled });
      // loop.ts POST_BATCH_NOTIONAL_CAP: drop all places and cancel owned orders.
      let buyQty = 0;
      let sellQty = 0;
      for (const side of [...orders.values(), ...rows.map((r) => r.side)]) {
        if (side === "buy") buyQty += grid.size;
        else sellQty += grid.size;
      }
      if (Math.max(Math.abs(pos + buyQty), Math.abs(pos - sellQty)) * mid > cfg.maxGrossNotionalUsd + 1e-9) {
        notionalCapEvents++;
        orders.clear();
      } else {
        place(rows);
      }
    }

    const equity = equityAt(mid);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    minEquity = Math.min(minEquity, equity);
    maxAbsPositionUsd = Math.max(maxAbsPositionUsd, Math.abs(pos) * mid);
    months.set(new Date(k.t).toISOString().slice(0, 7), equity);
    if (stoppedAt != null) break;
  }

  return {
    startEquity: cfg.capitalUsd,
    endEquity: equityAt(lastMark),
    realizedUsd: realized,
    unrealizedUsd: pos * (lastMark - avgPx),
    feesUsd: fees,
    fundingUsd,
    maxDrawdownUsd: maxDrawdown,
    minEquity,
    fills,
    maxAbsPositionUsd,
    anchors,
    halts,
    notionalCapEvents,
    stoppedAt,
    equityByMonth: [...months.entries()].map(([month, equity]) => ({ month, equity })),
  };
}
