import type {
  DesiredOrder,
  GridMode,
  GridParams,
  Intent,
  LiveOrder,
  SeedOrder,
  Side,
} from "./types.js";

export type BuiltGrid = {
  levels: number[];
  spacing: number;
  count: number;
};

function round(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}

/** 等差网格：levels[0]=lower … levels[count]=upper */
export function buildGrid(p: {
  lower: number;
  upper: number;
  gridCount: number;
}): BuiltGrid {
  if (!(p.upper > p.lower)) throw new Error("upper 必须大于 lower");
  if (!(p.gridCount >= 2)) throw new Error("gridCount 至少为 2");
  const spacing = (p.upper - p.lower) / p.gridCount;
  const levels: number[] = [];
  for (let i = 0; i <= p.gridCount; i++) levels.push(round(p.lower + i * spacing));
  return { levels, spacing: round(spacing), count: p.gridCount };
}

export function isReduceOnly(side: Side, mode: GridMode): boolean {
  if (mode === "long") return side === "sell";
  if (mode === "short") return side === "buy";
  return false;
}

/** 初始铺单：现价下买上卖；近价 skipBand*spacing 内跳过 */
export function seedOrders(p: {
  levels: number[];
  price: number;
  mode: GridMode;
  skipBand?: number;
  spacing: number;
}): SeedOrder[] {
  const band = p.spacing * (p.skipBand ?? 0.25);
  const orders: SeedOrder[] = [];
  for (let i = 0; i < p.levels.length; i++) {
    const lvl = p.levels[i]!;
    if (Math.abs(lvl - p.price) < band) continue;
    if (lvl < p.price) {
      if (p.mode === "neutral" || p.mode === "long") {
        orders.push({
          levelIndex: i,
          price: lvl,
          side: "buy",
          reduceOnly: isReduceOnly("buy", p.mode),
        });
      }
    } else if (lvl > p.price) {
      if (p.mode === "neutral" || p.mode === "short") {
        orders.push({
          levelIndex: i,
          price: lvl,
          side: "sell",
          reduceOnly: isReduceOnly("sell", p.mode),
        });
      }
    }
  }
  return orders;
}

/** 买成交 → 上邻挂卖；卖成交 → 下邻挂买 */
export function replacementFor(
  filled: { side: Side; levelIndex: number },
  levels: number[],
  mode: GridMode
): SeedOrder | null {
  if (filled.side === "buy") {
    const j = filled.levelIndex + 1;
    if (j > levels.length - 1) return null;
    return {
      levelIndex: j,
      price: levels[j]!,
      side: "sell",
      reduceOnly: isReduceOnly("sell", mode),
    };
  }
  const j = filled.levelIndex - 1;
  if (j < 0) return null;
  return {
    levelIndex: j,
    price: levels[j]!,
    side: "buy",
    reduceOnly: isReduceOnly("buy", mode),
  };
}

export function rungProfit(spacing: number, sizeBase: number): number {
  return spacing * sizeBase;
}

export type RiskSnapshot = {
  notional: number;
  requiredMargin: number;
  perRungProfit: number;
  spacingPct: number;
  maxAffordableNotional: number;
};

export function computeRisk(
  grid: BuiltGrid,
  params: Pick<GridParams, "sizeBase" | "leverage" | "equityUsd" | "marginFraction">,
  mid: number
): RiskSnapshot {
  const midUse = mid > 0 ? mid : 1;
  const notional = grid.count * params.sizeBase * midUse;
  const maxAffordableNotional =
    params.equityUsd * params.marginFraction * params.leverage;
  return {
    notional: round(notional),
    requiredMargin: round(notional / params.leverage),
    perRungProfit: round(rungProfit(grid.spacing, params.sizeBase)),
    spacingPct: round((grid.spacing / midUse) * 100),
    maxAffordableNotional: round(maxAffordableNotional),
  };
}

/** 格距 % 必须明显大于双边费率 % */
export function assertFeeOk(
  spacingPct: number,
  feeRate: number
): { ok: boolean; roundTripFeePct: number; message: string } {
  const roundTripFeePct = feeRate * 2 * 100;
  if (spacingPct <= roundTripFeePct) {
    return {
      ok: false,
      roundTripFeePct,
      message: `格距 ${spacingPct}% ≤ 往返手续费约 ${round(roundTripFeePct)}%，每格可能亏损`,
    };
  }
  return {
    ok: true,
    roundTripFeePct,
    message: `格距 ${spacingPct}% > 往返手续费约 ${round(roundTripFeePct)}%`,
  };
}

export function assertMarginOk(
  risk: RiskSnapshot,
  equityUsd: number,
  marginFraction: number
): { ok: boolean; message: string } {
  const budget = equityUsd * marginFraction;
  // 允许 0.05U 浮点误差
  if (risk.requiredMargin > budget + 0.05) {
    return {
      ok: false,
      message: `保证金约需 ${risk.requiredMargin}U > 预算 ${round(budget)}U（权益×占用比），请降 size/格数或提高杠杆`,
    };
  }
  if (risk.requiredMargin > budget * 0.8) {
    return {
      ok: true,
      message: `保证金占用偏高：${risk.requiredMargin}/${round(budget)}U（>80%）`,
    };
  }
  return {
    ok: true,
    message: `保证金约 ${risk.requiredMargin}U / 预算 ${round(budget)}U（名义 ${risk.notional}U）`,
  };
}

/** 用价位匹配活单到格线（±半格间距） */
export function matchLevelIndex(
  price: number,
  levels: number[],
  spacing: number
): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const d = Math.abs(levels[i]! - price);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  // 过宽会把「旧半幅/旧档距」残留单误认成当前格（Dec/N1 曾 73.8 与 80 混挂）
  if (bestDist > spacing * 0.1) return -1;
  return best;
}

export function seedToDesired(
  market: string,
  seeds: SeedOrder[],
  size: number
): DesiredOrder[] {
  return seeds.map((s) => ({
    market,
    side: s.side,
    price: s.price,
    size,
    level: s.levelIndex,
  }));
}

/**
 * 根据上一轮跟踪单 vs 本轮交易所挂单，推断成交并生成补单 intents。
 * 同时：缺档可按 seed 补（每 level 最多一单）。
 */
export function planFromFillsAndSeed(p: {
  market: string;
  mid: number;
  levels: number[];
  spacing: number;
  mode: GridMode;
  sizeBase: number;
  openOrders: LiveOrder[];
  prevActive: Map<string, { levelIndex: number; side: Side; price: number; size: number }>;
  maxWrites: number;
  seeded: boolean;
  /** 达限后不再 place（如 RISEx 50/市场） */
  maxOpenOrders?: number;
  skipBand?: number;
  /** When set, only orders carrying this prefix are owned/cancellable by this run. */
  ownershipPrefix?: string;
  anchorEpoch?: number;
}): {
  intents: Intent[];
  nextActive: Map<string, { levelIndex: number; side: Side; price: number; size: number }>;
  filled: Array<{ side: Side; levelIndex: number; price: number }>;
  completedRungs: number;
} {
  const nextActive = new Map<
    string,
    { levelIndex: number; side: Side; price: number; size: number }
  >();
  const occupied = new Set<number>();
  const intents: Intent[] = [];
  const orphanCancels: string[] = [];

  for (const o of p.openOrders) {
    const idx = matchLevelIndex(o.price, p.levels, p.spacing);
    const owned = !p.ownershipPrefix || String(o.clientOrderId || "").startsWith(p.ownershipPrefix);
    if (idx >= 0) occupied.add(idx);
    // Never cancel or claim manual/other-bot orders.
    if (!owned) continue;
    const expectedSize = Math.abs(Number(o.size) - p.sizeBase) <= Math.max(1e-10, p.sizeBase * 0.001);
    const expectedIdentity = !p.ownershipPrefix ||
      String(o.clientOrderId || "") === `${p.ownershipPrefix}${p.anchorEpoch ?? 0}-${o.side}-${idx}`;
    // Owned but malformed/duplicated orders are safe to cancel.
    if (idx < 0 || !expectedSize || !expectedIdentity || nextActiveHasLevel(nextActive, idx, o.side)) {
      orphanCancels.push(o.id);
      continue;
    }
    nextActive.set(o.id, {
      levelIndex: idx,
      side: o.side,
      price: o.price,
      size: o.size,
    });
  }

  for (const id of orphanCancels) {
    if (intents.length >= p.maxWrites) break;
    intents.push({ type: "cancel", orderId: id, market: p.market });
  }
  const cancelsPlanned = intents.length;

  // An absent open order is ambiguous (filled, cancelled, rejected, or stale read).
  // Exact fills must come from the venue fill feed/journal; never infer them here.
  const filled: Array<{ side: Side; levelIndex: number; price: number }> = [];

  let completedRungs = 0;
  let placeSlots =
    p.maxOpenOrders != null
      ? Math.max(0, p.maxOpenOrders - (p.openOrders.length - cancelsPlanned))
      : Number.POSITIVE_INFINITY;

  const pushPlace = (order: DesiredOrder): boolean => {
    if (placeSlots <= 0) return false;
    if (intents.length >= p.maxWrites) return false;
    const clientOrderId = p.ownershipPrefix
      ? `${p.ownershipPrefix}${p.anchorEpoch ?? 0}-${order.side}-${order.level}`
      : order.clientOrderId;
    intents.push({ type: "place", order: { ...order, clientOrderId } });
    placeSlots -= 1;
    return true;
  };

  for (const f of filled) {
    const repl = replacementFor(f, p.levels, p.mode);
    if (!repl) continue;
    completedRungs += 1;
    if (occupied.has(repl.levelIndex)) continue;
    if (
      !pushPlace({
        market: p.market,
        side: repl.side,
        price: repl.price,
        size: p.sizeBase,
        level: repl.levelIndex,
      })
    ) {
      break;
    }
    occupied.add(repl.levelIndex);
  }

  // 本轮已成交的档：禁止 seed 在同档挂反向（否则 mid 微穿会同价开平，只亏手续费）
  const filledLevelSide = new Map<number, Side>();
  for (const f of filled) filledLevelSide.set(f.levelIndex, f.side);

  // 每轮都补漏档（原先仅在「本轮无成交」时 seed，行情活跃时近价空洞会一直空着）
  {
    const seeds = seedOrders({
      levels: p.levels,
      price: p.mid,
      mode: p.mode,
      spacing: p.spacing,
      skipBand: p.skipBand,
    });
    for (const s of seeds) {
      if (occupied.has(s.levelIndex)) continue;
      const opened = filledLevelSide.get(s.levelIndex);
      if (opened && opened !== s.side) continue;
      if (
        !pushPlace({
          market: p.market,
          side: s.side,
          price: s.price,
          size: p.sizeBase,
          level: s.levelIndex,
        })
      ) {
        break;
      }
      occupied.add(s.levelIndex);
    }
  }

  return { intents, nextActive, filled, completedRungs };
}

function nextActiveHasLevel(
  active: Map<string, { levelIndex: number; side: Side }>,
  levelIndex: number,
  side: Side
): boolean {
  for (const row of active.values()) {
    if (row.levelIndex === levelIndex && row.side === side) return true;
  }
  return false;
}
