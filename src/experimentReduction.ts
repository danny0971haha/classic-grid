import type { ApplyResult, Intent, LiveOrder, Side, VenueSnapshot } from "./types.js";
import {
  ensureIncidentHaltIdentity,
  experimentDir,
  inspectDurableRiskAuthority,
  latchForcedHaltInMemory,
  loadRiskState,
  persistAuthoritativeRiskState,
  type DurableRiskAuthority,
  type ExperimentRiskState,
  type HaltStatus,
  type ReductionPhase,
  type RiskStateStoreOptions,
} from "./experimentRisk.js";
import { markRuntimeSessionReconciliationRequired } from "./runtimeLease.js";

/** Conservative absolute flat quantity. Not derived from any fixture position. */
export const ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE = 1e-8;
export const REDUCTION_SNAPSHOT_MAX_AGE_MS = 15_000;
export const MAX_FLATTEN_ATTEMPTS = 2;

export type ReductionLifecycle = ReductionPhase;
export type ReductionWriteOutcome = "ACK" | "REJECTED" | "UNKNOWN" | "NOT_SENT";

export type ReductionRequest = {
  market: string;
  targetAbsPositionQty: 0;
  incidentId: string;
  leaseGeneration: string;
  positionQty: number;
  attempt: number;
};

export type ReductionResult = {
  outcome: ReductionWriteOutcome;
  exchangeOrderId?: string;
  clientOrderId?: string;
  reasonCode?: string;
};

export type AuthoritativeReductionSnapshot = {
  observedAt: string;
  observationId: string;
  sourceGeneration: string;
  capturedAtMs: number;
  positionQty: number;
  openOrders: LiveOrder[];
  mid: number;
  freshness: "fresh" | "cached" | "pre_write";
  leaseGeneration?: string;
};

export type SnapshotVerification =
  | { ok: true; flat: true }
  | { ok: false; reasonCode: string };

export type ReductionTransport = {
  cancelOwnedOrders(p: {
    market: string;
    incidentId: string;
    leaseGeneration: string;
    orders: LiveOrder[];
  }): Promise<{ outcome: ReductionWriteOutcome; reasonCode?: string }>;
  submitFlatten(request: ReductionRequest & { side: Side; qty: number }): Promise<ReductionResult>;
  fetchFreshSnapshot(p: {
    market: string;
    mutationAttemptAtMs: number;
    leaseGeneration: string;
  }): Promise<AuthoritativeReductionSnapshot>;
};

export type ActualNotionalHaltResult = {
  state: ExperimentRiskState;
  lifecycle: ReductionLifecycle;
  haltId: string;
  flatten: ReductionResult | null;
  cancel: { outcome: ReductionWriteOutcome; reasonCode?: string } | null;
  verifiedFlat: boolean;
  reseedAllowed: false;
  errors: string[];
};

export type ActualNotionalHaltParams = {
  experimentId: string;
  market: string;
  ownershipPrefix: string;
  positionQty: number;
  openOrders: LiveOrder[];
  reasons: string[];
  transport: ReductionTransport;
  assertLeaseCurrent: () => void;
  leaseGeneration: string;
  baseDir?: string;
  scopeKey?: string;
  persistOptions?: RiskStateStoreOptions;
  state?: ExperimentRiskState;
  nowMs?: () => number;
  maxFlattenAttempts?: number;
  qtyStep?: number;
  onDurableAuthorityInspected?: (authority: DurableRiskAuthority) => void;
};

function errText(error: unknown): string {
  return String((error as { message?: string })?.message || error).slice(0, 300);
}

function unique(rows: string[]): string[] {
  return Array.from(new Set(rows.filter((row) => row.length > 0)));
}

function isNonEmptyHaltId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAuthorityLoss(error: unknown): boolean {
  return /LEASE|PREDECESSOR_CHANGED|LEASE_AUTHORITY/i.test(errText(error));
}

export function reductionClientOrderId(incidentId: string, attempt = 1): string {
  return Number.isSafeInteger(attempt) && attempt > 1
    ? `cg-reduce:${incidentId}:flatten:${attempt}`
    : `cg-reduce:${incidentId}:flatten`;
}

export function experimentAllowsReseed(state: ExperimentRiskState): boolean {
  return state.halted === false && state.haltStatus === "RUNNING" && state.haltId === null;
}

export function classifyExposureReducingSide(positionQty: number): Side | null {
  if (!Number.isFinite(positionQty)) return null;
  if (positionQty > ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE) return "sell";
  if (positionQty < -ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE) return "buy";
  return null;
}

export function boundFlattenQty(positionQty: number, requestedQty: number, qtyStep = ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE): number {
  if (![positionQty, requestedQty, qtyStep].every(Number.isFinite) || !(qtyStep > 0)) return 0;
  const maxQty = Math.abs(positionQty);
  const wanted = Math.min(Math.abs(requestedQty), maxQty);
  if (!(wanted > 0) || !(maxQty > 0)) return 0;
  const aligned = Math.floor(wanted / qtyStep) * qtyStep;
  if (!(aligned > 0)) return 0;
  return aligned > maxQty ? maxQty : aligned;
}

export function isOwnedRiskIncreasingOrder(
  order: LiveOrder,
  ownershipPrefix: string,
  positionQty: number
): boolean {
  if (!ownershipPrefix) return false;
  const clientOrderId = String(order.clientOrderId || "");
  if (!clientOrderId.startsWith(ownershipPrefix)) return false;
  if (order.reduceOnly === true) return false;
  const remaining = Math.max(0, Number(order.size) || 0);
  if (!Number.isFinite(positionQty) || !Number.isFinite(remaining)) return true;
  if (Math.abs(positionQty) <= ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE) return true;
  if (positionQty > ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE) {
    if (order.side === "buy") return true;
    return remaining > positionQty + ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE;
  }
  if (positionQty < -ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE) {
    if (order.side === "sell") return true;
    return remaining > Math.abs(positionQty) + ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE;
  }
  return true;
}

export function classifyTransportError(error: unknown): ReductionWriteOutcome {
  const msg = errText(error);
  if (/RUNTIME_LEASE_|NOT_SENT|未 connect|LEASE_MISSING|GENERATION_MISMATCH/i.test(msg)) return "NOT_SENT";
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang|network|429|ambiguous|UNKNOWN/i.test(msg)) return "UNKNOWN";
  return "REJECTED";
}

export function verifyFlattenSnapshot(p: {
  snapshot: AuthoritativeReductionSnapshot;
  mutationAttemptAtMs: number;
  ownershipPrefix: string;
  nowMs: number;
  expectedLeaseGeneration?: string;
}): SnapshotVerification {
  const { snapshot } = p;
  if (snapshot.freshness === "cached") return { ok: false, reasonCode: "CACHED_SNAPSHOT" };
  if (snapshot.freshness === "pre_write") return { ok: false, reasonCode: "PRE_WRITE_SNAPSHOT" };
  if (!snapshot.observationId || !snapshot.sourceGeneration) {
    return { ok: false, reasonCode: "AMBIGUOUS_SOURCE_GENERATION" };
  }
  if (!snapshot.observedAt || !Number.isFinite(Date.parse(snapshot.observedAt))) {
    return { ok: false, reasonCode: "MISSING_OBSERVATION_TIME" };
  }
  const observedMs = Date.parse(snapshot.observedAt);
  if (observedMs < p.mutationAttemptAtMs) return { ok: false, reasonCode: "STALE_OR_PRE_WRITE" };
  if (p.nowMs - observedMs > REDUCTION_SNAPSHOT_MAX_AGE_MS) return { ok: false, reasonCode: "STALE_OBSERVATION" };
  if (p.expectedLeaseGeneration) {
    if (!snapshot.leaseGeneration || snapshot.leaseGeneration !== p.expectedLeaseGeneration) {
      return { ok: false, reasonCode: "SNAPSHOT_FENCE_MISMATCH" };
    }
  }
  if (Math.abs(snapshot.positionQty) > ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE) {
    return { ok: false, reasonCode: "POSITION_NOT_FLAT" };
  }
  if (snapshot.openOrders.some((order) => isOwnedRiskIncreasingOrder(order, p.ownershipPrefix, snapshot.positionQty))) {
    return { ok: false, reasonCode: "OWNED_RISK_INCREASING_REMAINS" };
  }
  return { ok: true, flat: true };
}

function tryAssertLease(assertLeaseCurrent: () => void): string | null {
  try {
    assertLeaseCurrent();
    return null;
  } catch (error) {
    return errText(error);
  }
}

function markUnresolvedSession(p: {
  experimentId: string;
  baseDir?: string;
  scopeKey?: string;
}, leaseGeneration: string | null): void {
  try {
    markRuntimeSessionReconciliationRequired({
      experimentDir: experimentDir(p.experimentId, p.baseDir),
      experimentId: p.experimentId,
      scopeKey: p.scopeKey || "UNSCOPED",
      leaseGeneration: leaseGeneration || "",
      reasonCodes: ["RISK_STATE_PERSIST_FAILED"],
    });
  } catch {
    /* leftover OPEN still fail-closes the next start */
  }
}

function withHalt(
  state: ExperimentRiskState,
  haltStatus: HaltStatus,
  phase: ReductionPhase,
  persistOptions?: RiskStateStoreOptions
): ExperimentRiskState {
  return ensureIncidentHaltIdentity({
    ...state,
    halted: true,
    haltStatus,
    reductionPhase: phase,
    acknowledged: false,
    updatedAt: new Date().toISOString(),
  }, persistOptions);
}

export function createVenueReductionTransport(p: {
  apply: (intents: Intent[]) => Promise<ApplyResult>;
  closePosition: (market: string) => Promise<void>;
  reduceExposure?: (request: ReductionRequest & { side: Side; qty: number }) => Promise<ReductionResult>;
  snapshot: (market: string) => Promise<VenueSnapshot>;
  observeAuthoritative?: (input: {
    market: string;
    mutationAttemptAtMs: number;
    leaseGeneration: string;
  }) => Promise<AuthoritativeReductionSnapshot>;
  assertLeaseCurrent: () => void;
  nowMs?: () => number;
}): ReductionTransport {
  return {
    async cancelOwnedOrders(input) {
      p.assertLeaseCurrent();
      if (input.orders.length === 0) return { outcome: "ACK", reasonCode: "NONE_TO_CANCEL" };
      try {
        const result = await p.apply(input.orders.map((order) => ({
          type: "cancel" as const,
          orderId: order.id,
          market: input.market,
        })));
        if (result.ambiguous) return { outcome: "UNKNOWN", reasonCode: "CANCEL_AMBIGUOUS" };
        if (result.failed && result.cancelled === 0) return { outcome: "REJECTED", reasonCode: "CANCEL_REJECTED" };
        if (result.failed) return { outcome: "UNKNOWN", reasonCode: "CANCEL_PARTIAL" };
        return { outcome: "ACK" };
      } catch (error) {
        return { outcome: classifyTransportError(error), reasonCode: errText(error) };
      }
    },
    async submitFlatten(request) {
      p.assertLeaseCurrent();
      const clientOrderId = reductionClientOrderId(request.incidentId, request.attempt);
      if (p.reduceExposure) {
        const result = await p.reduceExposure(request);
        return { ...result, clientOrderId: result.clientOrderId || clientOrderId };
      }
      try {
        await p.closePosition(request.market);
        return { outcome: "ACK", clientOrderId };
      } catch (error) {
        return {
          outcome: classifyTransportError(error),
          clientOrderId,
          reasonCode: errText(error),
        };
      }
    },
    async fetchFreshSnapshot(input) {
      if (p.observeAuthoritative) {
        return p.observeAuthoritative(input);
      }
      const snap = await p.snapshot(input.market);
      return {
        observedAt: snap.observedAt ?? "",
        observationId: "",
        sourceGeneration: "",
        capturedAtMs: (p.nowMs ?? Date.now)(),
        positionQty: snap.position,
        openOrders: snap.openOrders,
        mid: snap.mid,
        freshness: "cached",
      };
    },
  };
}

export async function runActualNotionalHardHalt(
  p: ActualNotionalHaltParams
): Promise<ActualNotionalHaltResult> {
  const errors: string[] = [];
  const nowMs = p.nowMs ?? Date.now;
  const maxFlattenAttempts = Math.max(1, Math.min(3, p.maxFlattenAttempts ?? MAX_FLATTEN_ATTEMPTS));
  const qtyStep = p.qtyStep ?? ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE;
  const persistOptions: RiskStateStoreOptions = {
    ...p.persistOptions,
    assertLeaseCurrent: p.assertLeaseCurrent,
  };

  loadRiskState(p.experimentId, p.baseDir, p.scopeKey, persistOptions);
  const authority = inspectDurableRiskAuthority(p.experimentId, p.baseDir, persistOptions);
  p.onDurableAuthorityInspected?.(authority);

  let cancel: ActualNotionalHaltResult["cancel"] = null;
  let flatten: ReductionResult | null = null;
  let verifiedFlat = false;
  let lifecycle: ReductionLifecycle = "HALTING";
  let lastSnap: AuthoritativeReductionSnapshot | null = null;

  const failClosedNoWrite = (
    reason: string,
    extras: { cancel?: ActualNotionalHaltResult["cancel"]; flatten?: ReductionResult | null } = {}
  ): ActualNotionalHaltResult => {
    errors.push(reason);
    const evidence = authority.payload;
    const next = latchForcedHaltInMemory(
      p.experimentId,
      {
        ...evidence,
        haltReasons: unique([...evidence.haltReasons, ...p.reasons, reason, "ACTUAL_NOTIONAL_CAP"]),
      },
      reason,
      persistOptions
    );
    markUnresolvedSession(p, p.leaseGeneration);
    cancel = extras.cancel ?? cancel ?? { outcome: "NOT_SENT", reasonCode: reason };
    flatten = extras.flatten ?? flatten;
    lifecycle = next.reductionPhase || "HALT_FAILED";
    return {
      state: next,
      lifecycle,
      haltId: next.haltId as string,
      flatten,
      cancel,
      verifiedFlat: false,
      reseedAllowed: false,
      errors,
    };
  };

  if (typeof p.assertLeaseCurrent !== "function" || !p.leaseGeneration) {
    return failClosedNoWrite("REDUCTION_LEASE_AUTHORITY_MISSING");
  }
  if (!authority.ok) {
    return failClosedNoWrite(authority.reasons[0] || "RISK_STATE_ACK_DURABLE_PAIR_UNPROVEN");
  }

  let predecessor = {
    storeGeneration: authority.storeGeneration,
    envelopeSha256: authority.envelopeSha256,
  };
  const durable = authority.payload;
  const memory = p.state;
  const reasons = unique([
    ...durable.haltReasons,
    ...(memory?.haltReasons ?? []),
    ...p.reasons,
    "ACTUAL_NOTIONAL_CAP",
  ]);
  const haltId = isNonEmptyHaltId(durable.haltId)
    ? durable.haltId
    : (isNonEmptyHaltId(memory?.haltId) ? memory.haltId : undefined);

  let state = ensureIncidentHaltIdentity({
    ...durable,
    halted: true,
    haltStatus: durable.haltStatus !== "RUNNING" ? durable.haltStatus : "HALTING",
    haltId: haltId ?? null,
    haltReasons: reasons,
    acknowledged: false,
    scopeKey: p.scopeKey ?? durable.scopeKey ?? memory?.scopeKey ?? null,
    leaseGeneration: p.leaseGeneration,
    updatedAt: new Date().toISOString(),
  }, persistOptions);
  const incidentId = state.haltId as string;

  const resultOf = (
    next: ExperimentRiskState,
    nextLifecycle: ReductionLifecycle
  ): ActualNotionalHaltResult => ({
    state: next,
    lifecycle: nextLifecycle,
    haltId: incidentId,
    flatten,
    cancel,
    verifiedFlat,
    reseedAllowed: false,
    errors,
  });

  const persistPhase = (haltStatus: HaltStatus, phase: ReductionPhase): ExperimentRiskState => {
    const leaseErr = tryAssertLease(p.assertLeaseCurrent);
    if (leaseErr) throw new Error(leaseErr);
    const next = withHalt({
      ...state,
      haltReasons: reasons,
      haltId: incidentId,
      leaseGeneration: p.leaseGeneration,
    }, haltStatus, phase, persistOptions);
    persistAuthoritativeRiskState(p.experimentId, next, p.baseDir, {
      ...persistOptions,
      expectedPredecessor: predecessor,
    });
    const after = inspectDurableRiskAuthority(p.experimentId, p.baseDir, persistOptions);
    if (!after.ok) throw new Error(after.reasons[0] || "RISK_STATE_POST_WRITE_VERIFY_FAILED");
    predecessor = {
      storeGeneration: after.storeGeneration,
      envelopeSha256: after.envelopeSha256,
    };
    state = after.payload;
    return state;
  };

  if (durable.haltStatus === "HALTED_FLAT") {
    lifecycle = "HALTED_FLAT";
    return resultOf(state, lifecycle);
  }

  const leaseBeforePersist = tryAssertLease(p.assertLeaseCurrent);
  if (leaseBeforePersist) {
    return failClosedNoWrite(leaseBeforePersist);
  }

  if (durable.haltStatus === "RUNNING") {
    try {
      persistPhase("HALTING", "HALTING");
    } catch (error) {
      errors.push(`persist HALTING: ${errText(error)}`);
      if (isAuthorityLoss(error)) {
        return failClosedNoWrite(errText(error));
      }
      state = latchForcedHaltInMemory(p.experimentId, state, "RISK_STATE_PERSIST_FAILED", persistOptions);
      markUnresolvedSession(p, state.leaseGeneration);
    }
  }

  const finalize = (haltStatus: Exclude<HaltStatus, "RUNNING">, phase: ReductionPhase): ActualNotionalHaltResult => {
    const leaseErr = tryAssertLease(p.assertLeaseCurrent);
    if (leaseErr) {
      verifiedFlat = false;
      errors.push(leaseErr);
      state = latchForcedHaltInMemory(
        p.experimentId,
        { ...state, haltStatus, haltReasons: unique([...state.haltReasons, leaseErr]) },
        leaseErr,
        persistOptions
      );
      markUnresolvedSession(p, p.leaseGeneration);
      lifecycle = haltStatus === "HALTED_FLAT" ? "HALT_FAILED" : phase;
      return resultOf(state, lifecycle);
    }
    lifecycle = phase;
    try {
      persistPhase(haltStatus, phase);
    } catch (error) {
      errors.push(`persist final: ${errText(error)}`);
      verifiedFlat = false;
      state = latchForcedHaltInMemory(
        p.experimentId,
        { ...state, haltStatus: "HALT_FAILED", haltReasons: unique([...state.haltReasons, "RISK_STATE_PERSIST_FAILED"]) },
        "RISK_STATE_PERSIST_FAILED",
        persistOptions
      );
      markUnresolvedSession(p, state.leaseGeneration);
      lifecycle = "HALT_FAILED";
    }
    return resultOf(state, lifecycle);
  };

  const leaseBeforeCancel = tryAssertLease(p.assertLeaseCurrent);
  if (leaseBeforeCancel) {
    cancel = { outcome: "NOT_SENT", reasonCode: leaseBeforeCancel };
    return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
  }

  lifecycle = "CANCELLING_OWNED_RISK";
  const ownedRiskIncreasing = (p.openOrders || []).filter((order) =>
    isOwnedRiskIncreasingOrder(order, p.ownershipPrefix, p.positionQty)
  );
  try {
    p.assertLeaseCurrent();
    cancel = await p.transport.cancelOwnedOrders({
      market: p.market,
      incidentId,
      leaseGeneration: p.leaseGeneration,
      orders: ownedRiskIncreasing,
    });
  } catch (error) {
    cancel = { outcome: classifyTransportError(error), reasonCode: errText(error) };
  }
  if (cancel.outcome === "UNKNOWN") errors.push("CANCEL_UNKNOWN_RECONCILE");

  const leaseBeforeFlatten = tryAssertLease(p.assertLeaseCurrent);
  if (leaseBeforeFlatten) {
    flatten = { outcome: "NOT_SENT", clientOrderId: reductionClientOrderId(incidentId), reasonCode: leaseBeforeFlatten };
    return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
  }

  lifecycle = "REDUCING_EXPOSURE";
  let request: ReductionRequest & { side: Side; qty: number } = {
    market: p.market,
    targetAbsPositionQty: 0,
    incidentId,
    leaseGeneration: p.leaseGeneration,
    positionQty: p.positionQty,
    attempt: 1,
    side: classifyExposureReducingSide(p.positionQty) ?? "sell",
    qty: boundFlattenQty(p.positionQty, Math.abs(p.positionQty), qtyStep),
  };
  const clientOrderId = reductionClientOrderId(incidentId, request.attempt);
  const canFlatten = classifyExposureReducingSide(p.positionQty) && request.qty > 0;

  if (canFlatten) {
    try {
      p.assertLeaseCurrent();
      const submitted = await p.transport.submitFlatten(request);
      flatten = { ...submitted, clientOrderId: submitted.clientOrderId || clientOrderId };
    } catch (error) {
      flatten = { outcome: classifyTransportError(error), clientOrderId, reasonCode: errText(error) };
    }
  } else {
    flatten = { outcome: "ACK", clientOrderId, reasonCode: "ALREADY_FLAT_POSITION" };
  }

  if (flatten.outcome === "REJECTED" || (flatten.outcome === "NOT_SENT" && canFlatten)) {
    return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
  }

  const mutationAttemptAtMs = nowMs();
  const verifyOnce = async (): Promise<{
    verification: SnapshotVerification;
    snap: AuthoritativeReductionSnapshot;
  }> => {
    const beforeRead = tryAssertLease(p.assertLeaseCurrent);
    if (beforeRead) throw new Error(beforeRead);
    const snap = await p.transport.fetchFreshSnapshot({
      market: p.market,
      mutationAttemptAtMs,
      leaseGeneration: p.leaseGeneration,
    });
    const afterRead = tryAssertLease(p.assertLeaseCurrent);
    if (afterRead) throw new Error(afterRead);
    lastSnap = snap;
    return {
      snap,
      verification: verifyFlattenSnapshot({
        snapshot: snap,
        mutationAttemptAtMs,
        ownershipPrefix: p.ownershipPrefix,
        nowMs: nowMs(),
        expectedLeaseGeneration: p.leaseGeneration,
      }),
    };
  };

  const acceptVerified = (haltStatus: Exclude<HaltStatus, "RUNNING">): ActualNotionalHaltResult => {
    if (verifiedFlat) return finalize("HALTED_FLAT", "HALTED_FLAT");
    if (lastSnap) return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
    return finalize(haltStatus, haltStatus === "HALT_FAILED" ? "HALT_FAILED" : "HALTED_UNFLAT");
  };

  if (flatten.outcome === "UNKNOWN") {
    try {
      const { verification } = await verifyOnce();
      verifiedFlat = verification.ok;
      if (!verification.ok) errors.push(verification.reasonCode);
    } catch (error) {
      errors.push(errText(error));
      verifiedFlat = false;
    }
    return acceptVerified(lastSnap ? "HALTED_UNFLAT" : "HALT_FAILED");
  }

  for (let attempt = 1; attempt <= maxFlattenAttempts; attempt++) {
    try {
      const { verification, snap } = await verifyOnce();
      if (verification.ok) {
        verifiedFlat = true;
        break;
      }
      errors.push(verification.reasonCode);
      if (/CACHED|PRE_WRITE|STALE|MISSING_OBSERVATION|AMBIGUOUS|FENCE/.test(verification.reasonCode)) {
        break;
      }
      if (attempt >= maxFlattenAttempts) break;
      if (tryAssertLease(p.assertLeaseCurrent)) break;
      const latestQty = snap.positionQty;
      const retrySide = classifyExposureReducingSide(latestQty);
      const retryQty = boundFlattenQty(latestQty, Math.abs(latestQty), qtyStep);
      if (!retrySide || !(retryQty > 0)) break;
      const bytesChanged = retrySide !== request.side || retryQty !== request.qty;
      request = {
        ...request,
        side: retrySide,
        qty: retryQty,
        positionQty: latestQty,
        attempt: bytesChanged ? request.attempt + 1 : request.attempt,
      };
      const retry = await p.transport.submitFlatten(request);
      flatten = { ...retry, clientOrderId: retry.clientOrderId || reductionClientOrderId(incidentId, request.attempt) };
      if (retry.outcome !== "ACK") {
        if (retry.outcome === "UNKNOWN") {
          try {
            const again = await verifyOnce();
            verifiedFlat = again.verification.ok;
            if (!again.verification.ok) errors.push(again.verification.reasonCode);
          } catch (error) {
            errors.push(errText(error));
            verifiedFlat = false;
          }
        }
        break;
      }
    } catch (error) {
      errors.push(errText(error));
      verifiedFlat = false;
      break;
    }
  }

  return acceptVerified(lastSnap ? "HALTED_UNFLAT" : "HALT_FAILED");
}
