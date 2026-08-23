import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LiveOrder } from "../../src/types.js";
import type {
  AuthoritativeReductionSnapshot,
  ReductionRequest,
  ReductionResult,
  ReductionTransport,
  ReductionWriteOutcome,
} from "../../src/experimentReduction.js";
import { reductionClientOrderId } from "../../src/experimentReduction.js";

const BYTE_WORKER = fileURLToPath(new URL("../fixtures/experiment-risk-byte-worker.ts", import.meta.url));

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
    leaseGeneration: Object.prototype.hasOwnProperty.call(partial, "leaseGeneration")
      ? partial.leaseGeneration
      : "lease-1",
  };
}

export type FlattenSubmitRequest = ReductionRequest & { side: "buy" | "sell"; qty: number };

export type ScriptedTransport = ReductionTransport & {
  cancelCalls: number;
  flattenCalls: number;
  snapshotCalls: number;
  flattenRequests: FlattenSubmitRequest[];
  cancelledOrders: LiveOrder[][];
  flattenClientOrderIds: string[];
  snapshotMutationAttemptAtMs: number[];
  snapshotEvidence: Array<{ observationId: string; sourceGeneration: string }>;
};

export function scriptedTransport(script: {
  cancel?: ReductionWriteOutcome | ReductionWriteOutcome[] | ((orders: LiveOrder[]) => ReductionWriteOutcome);
  flatten?: ReductionWriteOutcome | ReductionWriteOutcome[] | ((req: FlattenSubmitRequest) => ReductionResult);
  snapshots?: AuthoritativeReductionSnapshot[] | ((attempt: number) => AuthoritativeReductionSnapshot);
  snapshotError?: Error;
  onCancel?: (orders: LiveOrder[]) => void;
  onFlatten?: (req: FlattenSubmitRequest) => void;
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
    snapshotMutationAttemptAtMs: [],
    snapshotEvidence: [],
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
      const requestedId = request.clientOrderId || reductionClientOrderId(request.incidentId, request.attempt ?? 1);
      if (requestedId) transport.flattenClientOrderIds.push(requestedId);
      script.onFlatten?.(request);
      if (typeof script.flatten === "function") {
        return script.flatten(request);
      }
      const outcome = flattenQueue.shift() ?? (typeof script.flatten === "string" ? script.flatten : "ACK");
      return {
        outcome,
        clientOrderId: requestedId,
        requestedClientOrderId: requestedId,
        submittedExternalId: requestedId,
      };
    },
    async fetchFreshSnapshot(input) {
      transport.snapshotCalls += 1;
      transport.snapshotMutationAttemptAtMs.push(input.mutationAttemptAtMs);
      if (script.snapshotError) throw script.snapshotError;
      const next = typeof script.snapshots === "function"
        ? script.snapshots(transport.snapshotCalls)
        : snapQueue.shift();
      if (!next) throw new Error("SNAPSHOT_WITHHELD");
      transport.snapshotEvidence.push({
        observationId: next.observationId,
        sourceGeneration: next.sourceGeneration,
      });
      return next;
    },
  };
  return transport;
}

export type OfflineVendorSubmit = {
  method: string;
  path: string;
  payload: Record<string, unknown>;
};

export type OfflineExtendedVendor = {
  marketIdForName(name: string): number | null;
  closePosition(
    marketId: number,
    sizeBase?: number | null,
    externalId?: string | null
  ): Promise<unknown>;
};

export function attachExtendedExchangeForTests(executor: object, exchange: unknown): void {
  (executor as { ex: unknown }).ex = exchange;
}

export async function createOfflineExtendedVendor(): Promise<{
  exchange: OfflineExtendedVendor;
  submittedPayloads: OfflineVendorSubmit[];
}> {
  const vendorHref = pathToFileURL(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vendor/extended/exchange/extended.js")
  ).href;
  const { ExtendedExchange } = await import(vendorHref) as {
    ExtendedExchange: new (opts: Record<string, unknown>) => OfflineExtendedVendor & {
      markets: Map<number, Record<string, unknown>>;
      _pos: Map<number, { sizeBase: number; entryPrice: number }>;
      _prices: Map<number, number>;
      _req: (method: string, path: string, body?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  const submittedPayloads: OfflineVendorSubmit[] = [];
  const exchange = new ExtendedExchange({
    apiKey: "offline-test-not-a-live-key",
    vault: 10002,
    privateKey: "0x7a7ff6fd3cab02ccdcd4a572563f5976f8976899b03a39773795a3c486d4986",
    publicKey: "0x61c5e7e8339b7d56f197f54ea91b776776690e3232313de0f2ecbd0ef76f466",
    apiUrl: "http://127.0.0.1:1",
  });
  exchange.markets.set(1, {
    marketId: 1,
    name: "BTC-USD",
    qtyStep: "0.00001",
    priceStep: "0.1",
    l2: {
      syntheticId: "0x4254432d3600000000000000000000",
      collateralId: "0x31857064564ed0ff978e687456963cba09c2c6985d8f9300a1de4962fafa054",
      synRes: 1_000_000,
      colRes: 1_000_000,
    },
  });
  exchange._pos.set(1, { sizeBase: 0.001, entryPrice: 100_000 });
  exchange._prices.set(1, 100_000);
  exchange._req = async (method, reqPath, body) => {
    if (method === "POST" && reqPath === "/api/v1/user/order") {
      submittedPayloads.push({ method, path: reqPath, payload: { ...(body || {}) } });
      return { id: "venue-internal-77" };
    }
    throw new Error(`OFFLINE_VENDOR_UNEXPECTED_REQUEST:${method}:${reqPath}`);
  };
  return { exchange, submittedPayloads };
}

export type DurablePairBytes = {
  primarySha256: string;
  backupSha256: string;
  storeGeneration: number;
  envelopeSha256: string;
  haltStatus: string;
  haltId: string | null;
  leaseGeneration: string | null;
};

export function inspectDurablePair(experimentId: string, baseDir: string): DurablePairBytes {
  const primary = path.join(baseDir, experimentId, "risk-state.json");
  const backup = `${primary}.bak`;
  const primaryRaw = fs.readFileSync(primary, "utf8");
  const backupRaw = fs.readFileSync(backup, "utf8");
  const envelope = JSON.parse(primaryRaw) as {
    storeGeneration: number;
    envelopeSha256: string;
    payload: { haltStatus: string; haltId: string | null; leaseGeneration: string | null };
  };
  return {
    primarySha256: crypto.createHash("sha256").update(primaryRaw, "utf8").digest("hex"),
    backupSha256: crypto.createHash("sha256").update(backupRaw, "utf8").digest("hex"),
    storeGeneration: envelope.storeGeneration,
    envelopeSha256: envelope.envelopeSha256,
    haltStatus: envelope.payload.haltStatus,
    haltId: envelope.payload.haltId,
    leaseGeneration: envelope.payload.leaseGeneration,
  };
}

export function inspectDurablePairInFreshProcess(experimentId: string, baseDir: string): DurablePairBytes {
  const result = spawnSync(process.execPath, ["--import", "tsx", BYTE_WORKER], {
    env: {
      ...process.env,
      CLASSIC_RISK_ID: experimentId,
      CLASSIC_RISK_DIR: baseDir,
    },
    encoding: "utf8",
  });
  const line = String(result.stdout || "").trim().split("\n").filter(Boolean).at(-1);
  if (result.status !== 0 || !line) {
    throw new Error(result.stderr || result.stdout || "durable byte worker failed");
  }
  return JSON.parse(line) as DurablePairBytes;
}
