import { createHash, randomUUID } from "node:crypto";
import type { ExtendedAccountStreamState } from "./extendedAccountStream.js";
import {
  ExtendedStrictApi,
  type EvidenceSource,
  type SourceEvidence,
  type StrictAccountIdentity,
  type StrictBalance,
  type StrictLeverage,
  type StrictMarkPrice,
  type StrictOpenOrder,
  type StrictPosition,
} from "./extendedStrictApi.js";

export type ObservationGeneration = {
  observationId: string;
  accountIdentityHash: string;
  market: string;
  leaseGeneration: number;
  wsConnectionId: string;
  wsSeqStart: number;
  wsSeqEnd: number;
  restWindowStartedAt: string;
  restWindowCompletedAt: string;
  relevantWsEventsDuringWindow: number;
  generatedAt: string;
};

export type ExtendedStrictAccountSnapshot = {
  generation: ObservationGeneration;
  account: StrictAccountIdentity;
  balance: StrictBalance;
  positions: StrictPosition[];
  openOrders: StrictOpenOrder[];
  leverage: StrictLeverage;
  markPrice: StrictMarkPrice;
  evidence: {
    account: SourceEvidence<StrictAccountIdentity>;
    balance: SourceEvidence<StrictBalance>;
    positions: SourceEvidence<StrictPosition[]>;
    openOrders: SourceEvidence<StrictOpenOrder[]>;
    leverage: SourceEvidence<StrictLeverage>;
    markPrice: SourceEvidence<StrictMarkPrice>;
  };
};

export type ObservationFailureReason =
  | "REST_FAILURE"
  | "WS_NOT_INITIALIZED"
  | "WS_SEQUENCE_GAP"
  | "ACCOUNT_MISMATCH"
  | "SOURCE_STALE"
  | "OBSERVATION_RACE"
  | "PRICE_UNAVAILABLE";

export type ExtendedObservationResult =
  | { ok: true; snapshot: ExtendedStrictAccountSnapshot }
  | {
      ok: false;
      observationId: string;
      failedSources: EvidenceSource[];
      reasonCode: ObservationFailureReason;
    };

type ObserveOptions = {
  market: string;
  leaseGeneration: number;
  maxSourceAgeMs?: number;
  maxAttempts?: number;
};

function hashAccount(account: StrictAccountIdentity): string {
  return createHash("sha256")
    .update(`${account.accountId}\u0000${account.l2Vault || ""}`)
    .digest("hex");
}

function sourceIsStale(evidence: SourceEvidence<unknown>, now: number, maxAgeMs: number): boolean {
  const updatedAt = Date.parse(evidence.responseCompletedAt);
  return !Number.isFinite(updatedAt) || now - updatedAt > maxAgeMs;
}

function accountIds(snapshot: {
  account: StrictAccountIdentity;
  balance: SourceEvidence<StrictBalance>;
  positions: StrictPosition[];
  openOrders: StrictOpenOrder[];
  leverage: SourceEvidence<StrictLeverage>;
}): Set<string> {
  const ids = new Set<string>([snapshot.account.accountId]);
  for (const candidate of [snapshot.balance.accountId, snapshot.leverage.accountId]) {
    if (candidate) ids.add(candidate);
  }
  for (const row of [...snapshot.positions, ...snapshot.openOrders]) {
    if (row.accountId) ids.add(row.accountId);
  }
  return ids;
}

export class ExtendedObservationBarrier {
  constructor(
    private readonly api: ExtendedStrictApi,
    private readonly stream: ExtendedAccountStreamState,
    private readonly now: () => number = Date.now
  ) {}

  async observe(options: ObserveOptions): Promise<ExtendedObservationResult> {
    const market = options.market.toUpperCase();
    const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    const maxSourceAgeMs = options.maxSourceAgeMs ?? 30_000;
    let lastObservationId = randomUUID();

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const observationId = randomUUID();
      lastObservationId = observationId;
      const before = this.stream.checkpoint();
      if (!before.valid) {
        return {
          ok: false,
          observationId,
          failedSources: ["EXTENDED_ACCOUNT_WS"],
          reasonCode: "WS_SEQUENCE_GAP",
        };
      }
      if (!before.initialized) {
        return {
          ok: false,
          observationId,
          failedSources: ["EXTENDED_ACCOUNT_WS"],
          reasonCode: "WS_NOT_INITIALIZED",
        };
      }

      const restWindowStartedMs = this.now();
      const restWindowStartedAt = new Date(restWindowStartedMs).toISOString();
      const [account, balance, positions, openOrders, leverage, markPrice] = await Promise.all([
        this.api.account(),
        this.api.balance(),
        this.api.positions(market),
        this.api.openOrders(market),
        this.api.leverage(market),
        this.api.markPrice(market),
      ]);
      const restWindowCompletedMs = this.now();
      const restWindowCompletedAt = new Date(restWindowCompletedMs).toISOString();
      const after = this.stream.checkpoint();
      const relevantWsEventsDuringWindow = this.stream.relevantEventsBetween(
        restWindowStartedMs,
        restWindowCompletedMs,
        market
      );

      if (!after.valid || after.connectionId !== before.connectionId) {
        return {
          ok: false,
          observationId,
          failedSources: ["EXTENDED_ACCOUNT_WS"],
          reasonCode: "WS_SEQUENCE_GAP",
        };
      }

      const allEvidence = [account, balance, positions, openOrders, leverage, markPrice];
      const failedSources = allEvidence.filter((item) => !item.ok).map((item) => item.source);
      if (failedSources.length > 0) {
        return { ok: false, observationId, failedSources, reasonCode: "REST_FAILURE" };
      }
      if (!markPrice.value || !(markPrice.value.markPrice > 0)) {
        return {
          ok: false,
          observationId,
          failedSources: ["EXTENDED_MARK_PRICE"],
          reasonCode: "PRICE_UNAVAILABLE",
        };
      }

      const staleSources = allEvidence
        .filter((item) => sourceIsStale(item, restWindowCompletedMs, maxSourceAgeMs))
        .map((item) => item.source);
      if (restWindowCompletedMs - after.lastActivityAt > maxSourceAgeMs) {
        staleSources.push("EXTENDED_ACCOUNT_WS");
      }
      if (staleSources.length > 0) {
        return { ok: false, observationId, failedSources: staleSources, reasonCode: "SOURCE_STALE" };
      }

      const strictAccount = account.value!;
      const strictBalance = balance.value!;
      const strictPositions = positions.value!;
      const strictOpenOrders = openOrders.value!;
      const strictLeverage = leverage.value!;
      if (
        accountIds({
          account: strictAccount,
          balance,
          positions: strictPositions,
          openOrders: strictOpenOrders,
          leverage,
        }).size !== 1
      ) {
        return {
          ok: false,
          observationId,
          failedSources: allEvidence.map((item) => item.source),
          reasonCode: "ACCOUNT_MISMATCH",
        };
      }

      if (relevantWsEventsDuringWindow > 0 || after.seq !== before.seq) {
        if (attempt + 1 < maxAttempts) continue;
        return {
          ok: false,
          observationId,
          failedSources: ["EXTENDED_ACCOUNT_WS"],
          reasonCode: "OBSERVATION_RACE",
        };
      }

      const generatedAt = new Date(this.now()).toISOString();
      return {
        ok: true,
        snapshot: {
          generation: {
            observationId,
            accountIdentityHash: hashAccount(strictAccount),
            market,
            leaseGeneration: options.leaseGeneration,
            wsConnectionId: before.connectionId,
            wsSeqStart: before.seq,
            wsSeqEnd: after.seq,
            restWindowStartedAt,
            restWindowCompletedAt,
            relevantWsEventsDuringWindow,
            generatedAt,
          },
          account: strictAccount,
          balance: strictBalance,
          positions: strictPositions,
          openOrders: strictOpenOrders,
          leverage: strictLeverage,
          markPrice: markPrice.value,
          evidence: { account, balance, positions, openOrders, leverage, markPrice },
        },
      };
    }
    return {
      ok: false,
      observationId: lastObservationId,
      failedSources: ["EXTENDED_ACCOUNT_WS"],
      reasonCode: "OBSERVATION_RACE",
    };
  }
}
