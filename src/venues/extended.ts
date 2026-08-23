import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Intent, VenueSnapshot } from "../types.js";
import {
  ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE,
  boundFlattenQty,
  classifyExposureReducingSide,
  normalizeReductionResult,
  reductionClientOrderId,
  type AuthoritativeReductionSnapshot,
  type ReductionRequest,
  type ReductionResult,
} from "../experimentReduction.js";
import { readExperimentLeverage } from "../config.js";
import { loadEnv } from "../loadEnv.js";
import { ExtendedAccountStream } from "./extendedAccountStream.js";
import {
  ExtendedObservationBarrier,
  type ExtendedObservationResult,
} from "./extendedObservation.js";
import {
  ExtendedStrictApi,
  type ExtendedStrictExchangeFacade,
} from "./extendedStrictApi.js";
import { dryApply, type ApplyResult, type VenueExecutor } from "./types.js";

type ExtendedExchange = ExtendedStrictExchangeFacade & {
  init(): Promise<boolean>;
  stop(): void;
  marketIdForName(name: string): number | null;
  getPrice(marketId: number): Promise<number>;
  getPosition(marketId: number): {
    sizeBase: number;
    entryPrice?: number;
    unrealizedPnl?: number;
    liquidationPrice?: number | null;
  } | null;
  getAllPositions?: () => Array<{
    marketId: number | null;
    market?: string;
    unrealizedPnl?: number;
    liquidationPrice?: number | null;
  }>;
  getAllOpenOrders(): Array<{
    orderId: string;
    externalId?: string;
    marketId: number | null;
    side: string;
    price: number;
    sizeBase: number;
  }>;
  _refreshAllPositions(): Promise<unknown>;
  _refreshAllOpenOrders(): Promise<unknown>;
  placeLimitOrder(o: {
    marketId: number;
    side: string;
    price: number;
    sizeBase: number;
    postOnly?: boolean;
    externalId?: string;
  }): Promise<{ orderId: string }>;
  cancelOrder(marketId: number, orderId: string): Promise<unknown>;
  cancelAll(marketId: number): Promise<unknown>;
  closePosition(
    marketId: number,
    sizeBase?: number | null,
    externalId?: string | null
  ): Promise<{
    requestedClientOrderId?: string | null;
    submittedExternalId?: string;
    exchangeId?: string;
    exchangeOrderId?: string;
    orderId?: string;
    externalId?: string;
  } | true>;
  setLeverage(marketId: number, leverage: number): Promise<unknown>;
  getLeverage(marketId: number): Promise<number | null>;
  confirmNoOpenOrders(marketId: number, opts?: { retries?: number; waitMs?: number }): Promise<unknown>;
};

function marketName(market: string): string {
  const m = market.toUpperCase();
  return m.includes("-") ? m : `${m}-USD`;
}

export function toAuthoritativeReductionSnapshot(
  result: Extract<ExtendedObservationResult, { ok: true }>,
  market: string
): AuthoritativeReductionSnapshot {
  const snap = result.snapshot;
  const generation = snap.generation;
  const normalizedMarket = marketName(market);
  const positions = snap.positions.filter((position) => position.market === normalizedMarket);
  const signedPosition = positions.reduce(
    (sum, position) => sum + Math.abs(position.size) * (position.side === "SHORT" ? -1 : 1),
    0
  );
  return {
    observedAt: generation.generatedAt,
    observationId: generation.observationId,
    sourceGeneration: generation.sourceGeneration,
    capturedAtMs: Date.parse(generation.generatedAt),
    positionQty: signedPosition,
    openOrders: snap.openOrders
      .filter((order) => order.market === normalizedMarket)
      .map((order) => ({
        id: order.externalId || order.id,
        market,
        side: order.side === "SELL" ? "sell" : "buy",
        price: order.price,
        size: Math.max(0, order.qty - order.filledQty),
        level: 0,
        clientOrderId: order.externalId,
      })),
    mid: snap.markPrice.markPrice,
    freshness: "fresh",
    leaseGeneration: String(generation.leaseGeneration),
  };
}

export class ExtendedExecutor implements VenueExecutor {
  readonly id = "extended" as const;
  readonly experimentCapabilities = {
    deterministicClientOrderId: true,
    leverageReadback: true,
  };
  private ex: ExtendedExchange | null = null;
  private accountStream: ExtendedAccountStream | null = null;
  private observation: ExtendedObservationBarrier | null = null;
  private leaseGeneration = 0;
  constructor(private dryRun: boolean) {}

  setLeaseGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("EXTENDED_INVALID_LEASE_GENERATION");
    }
    this.leaseGeneration = generation;
  }

  async connect(): Promise<void> {
    if (this.dryRun) return;
    loadEnv();
    if (
      ["1", "true", "yes"].includes(String(process.env.EXTENDED_USE_PROXY || "").toLowerCase()) &&
      process.env.EXTENDED_PROXY
    ) {
      console.log(`[extended] proxy ${process.env.EXTENDED_PROXY}`);
    }
    const apiKey = process.env.EXTENDED_API_KEY?.trim();
    const vault = Number(process.env.EXTENDED_VAULT || process.env.EXTENDED_VAULT_ID || 0);
    const starkPrivateKey = process.env.EXTENDED_STARK_PRIVATE_KEY?.trim();
    const starkPublicKey = process.env.EXTENDED_STARK_PUBLIC_KEY?.trim() || null;
    const apiUrl = (
      process.env.EXTENDED_API_URL || "https://api.starknet.extended.exchange"
    ).replace(/\/$/, "");
    if (!apiKey || !vault || !starkPrivateKey) {
      throw new Error("缺少 EXTENDED_API_KEY / EXTENDED_VAULT / EXTENDED_STARK_PRIVATE_KEY");
    }
    const vendor = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../vendor/extended/exchange/index.js"
    );
    const mod = await import(pathToFileURL(vendor).href);
    this.ex = mod.createExchange({
      apiKey,
      vault,
      starkPrivateKey,
      starkPublicKey,
      apiUrl,
    }) as ExtendedExchange;
    await this.ex.init();
    this.accountStream = new ExtendedAccountStream({ apiUrl, apiKey });
    await this.accountStream.connect();
    this.observation = new ExtendedObservationBarrier(
      new ExtendedStrictApi(this.ex),
      this.accountStream.state
    );
    if (process.env.GRID_SKIP_LEVERAGE !== "1") {
      const btcId = this.ex.marketIdForName("BTC-USD");
      if (btcId != null) {
        const target =
          readExperimentLeverage() ??
          Number(process.env.EXTENDED_LEVERAGE || process.env.GRID_LEVERAGE || 30);
        try {
          const current = await this.ex.getLeverage(btcId).catch(() => null);
          if (current == null || Math.abs(current - target) > 0.1) {
            await this.ex.setLeverage(btcId, target);
          }
        } catch (e: any) {
          console.warn(
            `[extended] setLeverage ${target}x skipped: ${String(e?.message || e).slice(0, 160)}`
          );
        }
      }
    }
  }

  disconnect(): void {
    this.accountStream?.stop();
    this.accountStream = null;
    this.observation = null;
    this.ex?.stop();
    this.ex = null;
  }

  private ensure(): ExtendedExchange {
    if (!this.ex) throw new Error("Extended 未 connect");
    return this.ex;
  }

  private marketId(market: string): number {
    const id = this.ensure().marketIdForName(marketName(market));
    if (id == null) throw new Error(`Extended 无市场 ${market}`);
    return id;
  }

  async strictSnapshot(market: string): Promise<ExtendedObservationResult> {
    if (this.dryRun) {
      throw new Error("EXTENDED_STRICT_SNAPSHOT_LIVE_ONLY");
    }
    if (!this.observation) throw new Error("EXTENDED_ACCOUNT_OBSERVATION_NOT_CONNECTED");
    return this.observation.observe({
      market: marketName(market),
      leaseGeneration: this.leaseGeneration,
    });
  }

  async snapshot(market: string): Promise<VenueSnapshot> {
    if (this.dryRun) {
      return { venue: this.id, market, mid: 100_000, position: 0, openOrders: [] };
    }
    const result = await this.strictSnapshot(market);
    if (!result.ok) {
      throw new Error(
        `EXTENDED_STRICT_SNAPSHOT_${result.reasonCode}:${result.failedSources.join(",")}`
      );
    }
    const strict = result.snapshot;
    const normalizedMarket = marketName(market);
    const positions = strict.positions.filter((position) => position.market === normalizedMarket);
    const signedPosition = positions.reduce(
      (sum, position) => sum + Math.abs(position.size) * (position.side === "SHORT" ? -1 : 1),
      0
    );
    const unrealizedPnl = positions.reduce(
      (sum, position) => sum + (position.unrealizedPnl ?? 0),
      0
    );
    const liquidationPrices = positions
      .map((position) => position.liquidationPrice)
      .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
    return {
      venue: this.id,
      market,
      mid: strict.markPrice.markPrice,
      position: signedPosition,
      openOrders: strict.openOrders
        .filter((order) => order.market === normalizedMarket)
        .map((order) => ({
          id: order.externalId || order.id,
          market,
          side: order.side === "SELL" ? "sell" : "buy",
          price: order.price,
          size: Math.max(0, order.qty - order.filledQty),
          level: 0,
          clientOrderId: order.externalId,
        })),
      observedAt: strict.generation.generatedAt,
      equityUsd: strict.balance.equity,
      unrealizedPnl,
      liquidationPrice: liquidationPrices[0],
    };
  }

  async apply(intents: Intent[]): Promise<ApplyResult> {
    if (this.dryRun) return dryApply(this.id, intents);
    const result: ApplyResult = { placed: 0, cancelled: 0, failed: 0, errors: [] };
    const ex = this.ensure();
    // Extended 下单 API 易 429：笔与笔之间强制间隔（默认 400ms，可用 EXTENDED_ORDER_GAP_MS 覆盖）
    const gapMs = Math.max(
      0,
      Number(process.env.EXTENDED_ORDER_GAP_MS || 400) || 400
    );
    let wrote = 0;
    for (const intent of intents) {
      try {
        if (intent.type === "cancel") {
          await ex.cancelOrder(this.marketId(intent.market), intent.orderId);
          result.cancelled += 1;
        } else {
          if (wrote > 0 && gapMs > 0) {
            await new Promise((r) => setTimeout(r, gapMs));
          }
          await ex.placeLimitOrder({
            marketId: this.marketId(intent.order.market),
            side: intent.order.side,
            price: intent.order.price,
            sizeBase: intent.order.size,
            postOnly: true,
            externalId: intent.order.clientOrderId,
          });
          result.placed += 1;
          wrote += 1;
        }
      } catch (e: any) {
        const msg = String(e?.message || e);
        // 限流：本轮剩余 place 先停，留给下个 tick（vendor 内部已做过若干次退避重试）
        if (/429|限流/i.test(msg)) {
          result.failed += 1;
          result.errors.push(msg.slice(0, 200));
          break;
        }
        result.failed += 1;
        result.errors.push(msg.slice(0, 200));
      }
    }
    return result;
  }

  async cancelAll(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[extended:dry] cancelAll ${market}`);
      return;
    }
    const ex = this.ensure();
    const marketId = this.marketId(market);
    await ex.cancelAll(marketId);
    await ex.confirmNoOpenOrders(marketId, { retries: 8, waitMs: 750 });
  }

  async closePosition(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[extended:dry] closePosition ${market}`);
      return;
    }
    const ex = this.ensure();
    await ex.closePosition(this.marketId(market));
  }

  async authoritativeReductionSnapshot(p: {
    market: string;
    mutationAttemptAtMs: number;
    leaseGeneration: string;
  }): Promise<AuthoritativeReductionSnapshot> {
    const result = await this.strictSnapshot(p.market);
    if (!result.ok) {
      throw new Error(
        `EXTENDED_STRICT_SNAPSHOT_${result.reasonCode}:${result.failedSources.join(",")}`
      );
    }
    return toAuthoritativeReductionSnapshot(result, p.market);
  }

  /**
   * Sized reduce-only close. Vendor `closePosition(marketId, sizeBase)` is not treated
   * as an idempotent full-close: quantity, side, lease, and attempt identity are enforced.
   */
  async reduceExposure(request: ReductionRequest & { side: "buy" | "sell"; qty: number }): Promise<ReductionResult> {
    const expectedClientOrderId = reductionClientOrderId(request.incidentId, request.attempt);
    const requestedClientOrderId = request.clientOrderId;
    const identity = (reasonCode: string, outcome: ReductionResult["outcome"] = "NOT_SENT"): ReductionResult => ({
      outcome,
      reasonCode,
      requestedClientOrderId: requestedClientOrderId || expectedClientOrderId,
      clientOrderId: requestedClientOrderId || expectedClientOrderId,
    });
    if (!requestedClientOrderId) {
      return identity("MISSING_CLIENT_ORDER_ID");
    }
    if (requestedClientOrderId !== expectedClientOrderId) {
      return identity("CLIENT_ORDER_ID_MISMATCH");
    }
    if (request.leaseGeneration !== String(this.leaseGeneration)) {
      return identity("STALE_LEASE_GENERATION");
    }
    if (request.targetAbsPositionQty !== 0) {
      return identity("UNSUPPORTED_PARTIAL_REDUCTION");
    }
    if (!Number.isFinite(request.positionQty)) {
      return identity("MISSING_POSITION_QTY");
    }
    const reducing = classifyExposureReducingSide(request.positionQty);
    if (reducing !== request.side) {
      return identity("EXPOSURE_INCREASING_SIDE");
    }
    const maxQty = Math.abs(request.positionQty);
    if (!(request.qty > 0) || request.qty > maxQty + ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE) {
      return identity("QTY_EXCEEDS_POSITION");
    }
    const qty = boundFlattenQty(request.positionQty, request.qty);
    if (!(qty > 0) || qty > maxQty) {
      return identity("EXPOSURE_INCREASING_QTY");
    }
    if (this.dryRun) {
      return identity("DRY_RUN_NO_TRANSPORT");
    }
    try {
      const receipt = await this.ensure().closePosition(
        this.marketId(request.market),
        qty,
        requestedClientOrderId
      );
      const submittedExternalId = receipt && typeof receipt === "object"
        ? String(receipt.submittedExternalId || receipt.externalId || "")
        : "";
      const exchangeOrderId = receipt && typeof receipt === "object"
        ? String(receipt.exchangeId || receipt.exchangeOrderId || "")
        : "";
      return normalizeReductionResult(request, {
        outcome: "ACK",
        requestedClientOrderId,
        submittedExternalId: submittedExternalId || undefined,
        clientOrderId: requestedClientOrderId,
        exchangeOrderId: exchangeOrderId || undefined,
      });
    } catch (error) {
      return normalizeReductionResult(request, error);
    }
  }

  async verifyExperimentPreflight(market: string, leverage: number): Promise<void> {
    if (this.dryRun) return;
    const current = await this.ensure().getLeverage(this.marketId(market));
    if (current == null || Math.abs(current - leverage) > 0.1) {
      throw new Error(`Extended leverage readback ${current ?? "missing"} != ${leverage}`);
    }
  }
}
