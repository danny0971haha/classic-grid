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
/** Fixed local/remote skew bound. Not enlarged from fixtures. */
export const MAX_CLOCK_SKEW_MS = 2_000;

export type ReductionLifecycle = ReductionPhase;
export type ReductionWriteOutcome = "ACK" | "REJECTED" | "UNKNOWN" | "NOT_SENT";

export type ReductionAttemptContext = {
  attempt: number;
  clientOrderId: string;
  side: Side;
  qty: number;
  requestStartedAtMs: number;
  verificationBarrierAtMs: number;
};

export type CancelAttemptContext = {
  requestStartedAtMs: number;
  verificationBarrierAtMs: number;
  incidentId: string;
  leaseGeneration: string;
  targetedExchangeOrderIds: string[];
};

const LOCAL_NOT_SENT_BRAND = Symbol("classic-grid.LOCAL_TRANSPORT_NOT_SENT");
const PROJECT_NORMALIZED = Symbol("classic-grid.reduction.normalized");

export type LocalTransportNotSentError = {
  kind: "LOCAL_TRANSPORT_NOT_SENT";
  transportCalled: false;
  stage: "LEASE" | "PREFLIGHT";
};

export type ReductionRequest = {
  market: string;
  targetAbsPositionQty: 0;
  incidentId: string;
  leaseGeneration: string;
  positionQty: number;
  attempt: number;
  clientOrderId: string;
};

export type ReductionResult = {
  outcome: ReductionWriteOutcome;
  requestedClientOrderId?: string;
  submittedExternalId?: string;
  exchangeOrderId?: string;
  clientOrderId?: string;
  reasonCode?: string;
  attempt?: number;
  side?: Side;
  qty?: number;
  requestStartedAtMs?: number;
  verificationBarrierAtMs?: number;
  physicalAttempt?: number;
  /** Project-owned proof of whether the actual venue mutation callable was entered. */
  venueMutationEntered?: boolean;
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

export function isVenueProvenReduceOnly(order: LiveOrder): boolean {
  return order.reduceOnly === true;
}

export function isUnsafeOwnedOpenOrder(order: LiveOrder, ownershipPrefix: string): boolean {
  if (!ownershipPrefix) return false;
  const clientOrderId = String(order.clientOrderId || "");
  if (!clientOrderId.startsWith(ownershipPrefix)) return false;
  return !isVenueProvenReduceOnly(order);
}

export function isOwnedRiskIncreasingOrder(
  order: LiveOrder,
  ownershipPrefix: string,
  _positionQty?: number
): boolean {
  return isUnsafeOwnedOpenOrder(order, ownershipPrefix);
}

export function isExplicitVenueRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const rec = error as {
    kind?: unknown;
    rejectionProven?: unknown;
    venueAccepted?: unknown;
    venueRejection?: unknown;
  };
  return rec.kind === "VENUE_REJECTION"
    || (rec.rejectionProven === true && rec.venueAccepted === false)
    || rec.venueRejection === true;
}

export function createLocalTransportNotSent(stage: "LEASE" | "PREFLIGHT"): LocalTransportNotSentError {
  return {
    kind: "LOCAL_TRANSPORT_NOT_SENT",
    transportCalled: false,
    stage,
    [LOCAL_NOT_SENT_BRAND]: true,
  } as LocalTransportNotSentError;
}

export function isLocalTransportNotSent(error: unknown): error is LocalTransportNotSentError {
  if (!error || typeof error !== "object") return false;
  const rec = error as Partial<LocalTransportNotSentError> & Record<symbol, unknown>;
  return rec.kind === "LOCAL_TRANSPORT_NOT_SENT"
    && rec.transportCalled === false
    && (rec.stage === "LEASE" || rec.stage === "PREFLIGHT")
    && rec[LOCAL_NOT_SENT_BRAND] === true;
}

function isProjectNormalizedReduction(value: unknown): value is ReductionResult {
  return Boolean(value) && typeof value === "object" && PROJECT_NORMALIZED in (value as object);
}

function innerProvenanceEnteredVenueMutation(raw: unknown): boolean {
  if (isLocalTransportNotSent(raw)) return false;
  if (isProjectNormalizedReduction(raw)) {
    if (raw.venueMutationEntered === false && raw.outcome === "NOT_SENT") return false;
    if (raw.venueMutationEntered === true) return true;
    return raw.outcome !== "NOT_SENT";
  }
  return true;
}

function finishNormalized(result: ReductionResult, mutationEntered: boolean): ReductionResult {
  const next: ReductionResult = {
    ...result,
    venueMutationEntered: result.outcome === "NOT_SENT" ? false : mutationEntered,
  };
  Object.defineProperty(next, PROJECT_NORMALIZED, { value: true });
  return next;
}

export function classifyTransportError(error: unknown): ReductionWriteOutcome {
  if (isLocalTransportNotSent(error)) return "NOT_SENT";
  if (isExplicitVenueRejection(error)) return "REJECTED";
  return "UNKNOWN";
}

const KNOWN_REDUCTION_OUTCOMES = new Set<ReductionWriteOutcome>(["ACK", "REJECTED", "UNKNOWN", "NOT_SENT"]);

export function normalizeReductionResult(
  request: ReductionRequest & { side: Side; qty: number },
  rawResultOrError: unknown,
  extras: {
    requestStartedAtMs?: number;
    verificationBarrierAtMs?: number;
    physicalAttempt?: number;
    /** Caller-owned proof that the venue mutation callable was invoked. */
    venueMutationEntered?: boolean;
  } = {}
): ReductionResult {
  const bound: Omit<ReductionResult, "outcome"> = {
    requestedClientOrderId: request.clientOrderId,
    clientOrderId: request.clientOrderId,
    attempt: request.attempt,
    side: request.side,
    qty: request.qty,
    requestStartedAtMs: extras.requestStartedAtMs,
    verificationBarrierAtMs: extras.verificationBarrierAtMs,
    physicalAttempt: extras.physicalAttempt ?? request.attempt,
  };
  const mutationEntered = extras.venueMutationEntered === true;
  if (rawResultOrError == null || typeof rawResultOrError !== "object" || Array.isArray(rawResultOrError)) {
    return finishNormalized({ ...bound, outcome: "UNKNOWN", reasonCode: "REDUCTION_RESULT_MALFORMED" }, mutationEntered);
  }
  if (isLocalTransportNotSent(rawResultOrError)) {
    if (mutationEntered) {
      return finishNormalized(
        { ...bound, outcome: "UNKNOWN", reasonCode: "REDUCTION_PROVENANCE_UNTRUSTED" },
        true
      );
    }
    const originalReason = (rawResultOrError as { reasonCode?: unknown }).reasonCode;
    const token = createLocalTransportNotSent(rawResultOrError.stage);
    return finishNormalized({
      ...bound,
      ...token,
      outcome: "NOT_SENT",
      reasonCode: typeof originalReason === "string" && originalReason ? originalReason : rawResultOrError.stage,
      physicalAttempt: 0,
    }, false);
  }
  const raw = rawResultOrError as Record<string, unknown>;
  if (isExplicitVenueRejection(raw) && raw.outcome !== "ACK") {
    return finishNormalized({
      ...bound,
      outcome: "REJECTED",
      reasonCode: String(raw.reasonCode || raw.message || "VENUE_REJECTION"),
    }, mutationEntered);
  }
  if (typeof raw.outcome !== "string" || !KNOWN_REDUCTION_OUTCOMES.has(raw.outcome as ReductionWriteOutcome)) {
    return finishNormalized({ ...bound, outcome: "UNKNOWN", reasonCode: "REDUCTION_RESULT_MALFORMED" }, mutationEntered);
  }
  if (raw.outcome === "ACK") {
    if (raw.requestedClientOrderId !== request.clientOrderId || raw.submittedExternalId !== request.clientOrderId) {
      return finishNormalized({
        ...bound,
        outcome: "UNKNOWN",
        reasonCode: "REDUCTION_IDENTITY_MISMATCH",
        submittedExternalId: typeof raw.submittedExternalId === "string" ? raw.submittedExternalId : undefined,
      }, mutationEntered);
    }
    return finishNormalized({
      ...bound,
      outcome: "ACK",
      submittedExternalId: raw.submittedExternalId as string,
      exchangeOrderId: typeof raw.exchangeOrderId === "string" ? raw.exchangeOrderId : undefined,
    }, mutationEntered);
  }
  if (raw.outcome === "NOT_SENT") {
    return finishNormalized(
      { ...bound, outcome: "UNKNOWN", reasonCode: "REDUCTION_PROVENANCE_UNTRUSTED" },
      mutationEntered
    );
  }
  if (raw.outcome === "REJECTED") {
    return finishNormalized({
      ...bound,
      outcome: "REJECTED",
      reasonCode: String(raw.reasonCode || "REJECTED"),
    }, mutationEntered);
  }
  return finishNormalized(
    { ...bound, outcome: "UNKNOWN", reasonCode: String(raw.reasonCode || "UNKNOWN") },
    mutationEntered
  );
}

function validateAuthoritativeReductionSnapshot(
  snapshot: unknown
): { ok: true } | { ok: false; reasonCode: string } {
  try {
    if (snapshot == null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
    }
    const rec = snapshot as Record<string, unknown>;
    if (rec.freshness !== "fresh" && rec.freshness !== "cached" && rec.freshness !== "pre_write") {
      return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_FRESHNESS_UNPROVEN" };
    }
    if (typeof rec.capturedAtMs !== "number" || !Number.isFinite(rec.capturedAtMs)) {
      return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
    }
    if (typeof rec.positionQty !== "number" || !Number.isFinite(rec.positionQty)) {
      return { ok: false, reasonCode: "REDUCTION_POSITION_NON_FINITE" };
    }
    if (typeof rec.mid !== "number" || !Number.isFinite(rec.mid) || !(rec.mid > 0)) {
      return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
    }
    if (typeof rec.observedAt !== "string" || !Number.isFinite(Date.parse(rec.observedAt))) {
      return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
    }
    if (typeof rec.observationId !== "string" || rec.observationId.length === 0) {
      return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
    }
    if (typeof rec.sourceGeneration !== "string" || rec.sourceGeneration.length === 0) {
      return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
    }
    if (!Array.isArray(rec.openOrders)) {
      return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
    }
    for (const row of rec.openOrders) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
      }
      const order = row as Record<string, unknown>;
      if (typeof order.id !== "string" || order.id.length === 0) {
        return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
      }
      if (order.clientOrderId != null && typeof order.clientOrderId !== "string") {
        return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
      }
      if (order.reduceOnly != null && typeof order.reduceOnly !== "boolean") {
        return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
      }
      if (order.side != null && order.side !== "buy" && order.side !== "sell") {
        return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
      }
    }
    if (rec.leaseGeneration != null && typeof rec.leaseGeneration !== "string") {
      return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
  }
}

function snapshotHasUnsafeOwnedOrders(
  snapshot: AuthoritativeReductionSnapshot,
  ownershipPrefix: string
): boolean {
  try {
    return Array.isArray(snapshot.openOrders)
      && snapshot.openOrders.some((order) => isUnsafeOwnedOpenOrder(order, ownershipPrefix));
  } catch {
    return true;
  }
}

function shouldNotRetryFlatten(
  reasonCode: string,
  snap: AuthoritativeReductionSnapshot,
  ownershipPrefix: string
): boolean {
  if (
    reasonCode === "UNSAFE_OWNED_ORDER_REMAINS"
    || reasonCode === "REDUCTION_SNAPSHOT_MALFORMED"
    || reasonCode === "REDUCTION_POSITION_NON_FINITE"
    || reasonCode === "REDUCTION_SNAPSHOT_FRESHNESS_UNPROVEN"
    || reasonCode === "REDUCTION_PROVENANCE_UNTRUSTED"
    || /CACHED|PRE_WRITE|STALE|MISSING_OBSERVATION|AMBIGUOUS|FENCE|REPLAY|FUTURE_OBSERVATION/.test(reasonCode)
  ) {
    return true;
  }
  return snapshotHasUnsafeOwnedOrders(snap, ownershipPrefix);
}

function verifySnapshotAuthorityFence(p: {
  snapshot: AuthoritativeReductionSnapshot;
  verificationBarrierAtMs: number;
  nowMs: number;
  expectedLeaseGeneration?: string;
  consumedObservationIds?: Iterable<string>;
  consumedSourceGenerations?: Iterable<string>;
}): { ok: true } | { ok: false; reasonCode: string } {
  const { snapshot } = p;
  if (snapshot.freshness === "cached") return { ok: false, reasonCode: "CACHED_SNAPSHOT" };
  if (snapshot.freshness === "pre_write") return { ok: false, reasonCode: "PRE_WRITE_SNAPSHOT" };
  if (!snapshot.observationId || !snapshot.sourceGeneration) {
    return { ok: false, reasonCode: "AMBIGUOUS_SOURCE_GENERATION" };
  }
  if (!Number.isFinite(snapshot.capturedAtMs)) {
    return { ok: false, reasonCode: "SNAPSHOT_FENCE_MISMATCH" };
  }
  if (snapshot.capturedAtMs < p.verificationBarrierAtMs) {
    return { ok: false, reasonCode: "STALE_OR_PRE_WRITE" };
  }
  if (snapshot.capturedAtMs > p.nowMs + MAX_CLOCK_SKEW_MS) {
    return { ok: false, reasonCode: "FUTURE_OBSERVATION" };
  }
  if (!snapshot.observedAt || !Number.isFinite(Date.parse(snapshot.observedAt))) {
    return { ok: false, reasonCode: "MISSING_OBSERVATION_TIME" };
  }
  const observedMs = Date.parse(snapshot.observedAt);
  if (observedMs < p.verificationBarrierAtMs) return { ok: false, reasonCode: "STALE_OR_PRE_WRITE" };
  if (observedMs > p.nowMs + MAX_CLOCK_SKEW_MS) return { ok: false, reasonCode: "FUTURE_OBSERVATION" };
  if (p.nowMs - observedMs > REDUCTION_SNAPSHOT_MAX_AGE_MS) return { ok: false, reasonCode: "STALE_OBSERVATION" };
  if (p.expectedLeaseGeneration) {
    if (!snapshot.leaseGeneration || snapshot.leaseGeneration !== p.expectedLeaseGeneration) {
      return { ok: false, reasonCode: "SNAPSHOT_FENCE_MISMATCH" };
    }
  }
  const consumedObservationIds = new Set(p.consumedObservationIds ?? []);
  const consumedSourceGenerations = new Set(p.consumedSourceGenerations ?? []);
  if (consumedObservationIds.has(snapshot.observationId) || consumedSourceGenerations.has(snapshot.sourceGeneration)) {
    return { ok: false, reasonCode: "REDUCTION_OBSERVATION_REPLAY" };
  }
  return { ok: true };
}

export function verifyFlattenSnapshot(p: {
  snapshot: AuthoritativeReductionSnapshot;
  mutationAttemptAtMs: number;
  verificationBarrierAtMs?: number;
  ownershipPrefix: string;
  nowMs: number;
  expectedLeaseGeneration?: string;
  consumedObservationIds?: Iterable<string>;
  consumedSourceGenerations?: Iterable<string>;
}): SnapshotVerification {
  try {
    const shape = validateAuthoritativeReductionSnapshot(p.snapshot);
    if (!shape.ok) return shape;
    const fence = verifySnapshotAuthorityFence({
      snapshot: p.snapshot,
      verificationBarrierAtMs: p.verificationBarrierAtMs ?? p.mutationAttemptAtMs,
      nowMs: p.nowMs,
      expectedLeaseGeneration: p.expectedLeaseGeneration,
      consumedObservationIds: p.consumedObservationIds,
      consumedSourceGenerations: p.consumedSourceGenerations,
    });
    if (!fence.ok) return fence;
    if (snapshotHasUnsafeOwnedOrders(p.snapshot, p.ownershipPrefix)) {
      return { ok: false, reasonCode: "UNSAFE_OWNED_ORDER_REMAINS" };
    }
    if (!Number.isFinite(p.snapshot.positionQty)) {
      return { ok: false, reasonCode: "REDUCTION_POSITION_NON_FINITE" };
    }
    if (Math.abs(p.snapshot.positionQty) > ACTUAL_NOTIONAL_FLAT_QTY_TOLERANCE) {
      return { ok: false, reasonCode: "POSITION_NOT_FLAT" };
    }
    return { ok: true, flat: true };
  } catch {
    return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
  }
}

export function verifyCancelReconciliationSnapshot(p: {
  snapshot: AuthoritativeReductionSnapshot;
  verificationBarrierAtMs: number;
  targetedOrderIds: string[];
  ownershipPrefix: string;
  nowMs: number;
  expectedLeaseGeneration: string;
  consumedObservationIds?: Iterable<string>;
  consumedSourceGenerations?: Iterable<string>;
}): { ok: true } | { ok: false; reasonCode: string } {
  try {
    const shape = validateAuthoritativeReductionSnapshot(p.snapshot);
    if (!shape.ok) return shape;
    const fence = verifySnapshotAuthorityFence({
      snapshot: p.snapshot,
      verificationBarrierAtMs: p.verificationBarrierAtMs,
      nowMs: p.nowMs,
      expectedLeaseGeneration: p.expectedLeaseGeneration,
      consumedObservationIds: p.consumedObservationIds,
      consumedSourceGenerations: p.consumedSourceGenerations,
    });
    if (!fence.ok) return fence;
    const remainingIds = new Set(p.snapshot.openOrders.map((order) => order.id));
    if (p.targetedOrderIds.some((id) => remainingIds.has(id))) {
      return { ok: false, reasonCode: "UNSAFE_OWNED_ORDER_REMAINS" };
    }
    if (snapshotHasUnsafeOwnedOrders(p.snapshot, p.ownershipPrefix)) {
      return { ok: false, reasonCode: "UNSAFE_OWNED_ORDER_REMAINS" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reasonCode: "REDUCTION_SNAPSHOT_MALFORMED" };
  }
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
      try {
        p.assertLeaseCurrent();
      } catch (error) {
        return normalizeReductionResult(
          request,
          isLocalTransportNotSent(error) ? error : createLocalTransportNotSent("LEASE"),
          { physicalAttempt: 0, venueMutationEntered: false }
        );
      }
      if (p.reduceExposure) {
        try {
          const inner = await p.reduceExposure(request);
          const entered = innerProvenanceEnteredVenueMutation(inner);
          return normalizeReductionResult(request, inner, {
            physicalAttempt: entered ? (typeof inner.physicalAttempt === "number" ? inner.physicalAttempt : request.attempt) : 0,
            venueMutationEntered: entered,
          });
        } catch (error) {
          const entered = innerProvenanceEnteredVenueMutation(error);
          return normalizeReductionResult(request, error, {
            physicalAttempt: entered ? request.attempt : 0,
            venueMutationEntered: entered,
          });
        }
      }
      try {
        await p.closePosition(request.market);
        return normalizeReductionResult(request, {
          outcome: "UNKNOWN",
          clientOrderId: request.clientOrderId,
          requestedClientOrderId: request.clientOrderId,
          reasonCode: "REDUCTION_IDENTITY_UNPROVEN",
        }, { venueMutationEntered: true, physicalAttempt: 1 });
      } catch (error) {
        return normalizeReductionResult(request, error, { venueMutationEntered: true, physicalAttempt: 1 });
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

  const recordHaltReason = (code: string): void => {
    if (!code) return;
    if (!errors.includes(code)) errors.push(code);
    if (!reasons.includes(code)) reasons.push(code);
  };

  const consumedObservationIds = new Set<string>();
  const consumedSourceGenerations = new Set<string>();
  let physicalAttempt = 0;
  let mutationAttemptAtMs = 0;
  let currentAttempt: ReductionAttemptContext | null = null;
  let latestPositionQty = p.positionQty;

  const withheldFlatten = (reasonCode: string): ReductionResult => {
    const withheldId = reductionClientOrderId(incidentId, 1);
    return {
      outcome: "NOT_SENT",
      clientOrderId: withheldId,
      requestedClientOrderId: withheldId,
      reasonCode,
      physicalAttempt: 0,
    };
  };

  const leaseBeforeCancel = tryAssertLease(p.assertLeaseCurrent);
  if (leaseBeforeCancel) {
    cancel = { outcome: "NOT_SENT", reasonCode: leaseBeforeCancel };
    flatten = withheldFlatten(leaseBeforeCancel);
    return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
  }

  lifecycle = "CANCELLING_OWNED_RISK";
  const ownedUnsafe = (p.openOrders || []).filter((order) =>
    isUnsafeOwnedOpenOrder(order, p.ownershipPrefix)
  );
  const targetedExchangeOrderIds = ownedUnsafe.map((order) => order.id);
  const cancelStartedAtMs = nowMs();
  try {
    p.assertLeaseCurrent();
    cancel = await p.transport.cancelOwnedOrders({
      market: p.market,
      incidentId,
      leaseGeneration: p.leaseGeneration,
      orders: ownedUnsafe,
    });
  } catch (error) {
    cancel = { outcome: classifyTransportError(error), reasonCode: errText(error) };
  }
  const cancelAttempt: CancelAttemptContext = {
    requestStartedAtMs: cancelStartedAtMs,
    verificationBarrierAtMs: nowMs(),
    incidentId,
    leaseGeneration: p.leaseGeneration,
    targetedExchangeOrderIds,
  };
  if (cancel.outcome === "UNKNOWN") recordHaltReason("CANCEL_UNKNOWN_RECONCILE");

  if (targetedExchangeOrderIds.length > 0) {
    const beforeRead = tryAssertLease(p.assertLeaseCurrent);
    if (beforeRead) {
      recordHaltReason(beforeRead);
      recordHaltReason("CANCEL_RECONCILIATION_UNPROVEN");
      flatten = withheldFlatten("CANCEL_RECONCILIATION_UNPROVEN");
      return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
    }
    let cancelSnap: AuthoritativeReductionSnapshot;
    try {
      cancelSnap = await p.transport.fetchFreshSnapshot({
        market: p.market,
        mutationAttemptAtMs: cancelAttempt.requestStartedAtMs,
        leaseGeneration: p.leaseGeneration,
      });
    } catch (error) {
      recordHaltReason(errText(error));
      recordHaltReason("CANCEL_RECONCILIATION_UNPROVEN");
      flatten = withheldFlatten("CANCEL_RECONCILIATION_UNPROVEN");
      return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
    }
    const afterRead = tryAssertLease(p.assertLeaseCurrent);
    if (afterRead) {
      recordHaltReason(afterRead);
      recordHaltReason("CANCEL_RECONCILIATION_UNPROVEN");
      flatten = withheldFlatten("CANCEL_RECONCILIATION_UNPROVEN");
      return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
    }
    const proof = verifyCancelReconciliationSnapshot({
      snapshot: cancelSnap,
      verificationBarrierAtMs: cancelAttempt.verificationBarrierAtMs,
      targetedOrderIds: targetedExchangeOrderIds,
      ownershipPrefix: p.ownershipPrefix,
      nowMs: nowMs(),
      expectedLeaseGeneration: p.leaseGeneration,
      consumedObservationIds,
      consumedSourceGenerations,
    });
    if (cancelSnap.observationId) consumedObservationIds.add(cancelSnap.observationId);
    if (cancelSnap.sourceGeneration) consumedSourceGenerations.add(cancelSnap.sourceGeneration);
    lastSnap = cancelSnap;
    if (!proof.ok) {
      recordHaltReason(proof.reasonCode);
      recordHaltReason("CANCEL_RECONCILIATION_UNPROVEN");
      flatten = withheldFlatten("CANCEL_RECONCILIATION_UNPROVEN");
      return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
    }
    latestPositionQty = cancelSnap.positionQty;
  }

  const leaseBeforeFlatten = tryAssertLease(p.assertLeaseCurrent);
  if (leaseBeforeFlatten) {
    flatten = withheldFlatten(leaseBeforeFlatten);
    return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
  }

  lifecycle = "REDUCING_EXPOSURE";

  const buildFlattenRequest = (
    positionQty: number,
    attempt: number
  ): ReductionRequest & { side: Side; qty: number } => ({
    market: p.market,
    targetAbsPositionQty: 0,
    incidentId,
    leaseGeneration: p.leaseGeneration,
    positionQty,
    attempt,
    clientOrderId: reductionClientOrderId(incidentId, attempt),
    side: classifyExposureReducingSide(positionQty) ?? "sell",
    qty: boundFlattenQty(positionQty, Math.abs(positionQty), qtyStep),
  });

  const submitPhysical = async (positionQty: number): Promise<ReductionResult> => {
    const nextAttempt = physicalAttempt + 1;
    const request = buildFlattenRequest(positionQty, nextAttempt);
    const leaseErr = tryAssertLease(p.assertLeaseCurrent);
    if (leaseErr) {
      return normalizeReductionResult(
        request,
        createLocalTransportNotSent("LEASE"),
        { physicalAttempt: 0, venueMutationEntered: false }
      );
    }
    const requestStartedAtMs = nowMs();
    let raw: unknown;
    try {
      raw = await p.transport.submitFlatten(request);
    } catch (error) {
      raw = error;
    }
    const verificationBarrierAtMs = nowMs();
    const entered = innerProvenanceEnteredVenueMutation(raw);
    if (entered) {
      mutationAttemptAtMs = requestStartedAtMs;
      physicalAttempt = nextAttempt;
      currentAttempt = {
        attempt: nextAttempt,
        clientOrderId: request.clientOrderId,
        side: request.side,
        qty: request.qty,
        requestStartedAtMs,
        verificationBarrierAtMs,
      };
    }
    const result = normalizeReductionResult(request, raw, {
      requestStartedAtMs,
      verificationBarrierAtMs,
      physicalAttempt: entered ? nextAttempt : 0,
      venueMutationEntered: entered,
    });
    if (result.outcome === "UNKNOWN") {
      recordHaltReason("FLATTEN_ATTEMPT_UNKNOWN");
      if (result.reasonCode) recordHaltReason(result.reasonCode);
    }
    return result;
  };

  const firstRequest = buildFlattenRequest(latestPositionQty, 1);
  const canFlatten = Boolean(classifyExposureReducingSide(latestPositionQty) && firstRequest.qty > 0);

  if (canFlatten) {
    flatten = await submitPhysical(latestPositionQty);
  } else {
    flatten = {
      outcome: "NOT_SENT",
      clientOrderId: firstRequest.clientOrderId,
      requestedClientOrderId: firstRequest.clientOrderId,
      reasonCode: "ALREADY_FLAT_POSITION",
      physicalAttempt: 0,
      attempt: 0,
    };
    mutationAttemptAtMs = nowMs();
    currentAttempt = {
      attempt: 0,
      clientOrderId: firstRequest.clientOrderId,
      side: firstRequest.side,
      qty: 0,
      requestStartedAtMs: mutationAttemptAtMs,
      verificationBarrierAtMs: mutationAttemptAtMs,
    };
  }

  if (flatten.outcome === "REJECTED" || (flatten.outcome === "NOT_SENT" && canFlatten)) {
    return finalize("HALTED_UNFLAT", "HALTED_UNFLAT");
  }

  const verifyOnce = async (): Promise<{
    verification: SnapshotVerification;
    snap: AuthoritativeReductionSnapshot;
  }> => {
    if (!(mutationAttemptAtMs > 0)) mutationAttemptAtMs = nowMs();
    const requestStartedAtMs = currentAttempt?.requestStartedAtMs ?? mutationAttemptAtMs;
    const verificationBarrierAtMs = currentAttempt?.verificationBarrierAtMs ?? mutationAttemptAtMs;
    const beforeRead = tryAssertLease(p.assertLeaseCurrent);
    if (beforeRead) throw new Error(beforeRead);
    const snap = await p.transport.fetchFreshSnapshot({
      market: p.market,
      mutationAttemptAtMs: requestStartedAtMs,
      leaseGeneration: p.leaseGeneration,
    });
    const afterRead = tryAssertLease(p.assertLeaseCurrent);
    if (afterRead) throw new Error(afterRead);
    lastSnap = snap;
    const verification = verifyFlattenSnapshot({
      snapshot: snap,
      mutationAttemptAtMs: requestStartedAtMs,
      verificationBarrierAtMs,
      ownershipPrefix: p.ownershipPrefix,
      nowMs: nowMs(),
      expectedLeaseGeneration: p.leaseGeneration,
      consumedObservationIds,
      consumedSourceGenerations,
    });
    if (snap.observationId) consumedObservationIds.add(snap.observationId);
    if (snap.sourceGeneration) consumedSourceGenerations.add(snap.sourceGeneration);
    if (!verification.ok) recordHaltReason(verification.reasonCode);
    return { snap, verification };
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
    } catch (error) {
      recordHaltReason(errText(error));
      verifiedFlat = false;
    }
    return acceptVerified(lastSnap ? "HALTED_UNFLAT" : "HALT_FAILED");
  }

  for (let verifyRound = 1; verifyRound <= maxFlattenAttempts; verifyRound++) {
    try {
      const { verification, snap } = await verifyOnce();
      if (verification.ok) {
        verifiedFlat = true;
        break;
      }
      if (shouldNotRetryFlatten(verification.reasonCode, snap, p.ownershipPrefix)) {
        break;
      }
      if (verifyRound >= maxFlattenAttempts) break;
      if (tryAssertLease(p.assertLeaseCurrent)) break;
      const latestQty = snap.positionQty;
      const retrySide = classifyExposureReducingSide(latestQty);
      const retryQty = boundFlattenQty(latestQty, Math.abs(latestQty), qtyStep);
      if (!retrySide || !(retryQty > 0)) break;
      flatten = await submitPhysical(latestQty);
      if (flatten.outcome !== "ACK") {
        if (flatten.outcome === "UNKNOWN") {
          try {
            const again = await verifyOnce();
            verifiedFlat = again.verification.ok;
          } catch (error) {
            recordHaltReason(errText(error));
            verifiedFlat = false;
          }
        }
        break;
      }
    } catch (error) {
      recordHaltReason(errText(error));
      verifiedFlat = false;
      break;
    }
  }

  return acceptVerified(lastSnap ? "HALTED_UNFLAT" : "HALT_FAILED");
}
