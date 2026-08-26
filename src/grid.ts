import type {
  DesiredOrder,
  GridMode,
  GridParams,
  Intent,
  LiveOrder,
  PlannerDiagnostic,
  PlannerDisposition,
  PlannerLogicalSlot,
  PlannerOrderClass,
  PlannerReplacementObligation,
  SeedOrder,
  Side,
} from "./types.js";

/** Price may match a level when |price - level| <= spacing * this fraction. */
export const PLANNER_PRICE_TOLERANCE_SPACING_FRAC = 0.1;
/** Size may match when |size - sizeBase| <= max(min, |sizeBase| * frac). */
export const PLANNER_SIZE_TOLERANCE_FRAC = 0.001;
export const PLANNER_SIZE_TOLERANCE_MIN = 1e-10;

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
  if (bestDist > spacing * PLANNER_PRICE_TOLERANCE_SPACING_FRAC) return -1;
  return best;
}

export function plannerSizeTolerance(sizeBase: number): number {
  if (typeof sizeBase !== "number" || !Number.isFinite(sizeBase)) {
    return PLANNER_SIZE_TOLERANCE_MIN;
  }
  return Math.max(PLANNER_SIZE_TOLERANCE_MIN, Math.abs(sizeBase) * PLANNER_SIZE_TOLERANCE_FRAC);
}

/** Locale-independent opaque-string compare. Uses charCodeAt, never numeric ID coercion. */
export function compareOpaqueString(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** Trimmed string IDs only. Non-strings become empty and fail closed. */
export function normalizeOpaqueId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function expectedOwnedClientOrderId(
  ownershipPrefix: string,
  anchorEpoch: number,
  side: Side,
  levelIndex: number
): string {
  return `${ownershipPrefix}${anchorEpoch}-${side}-${levelIndex}`;
}

export function plannerSlotKey(slot: PlannerLogicalSlot): string {
  const base = `${slot.market}\u001f${slot.anchorEpoch}\u001f${slot.side}\u001f${slot.levelIndex}`;
  return slot.replacementToken ? `${base}\u001f${slot.replacementToken}` : base;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isSide(value: unknown): value is Side {
  return value === "buy" || value === "sell";
}

function sideToken(value: unknown): string {
  return isSide(value) ? value : "";
}

function compareOptionalFinite(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Survivor / cancel comparator. Independent of input-array order.
 *
 * 1. normalized exchangeOrderId
 * 2. normalized order.id
 * 3. normalized clientOrderId
 * 4. market, side, price, size
 */
export function comparePlannerOrders(a: LiveOrder, b: LiveOrder): number {
  const ex = compareOpaqueString(
    normalizeOpaqueId(a.exchangeOrderId),
    normalizeOpaqueId(b.exchangeOrderId)
  );
  if (ex !== 0) return ex;
  const id = compareOpaqueString(normalizeOpaqueId(a.id), normalizeOpaqueId(b.id));
  if (id !== 0) return id;
  const cid = compareOpaqueString(
    normalizeOpaqueId(a.clientOrderId),
    normalizeOpaqueId(b.clientOrderId)
  );
  if (cid !== 0) return cid;
  const market = compareOpaqueString(normalizeOpaqueId(a.market), normalizeOpaqueId(b.market));
  if (market !== 0) return market;
  const side = compareOpaqueString(sideToken(a.side), sideToken(b.side));
  if (side !== 0) return side;
  const price = compareOptionalFinite(finiteNumber(a.price), finiteNumber(b.price));
  if (price !== 0) return price;
  return compareOptionalFinite(finiteNumber(a.size), finiteNumber(b.size));
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

type PlannerObservation = {
  order: LiveOrder;
  localId: string;
  exchangeOrderId: string;
  clientOrderId: string;
  market: string;
  side: Side | "";
  price: number | null;
  size: number | null;
};

type ClassifiedOrder = {
  obs: PlannerObservation;
  class: PlannerOrderClass;
  slot: PlannerLogicalSlot | null;
  matchedLevel: number;
  cancelId: string;
};

type ParsedOwnedIdentity = {
  epoch: number;
  side: Side;
  levelIndex: number;
  replacementToken: string | null;
};

/**
 * Repair missing grid levels from an authoritative open-order snapshot.
 * Never infers FILL from disappearance. Duplicate selection is deterministic.
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
  replacementObligations?: PlannerReplacementObligation[];
  replacementSizes?: Record<string, number>;
  forceCancelOnly?: boolean;
  authoritativeFilled?: Array<{ side: Side; levelIndex: number; price: number }>;
  authoritativeCompletedRungs?: number;
}): {
  intents: Intent[];
  nextActive: Map<string, { levelIndex: number; side: Side; price: number; size: number }>;
  filled: Array<{ side: Side; levelIndex: number; price: number }>;
  completedRungs: number;
  diagnostics: PlannerDiagnostic[];
  currentSnapshotVenueCount: number;
  plannedCancelCount: number;
  capacityAfterAuthoritativeSnapshot: number | null;
  plannerDisposition: PlannerDisposition;
  riskIncreaseBlocked: boolean;
} {
  const prefix = typeof p.ownershipPrefix === "string" ? p.ownershipPrefix : "";
  const currentEpoch =
    typeof p.anchorEpoch === "number" && Number.isSafeInteger(p.anchorEpoch) ? p.anchorEpoch : 0;
  const sizeTol = plannerSizeTolerance(p.sizeBase);
  const replacementSizes = p.replacementSizes ?? {};
  const diagnostics: PlannerDiagnostic[] = [];
  const blockedLevels = new Set<number>();
  const blockedSlots = new Set<string>();
  const blockedSeedLevels = new Set<number>();

  const collapsed = collapseObservations(p.openOrders.map(toObservation), diagnostics, (obs) => {
    blockInferredSlots(obs, p, prefix, currentEpoch, blockedLevels, blockedSlots);
  });
  const observations = collapsed.observations;

  const classified: ClassifiedOrder[] = [];
  for (const obs of observations) {
    classified.push(classifyObservation(obs, p, prefix, currentEpoch, sizeTol, replacementSizes));
  }

  for (const row of classified) {
    blockClassified(row, p, prefix, currentEpoch, blockedLevels, blockedSlots);
    if (row.class === "UNOWNED") {
      diagnostics.push(diagnostic("UNOWNED_BLOCKS_SLOT", row));
    } else if (row.class === "CROSS_MARKET_OWNED") {
      diagnostics.push(diagnostic("CROSS_MARKET_OWNED_ORDER", row));
    } else if (row.class === "AMBIGUOUS") {
      diagnostics.push(
        diagnostic(row.cancelId ? "AMBIGUOUS_ORDER" : "MISSING_CANCEL_IDENTITY", row)
      );
    } else if (row.class === "MALFORMED_OWNED") {
      diagnostics.push(
        diagnostic(row.cancelId ? "MALFORMED_OWNED" : "MISSING_CANCEL_IDENTITY", row)
      );
    } else if (row.class === "STALE_EPOCH_OWNED") {
      diagnostics.push(
        diagnostic(row.cancelId ? "STALE_EPOCH_OWNED" : "MISSING_CANCEL_IDENTITY", row)
      );
    }
  }

  const validsBySlot = new Map<string, ClassifiedOrder[]>();
  for (const row of classified) {
    if (row.class !== "VALID_OWNED_CURRENT" || !row.slot) continue;
    const key = plannerSlotKey(row.slot);
    const list = validsBySlot.get(key) ?? [];
    list.push(row);
    validsBySlot.set(key, list);
  }

  const survivors: ClassifiedOrder[] = [];
  const cancelCandidates: ClassifiedOrder[] = [];
  for (const list of validsBySlot.values()) {
    list.sort((a, b) => comparePlannerOrders(a.obs.order, b.obs.order));
    survivors.push(list[0]!);
    for (let i = 1; i < list.length; i++) {
      const dup = list[i]!;
      cancelCandidates.push(dup);
      diagnostics.push(diagnostic("DUPLICATE_OWNED_CANCELLED", dup));
    }
  }
  for (const row of classified) {
    if (row.class !== "MALFORMED_OWNED" && row.class !== "STALE_EPOCH_OWNED") continue;
    if (!row.cancelId) continue;
    cancelCandidates.push(row);
  }

  cancelCandidates.sort((a, b) => comparePlannerOrders(a.obs.order, b.obs.order));
  const seenCancel = new Set<string>();
  const uniqueCancels: ClassifiedOrder[] = [];
  for (const row of cancelCandidates) {
    if (!row.cancelId || seenCancel.has(row.cancelId)) continue;
    seenCancel.add(row.cancelId);
    uniqueCancels.push(row);
  }

  const intents: Intent[] = [];
  for (const row of uniqueCancels) {
    if (intents.length >= p.maxWrites) break;
    intents.push({ type: "cancel", orderId: row.cancelId, market: p.market });
  }

  const currentSnapshotVenueCount = collapsed.unresolvedVenueCount + observations.length;
  const plannedCancelCount = intents.length;
  const capacityAfterAuthoritativeSnapshot =
    p.maxOpenOrders != null ? Math.max(0, p.maxOpenOrders - currentSnapshotVenueCount) : null;
  const obligations = p.replacementObligations ?? [];
  const unownedBlocksReplacement = classified.some((row) => {
    if (row.class !== "UNOWNED") return false;
    return obligations.some((obl) => {
      if (obl.lifecycle !== "READY") return false;
      if (row.slot && row.slot.side === obl.targetSide && row.slot.levelIndex === obl.targetLevelIndex) {
        return true;
      }
      return row.matchedLevel === obl.targetLevelIndex;
    });
  });
  const riskIncreaseBlocked = Boolean(p.forceCancelOnly) || unownedBlocksReplacement || plannerRiskIncreaseBlocked(
    classified,
    collapsed.unresolvedVenueCount,
    p,
    prefix,
    currentEpoch
  );
  const plannerDisposition: PlannerDisposition = p.forceCancelOnly || unownedBlocksReplacement
    ? (p.forceCancelOnly ? "CANCEL_ONLY_RECONCILIATION" : "RISK_INCREASE_BLOCKED")
    : riskIncreaseBlocked
      ? "RISK_INCREASE_BLOCKED"
      : "CLEAR";
  let placeSlots =
    riskIncreaseBlocked || plannerDisposition !== "CLEAR"
      ? 0
      : capacityAfterAuthoritativeSnapshot == null
        ? Number.POSITIVE_INFINITY
        : capacityAfterAuthoritativeSnapshot;

  survivors.sort((a, b) => compareSlot(a.slot!, b.slot!));
  const nextActive = new Map<
    string,
    { levelIndex: number; side: Side; price: number; size: number }
  >();
  for (const row of survivors) {
    nextActive.set(row.cancelId, {
      levelIndex: row.slot!.levelIndex,
      side: row.slot!.side,
      price: row.obs.order.price,
      size: row.obs.order.size,
    });
  }

  // Disappearance is not a fill. Authoritative FILL comes only from the execution journal.
  const filled = p.authoritativeFilled ? p.authoritativeFilled.slice() : [];
  const completedRungs = typeof p.authoritativeCompletedRungs === "number" && Number.isFinite(p.authoritativeCompletedRungs)
    ? p.authoritativeCompletedRungs
    : 0;

  const pushPlace = (order: DesiredOrder, replacementToken?: string): boolean => {
    if (blockedLevels.has(order.level)) return false;
    const slot: PlannerLogicalSlot = {
      market: p.market,
      anchorEpoch: currentEpoch,
      side: order.side,
      levelIndex: order.level,
      ...(replacementToken ? { replacementToken } : {}),
    };
    if (blockedSlots.has(plannerSlotKey(slot))) return false;
    if (!replacementToken && blockedSeedLevels.has(order.level)) return false;
    if (placeSlots <= 0) return false;
    if (intents.length >= p.maxWrites) return false;
    const clientOrderId = order.clientOrderId
      ? order.clientOrderId
      : prefix
        ? expectedOwnedClientOrderId(prefix, currentEpoch, order.side, order.level)
        : order.clientOrderId;
    intents.push({ type: "place", order: { ...order, clientOrderId } });
    placeSlots -= 1;
    if (replacementToken) {
      blockedSeedLevels.add(order.level);
      blockedSlots.add(plannerSlotKey(slot));
    } else {
      blockedLevels.add(order.level);
      blockedSlots.add(plannerSlotKey(slot));
    }
    return true;
  };

  const qtyClose = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-8;
  for (const obl of obligations) {
    if (obl.lifecycle !== "READY") continue;
    const targetPrice = p.levels[obl.targetLevelIndex];
    if (targetPrice == null) continue;
    const exact = survivors.some((row) => {
      if (row.slot?.side !== obl.targetSide || row.slot.levelIndex !== obl.targetLevelIndex) return false;
      if (!qtyClose(row.obs.order.size, obl.outstandingQuantity) && !qtyClose(row.obs.order.size, obl.placementQuantity)) {
        return false;
      }
      const cid = row.obs.clientOrderId;
      return cid === obl.replacementClientOrderId || !row.slot.replacementToken;
    });
    if (exact) continue;
    const parsed = prefix ? parseOwnedIdentity(obl.replacementClientOrderId, prefix) : null;
    pushPlace({
      market: p.market,
      side: obl.targetSide,
      price: targetPrice,
      size: obl.outstandingQuantity,
      level: obl.targetLevelIndex,
      clientOrderId: obl.replacementClientOrderId,
    }, parsed?.replacementToken || obl.obligationId);
  }

  const seeds = seedOrders({
    levels: p.levels,
    price: p.mid,
    mode: p.mode,
    spacing: p.spacing,
    skipBand: p.skipBand,
  });
  for (const s of seeds) {
    const placed = pushPlace({
      market: p.market,
      side: s.side,
      price: s.price,
      size: p.sizeBase,
      level: s.levelIndex,
    });
    if (!placed && (intents.length >= p.maxWrites || placeSlots <= 0)) break;
  }

  diagnostics.sort(compareDiagnostic);
  return {
    intents,
    nextActive,
    filled,
    completedRungs,
    diagnostics,
    currentSnapshotVenueCount,
    plannedCancelCount,
    capacityAfterAuthoritativeSnapshot,
    plannerDisposition,
    riskIncreaseBlocked,
  };
}

export function applyPlannerIntentGate<T extends {
  intents: Intent[];
  plannerDisposition: PlannerDisposition;
}>(plan: T): T {
  if (plan.plannerDisposition === "CLEAR") return plan;
  return {
    ...plan,
    intents: plan.intents.filter((intent) => intent.type === "cancel"),
  };
}

function observationMayBelongToMarket(obs: PlannerObservation, market: string): boolean {
  return obs.market === "" || obs.market === market;
}

function plannerRiskIncreaseBlocked(
  classified: ClassifiedOrder[],
  unresolvedVenueCount: number,
  p: { market: string; levels: number[]; spacing: number },
  prefix: string,
  currentEpoch: number
): boolean {
  if (unresolvedVenueCount > 0) return true;
  for (const row of classified) {
    if (row.class === "AMBIGUOUS" || row.class === "CROSS_MARKET_OWNED") return true;
    const locatable = inferSlots(row.obs, p, prefix, currentEpoch).length > 0;
    if (row.class === "MALFORMED_OWNED" && !locatable) return true;
    if (row.class === "STALE_EPOCH_OWNED" && !locatable) return true;
    if (
      row.class === "UNOWNED" &&
      !locatable &&
      observationMayBelongToMarket(row.obs, p.market)
    ) {
      return true;
    }
  }
  return false;
}

function compareSlot(a: PlannerLogicalSlot, b: PlannerLogicalSlot): number {
  const market = compareOpaqueString(a.market, b.market);
  if (market !== 0) return market;
  if (a.anchorEpoch !== b.anchorEpoch) return a.anchorEpoch < b.anchorEpoch ? -1 : 1;
  const side = compareOpaqueString(a.side, b.side);
  if (side !== 0) return side;
  if (a.levelIndex !== b.levelIndex) return a.levelIndex < b.levelIndex ? -1 : 1;
  return compareOpaqueString(a.replacementToken ?? "", b.replacementToken ?? "");
}

function parseDecimalUint(digits: string): number | null {
  if (!digits || digits.length > 15) return null;
  let n = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return null;
    n = n * 10 + d;
  }
  return Number.isSafeInteger(n) ? n : null;
}

function parseOwnedIdentity(
  clientOrderId: string,
  prefix: string
): ParsedOwnedIdentity | null {
  if (!prefix || !clientOrderId.startsWith(prefix)) return null;
  const rest = clientOrderId.slice(prefix.length);
  const match = /^(\d{1,15})-(buy|sell)-(\d{1,15})(?:-r-([a-f0-9]{16}))?$/.exec(rest);
  if (!match) return null;
  const epoch = parseDecimalUint(match[1]!);
  const levelIndex = parseDecimalUint(match[3]!);
  if (epoch === null || levelIndex === null || !isSide(match[2])) return null;
  return {
    epoch,
    side: match[2],
    levelIndex,
    replacementToken: match[4] ?? null,
  };
}

export function parseOwnedClientOrderId(
  clientOrderId: string,
  prefix: string
): ParsedOwnedIdentity | null {
  return parseOwnedIdentity(clientOrderId, prefix);
}

function toObservation(order: LiveOrder): PlannerObservation {
  return {
    order,
    localId: normalizeOpaqueId(order.id),
    exchangeOrderId: normalizeOpaqueId(order.exchangeOrderId),
    clientOrderId: normalizeOpaqueId(order.clientOrderId),
    market: normalizeOpaqueId(order.market),
    side: isSide(order.side) ? order.side : "",
    price: finiteNumber(order.price),
    size: finiteNumber(order.size),
  };
}

function sameObservationFields(a: PlannerObservation, b: PlannerObservation): boolean {
  return (
    a.localId === b.localId &&
    a.exchangeOrderId === b.exchangeOrderId &&
    a.clientOrderId === b.clientOrderId &&
    a.market === b.market &&
    a.side === b.side &&
    Object.is(a.price, b.price) &&
    Object.is(a.size, b.size)
  );
}

function identityKeys(obs: PlannerObservation): string[] {
  const keys: string[] = [];
  if (obs.localId) keys.push(`id:${obs.localId}`);
  if (obs.exchangeOrderId) keys.push(`ex:${obs.exchangeOrderId}`);
  return keys;
}

function collapseObservations(
  rows: PlannerObservation[],
  diagnostics: PlannerDiagnostic[],
  onConflict: (obs: PlannerObservation) => void
): { observations: PlannerObservation[]; unresolvedVenueCount: number } {
  const n = rows.length;
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    let x = i;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!];
      x = parent[x]!;
    }
    return x;
  };
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[a] = b;
  };
  const keyToIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    for (const key of identityKeys(rows[i]!)) {
      const prev = keyToIndex.get(key);
      if (prev !== undefined) union(prev, i);
      else keyToIndex.set(key, i);
    }
  }
  const buckets = new Map<number, PlannerObservation[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = buckets.get(root) ?? [];
    list.push(rows[i]!);
    buckets.set(root, list);
  }
  const out: PlannerObservation[] = [];
  let unresolvedVenueCount = 0;
  for (const group of buckets.values()) {
    const allSame = group.every((row) => sameObservationFields(row, group[0]!));
    if (allSame) {
      out.push(group[0]!);
      continue;
    }
    unresolvedVenueCount += 1;
    for (const obs of group) {
      onConflict(obs);
      diagnostics.push({
        code: "RECONCILIATION_REQUIRED",
        class: "AMBIGUOUS",
        orderId: obs.localId || undefined,
        exchangeOrderId: obs.exchangeOrderId || undefined,
        clientOrderId: obs.clientOrderId || undefined,
      });
    }
  }
  return { observations: out, unresolvedVenueCount };
}

function classifyObservation(
  obs: PlannerObservation,
  p: {
    market: string;
    levels: number[];
    spacing: number;
    sizeBase: number;
  },
  prefix: string,
  currentEpoch: number,
  sizeTol: number,
  replacementSizes: Record<string, number>
): ClassifiedOrder {
  const matchedLevel =
    obs.price !== null ? matchLevelIndex(obs.price, p.levels, p.spacing) : -1;
  const parsed = prefix ? parseOwnedIdentity(obs.clientOrderId, prefix) : null;
  const owned = !prefix || (obs.clientOrderId !== "" && obs.clientOrderId.startsWith(prefix));
  const marketOk = obs.market === p.market;
  const side = isSide(obs.side) ? obs.side : null;
  const replacementQty = parsed?.replacementToken ? replacementSizes[obs.clientOrderId] : undefined;
  const sizeOk = parsed?.replacementToken
    ? obs.size !== null && replacementQty != null && Math.abs(obs.size - replacementQty) <= 1e-8
    : obs.size !== null && Math.abs(obs.size - p.sizeBase) <= sizeTol;
  const priceOk = matchedLevel >= 0;
  const slot: PlannerLogicalSlot | null =
    priceOk && side
      ? {
          market: p.market,
          anchorEpoch: currentEpoch,
          side,
          levelIndex: matchedLevel,
          ...(parsed?.replacementToken ? { replacementToken: parsed.replacementToken } : {}),
        }
      : null;

  if (prefix && !owned) {
    return {
      obs,
      class: "UNOWNED",
      slot,
      matchedLevel,
      cancelId: "",
    };
  }

  if (prefix && owned && obs.market !== p.market) {
    if (obs.market !== "") {
      return {
        obs,
        class: "CROSS_MARKET_OWNED",
        slot: null,
        matchedLevel: -1,
        cancelId: "",
      };
    }
    return {
      obs,
      class: "AMBIGUOUS",
      slot: null,
      matchedLevel: -1,
      cancelId: "",
    };
  }

  if (!obs.localId || !side || obs.price === null || obs.size === null) {
    return {
      obs,
      class: owned && prefix && obs.localId ? "MALFORMED_OWNED" : "AMBIGUOUS",
      slot,
      matchedLevel,
      cancelId: obs.localId,
    };
  }

  if (prefix && parsed && parsed.epoch !== currentEpoch) {
    return {
      obs,
      class: "STALE_EPOCH_OWNED",
      slot,
      matchedLevel,
      cancelId: obs.localId,
    };
  }

  const expected = parsed?.replacementToken
    ? obs.clientOrderId
    : side && priceOk
      ? expectedOwnedClientOrderId(prefix, currentEpoch, side, matchedLevel)
      : "";
  const identityOk = !prefix || (expected !== "" && obs.clientOrderId === expected);
  const replacementLevelOk = !parsed?.replacementToken || matchedLevel === parsed.levelIndex;
  if (marketOk && side && priceOk && sizeOk && identityOk && replacementLevelOk) {
    return {
      obs,
      class: "VALID_OWNED_CURRENT",
      slot,
      matchedLevel,
      cancelId: obs.localId,
    };
  }

  return {
    obs,
    class: "MALFORMED_OWNED",
    slot,
    matchedLevel,
    cancelId: obs.localId,
  };
}

function inferSlots(
  obs: PlannerObservation,
  p: { market: string; levels: number[]; spacing: number },
  prefix: string,
  currentEpoch: number
): PlannerLogicalSlot[] {
  const slots: PlannerLogicalSlot[] = [];
  const seen = new Set<string>();
  const add = (slot: PlannerLogicalSlot) => {
    const key = plannerSlotKey(slot);
    if (seen.has(key)) return;
    seen.add(key);
    slots.push(slot);
  };
  const matchedLevel =
    obs.price !== null ? matchLevelIndex(obs.price, p.levels, p.spacing) : -1;
  if (matchedLevel >= 0) {
    if (obs.side === "buy" || obs.side === "sell") {
      add({
        market: p.market,
        anchorEpoch: currentEpoch,
        side: obs.side,
        levelIndex: matchedLevel,
      });
    } else {
      add({ market: p.market, anchorEpoch: currentEpoch, side: "buy", levelIndex: matchedLevel });
      add({ market: p.market, anchorEpoch: currentEpoch, side: "sell", levelIndex: matchedLevel });
    }
  }
  const parsed = prefix ? parseOwnedIdentity(obs.clientOrderId, prefix) : null;
  if (parsed) {
    add({
      market: p.market,
      anchorEpoch: currentEpoch,
      side: parsed.side,
      levelIndex: parsed.levelIndex,
    });
  }
  return slots;
}

function blockInferredSlots(
  obs: PlannerObservation,
  p: { market: string; levels: number[]; spacing: number },
  prefix: string,
  currentEpoch: number,
  blockedLevels: Set<number>,
  blockedSlots: Set<string>
): void {
  for (const slot of inferSlots(obs, p, prefix, currentEpoch)) {
    blockedSlots.add(plannerSlotKey(slot));
    blockedLevels.add(slot.levelIndex);
  }
}

function blockClassified(
  row: ClassifiedOrder,
  p: { market: string; levels: number[]; spacing: number },
  prefix: string,
  currentEpoch: number,
  blockedLevels: Set<number>,
  blockedSlots: Set<string>
): void {
  if (row.class === "CROSS_MARKET_OWNED") return;
  blockInferredSlots(row.obs, p, prefix, currentEpoch, blockedLevels, blockedSlots);
  if (row.matchedLevel >= 0) blockedLevels.add(row.matchedLevel);
  if (row.slot) blockedSlots.add(plannerSlotKey(row.slot));
}

function diagnostic(code: PlannerDiagnostic["code"], row: ClassifiedOrder): PlannerDiagnostic {
  return {
    code,
    class: row.class,
    ...(row.slot ? { slot: row.slot } : {}),
    ...(row.obs.localId ? { orderId: row.obs.localId } : {}),
    ...(row.obs.exchangeOrderId ? { exchangeOrderId: row.obs.exchangeOrderId } : {}),
    ...(row.obs.clientOrderId ? { clientOrderId: row.obs.clientOrderId } : {}),
  };
}

function compareDiagnostic(a: PlannerDiagnostic, b: PlannerDiagnostic): number {
  const code = compareOpaqueString(a.code, b.code);
  if (code !== 0) return code;
  const cls = compareOpaqueString(a.class, b.class);
  if (cls !== 0) return cls;
  const slot = compareOpaqueString(
    a.slot ? plannerSlotKey(a.slot) : "",
    b.slot ? plannerSlotKey(b.slot) : ""
  );
  if (slot !== 0) return slot;
  const id = compareOpaqueString(a.orderId ?? "", b.orderId ?? "");
  if (id !== 0) return id;
  const ex = compareOpaqueString(a.exchangeOrderId ?? "", b.exchangeOrderId ?? "");
  if (ex !== 0) return ex;
  return compareOpaqueString(a.clientOrderId ?? "", b.clientOrderId ?? "");
}
