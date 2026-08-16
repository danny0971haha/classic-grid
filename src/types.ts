export type VenueId =
  | "extended"
  | "risex"
  | "decibel"
  | "n1"
  | "phoenix"
  | "phoenix2"
  | "nado"
  | "popdex";
export type Side = "buy" | "sell";
export type GridMode = "neutral" | "long" | "short";

export type GridParams = {
  /** 锚点后填入：mid − halfBand */
  lower: number;
  /** 锚点后填入：mid + halfBand */
  upper: number;
  /** 半幅（USD），默认 3000 → 总宽 6000 */
  halfBand: number;
  /** 实验模式：以锚点百分比计算半幅（例如 0.03 = ±3%） */
  halfBandPct?: number;
  /** 格子数（价格线 = gridCount+1）；上下各 gridCount/2 */
  gridCount: number;
  sizeBase: number;
  leverage: number;
  /** 单边费率（maker），用于间距校验 */
  feeRate: number;
  /** 账户权益估算（保证金预检）；实盘以后可用真实 equity 覆盖 */
  equityUsd: number;
  /** 用权益的多少做保证金预算 */
  marginFraction: number;
  maxWritesPerTick: number;
  mode: GridMode;
  /** 近现价跳过带宽 = skipBand * spacing */
  skipBand: number;
  /** 单市场挂单上限（如 RISEx 50）；达限后本轮不再 place */
  maxOpenOrders?: number;
};

export type SeedOrder = {
  levelIndex: number;
  price: number;
  side: Side;
  reduceOnly: boolean;
};

export type DesiredOrder = {
  market: string;
  side: Side;
  price: number;
  size: number;
  level: number;
  /** Deterministic ownership key used for crash reconciliation. */
  clientOrderId?: string;
};

export type LiveOrder = DesiredOrder & {
  id: string;
  clientOrderId?: string;
  exchangeOrderId?: string;
  status?: string;
  filledSize?: number;
};

export type VenueSnapshot = {
  venue: VenueId;
  market: string;
  mid: number;
  position: number;
  openOrders: LiveOrder[];
  /** 官方未实现盈亏（所方字段/均价×标记）；读不到则省略，看板显示 - */
  unrealizedPnl?: number;
  /** 账户权益（USD）；读不到则为 undefined */
  equityUsd?: number;
  /** 官方爆仓价；读不到则省略 */
  liquidationPrice?: number;
  /** Snapshot completion time for freshness checks. */
  observedAt?: string;
};

export type Intent =
  | { type: "place"; order: DesiredOrder }
  | { type: "cancel"; orderId: string; market: string };

export type ApplyResult = {
  placed: number;
  cancelled: number;
  failed: number;
  errors: string[];
  /** True when submit may have reached the venue but acknowledgement is unknown. */
  ambiguous?: boolean;
};

export type ActiveOrder = {
  id: string;
  levelIndex: number;
  side: Side;
  price: number;
  size: number;
};
