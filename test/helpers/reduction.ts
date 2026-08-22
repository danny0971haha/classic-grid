import type { LiveOrder } from "../../src/types.js";
import type {
  AuthoritativeReductionSnapshot,
  ReductionRequest,
  ReductionResult,
  ReductionTransport,
  ReductionWriteOutcome,
} from "../../src/experimentReduction.js";

export const OWNER_PREFIX = "cg:classic-v02-dryrun:";
export const SCOPE = "extended:BTC";
export const MARKET = "BTC";
export const LIMITS = {
  maxGrossNotionalUsd: 150,
  dailyLossUsd: 5,
  maxDrawdownUsd: 10,
  boundaryBufferPct: 0.01,
};

export function ownedOrder(partial: Partial<LiveOrder> & Pick<LiveOrder, "side">): LiveOrder {
  const side = partial.side;
  const level = partial.level ?? (side === "buy" ? 1 : 8);
  return {
    id: partial.id || `ex-${side}-${level}`,
    market: partial.market || MARKET,
    side,
    price: partial.price ?? (side === "buy" ? 99_000 : 101_000),
    size: partial.size ?? 0.001,
    level,
    clientOrderId: partial.clientOrderId ?? `${OWNER_PREFIX}1-${side}-${level}`,
    reduceOnly: partial.reduceOnly,
  };
}

export function unownedOrder(partial: Partial<LiveOrder> = {}): LiveOrder {
  return {
    id: partial.id || "manual-1",
    market: partial.market || MARKET,
    side: partial.side || "buy",
    price: partial.price ?? 98_000,
    size: partial.size ?? 0.001,
    level: partial.level ?? 0,
    clientOrderId: partial.clientOrderId ?? "manual-operator-1",
  };
}

export function freshSnapshot(partial: Partial<AuthoritativeReductionSnapshot> = {}): AuthoritativeReductionSnapshot {
  const observedAt = partial.observedAt ?? new Date().toISOString();
  return {
    observedAt,
    observationId: partial.observationId ?? `obs-${Math.random().toString(16).slice(2)}`,
    sourceGeneration: partial.sourceGeneration ?? `gen-${observedAt}`,
    capturedAtMs: partial.capturedAtMs ?? Date.parse(observedAt),
    positionQty: partial.positionQty ?? 0,
    openOrders: partial.openOrders ?? [],
    mid: partial.mid ?? 100_000,
    freshness: partial.freshness ?? "fresh",
    leaseGeneration: partial.leaseGeneration ?? "lease-1",
  };
}

export type ScriptedTransport = ReductionTransport & {
  cancelCalls: number;
  flattenCalls: number;
  snapshotCalls: number;
  flattenRequests: Array<ReductionRequest & { side: "buy" | "sell"; qty: number }>;
  cancelledOrders: LiveOrder[][];
  flattenClientOrderIds: string[];
};

export function scriptedTransport(script: {
  cancel?: ReductionWriteOutcome | ReductionWriteOutcome[] | ((orders: LiveOrder[]) => ReductionWriteOutcome);
  flatten?: ReductionWriteOutcome | ReductionWriteOutcome[] | ((req: ReductionRequest & { side: "buy" | "sell"; qty: number }) => ReductionResult);
  snapshots?: AuthoritativeReductionSnapshot[] | ((attempt: number) => AuthoritativeReductionSnapshot);
  snapshotError?: Error;
  onCancel?: (orders: LiveOrder[]) => void;
  onFlatten?: (req: ReductionRequest & { side: "buy" | "sell"; qty: number }) => void;
}): ScriptedTransport {
  const cancelQueue = Array.isArray(script.cancel) ? [...script.cancel] : [];
  const flattenQueue = Array.isArray(script.flatten) ? [...script.flatten] : [];
  const snapQueue = Array.isArray(script.snapshots) ? [...script.snapshots] : [];
  const transport: ScriptedTransport = {
    cancelCalls: 0,
    flattenCalls: 0,
    snapshotCalls: 0,
    flattenRequests: [],
    cancelledOrders: [],
    flattenClientOrderIds: [],
    async cancelOwnedOrders(p) {
      transport.cancelCalls += 1;
      transport.cancelledOrders.push(p.orders);
      script.onCancel?.(p.orders);
      if (typeof script.cancel === "function") {
        return { outcome: script.cancel(p.orders) };
      }
      const outcome = cancelQueue.shift() ?? (typeof script.cancel === "string" ? script.cancel : "ACK");
      return { outcome };
    },
    async submitFlatten(request) {
      transport.flattenCalls += 1;
      transport.flattenRequests.push(request);
      script.onFlatten?.(request);
      if (typeof script.flatten === "function") {
        const result = script.flatten(request);
        if (result.clientOrderId) transport.flattenClientOrderIds.push(result.clientOrderId);
        return result;
      }
      const outcome = flattenQueue.shift() ?? (typeof script.flatten === "string" ? script.flatten : "ACK");
      const clientOrderId = `cg-reduce:${request.incidentId}:flatten`;
      transport.flattenClientOrderIds.push(clientOrderId);
      return { outcome, clientOrderId };
    },
    async fetchFreshSnapshot() {
      transport.snapshotCalls += 1;
      if (script.snapshotError) throw script.snapshotError;
      if (typeof script.snapshots === "function") return script.snapshots(transport.snapshotCalls);
      const next = snapQueue.shift();
      if (!next) throw new Error("SNAPSHOT_WITHHELD");
      return next;
    },
  };
  return transport;
}
