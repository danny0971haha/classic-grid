import path from "node:path";
import {
  assertSafeExperimentId,
  atomicWriteFile,
  createChecksummedEnvelopeV2,
  inspectChecksummedEnvelopeV2,
  serializeChecksummedEnvelopeV2,
  sha256Canonical,
  type ChecksummedEnvelopeV2,
  type StorageOptions,
} from "./experimentStorage.js";
import { experimentDir } from "./experimentRisk.js";
import {
  matchLevelIndex,
  parseOwnedClientOrderId,
  PLANNER_PRICE_TOLERANCE_SPACING_FRAC,
  replacementFor,
} from "./grid.js";
import { normalizeExecutionCursorMarket } from "./experimentTelemetry.js";
import type {
  ApplyResult,
  ExecutionJournalDrain,
  ExecutionRecord,
  GridMode,
  LiveOrder,
  PlannerReplacementObligation,
  ReplacementApplyDisposition,
  ReplacementObligationLifecycle,
  Side,
  VenueId,
} from "./types.js";

export const STRATEGY_LEDGER_SCHEMA_VERSION = "classic-grid.strategy-ledger.v1";
export const STRATEGY_LEDGER_KIND = "classic-grid.strategy-ledger.v1";
export const STRATEGY_QTY_EPS = 1e-8;
export const STRATEGY_REPLACEMENT_MAX_RETRIES = 8;

export type StrategyLedgerIdentity = {
  schemaVersion: typeof STRATEGY_LEDGER_SCHEMA_VERSION;
  experimentId: string;
  scopeKey: string;
  venue: string;
  market: string;
  anchorEpoch: number;
};

export type StrategyIdentityBinding = {
  clientOrderId: string;
  exchangeOrderId: string;
};

export type IngestedStrategyExecution = {
  dedupeKey: string;
  accepted: boolean;
  rejectionCode: string | null;
  exchangeTradeId: string | null;
  exchangeOrderId: string | null;
  clientOrderId: string | null;
  side: Side | null;
  levelIndex: number | null;
  incrementalQuantity: number;
  price: number;
  ingestedAt: string;
  ingestSequence: number;
};

export type StrategyLineageEntry = {
  orderKey: string;
  cumulative: number;
  incrementalSum: number;
  originalQuantity: number;
};

export type UnpairedExecutionLot = {
  side: Side;
  levelIndex: number;
  quantity: number;
  sourceDedupeKey: string;
};

export type ReplacementObligationRecord = {
  obligationId: string;
  sourceDedupeKey: string;
  sourceOrderIdentity: string;
  sourceSide: Side;
  sourceLevelIndex: number;
  targetSide: Side | null;
  targetLevelIndex: number | null;
  authoritativeExecutedQuantity: number;
  alreadyRepresentedQuantity: number;
  outstandingQuantity: number;
  placementQuantity: number;
  anchorEpoch: number;
  lifecycle: ReplacementObligationLifecycle;
  replacementClientOrderId: string | null;
  lastApplyDisposition: ReplacementApplyDisposition | null;
  retryCount: number;
  ingestSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type StrategyLedgerPayload = {
  schemaVersion: typeof STRATEGY_LEDGER_SCHEMA_VERSION;
  experimentId: string;
  scopeKey: string;
  venue: string;
  market: string;
  anchorEpoch: number;
  ingested: IngestedStrategyExecution[];
  obligations: ReplacementObligationRecord[];
  identityBindings: StrategyIdentityBinding[];
  lineage: StrategyLineageEntry[];
  unpairedLots: UnpairedExecutionLot[];
  authoritativePairedQuantity: number;
  authoritativeGrossProfitUsd: number;
  authoritativeCompletedRungs: number;
  reconciliationRequired: boolean;
  reconciliationCodes: string[];
  nextSequence: number;
};

export type StrategyLedgerLoad =
  | { condition: "MISSING"; ledger: StrategyLedgerPayload }
  | { condition: "VALID"; ledger: StrategyLedgerPayload; envelope: ChecksummedEnvelopeV2<StrategyLedgerPayload> }
  | {
      condition: "CORRUPT" | "SCOPE_MISMATCH" | "KIND_MISMATCH" | "EXPERIMENT_MISMATCH" | "UNSUPPORTED_VERSION" | "IDENTITY_MISMATCH";
      diagnosticCode: string;
    };

export type StrategyIngestResult = {
  proven: boolean;
  ledger: StrategyLedgerPayload | null;
  diagnosticCode: string | null;
  ackEligibleDedupeKeys: string[];
  riskIncreaseBlocked: boolean;
  newlyIngestedDedupeKeys: string[];
};

const PAYLOAD_KEYS = [
  "schemaVersion",
  "experimentId",
  "scopeKey",
  "venue",
  "market",
  "anchorEpoch",
  "ingested",
  "obligations",
  "identityBindings",
  "lineage",
  "unpairedLots",
  "authoritativePairedQuantity",
  "authoritativeGrossProfitUsd",
  "authoritativeCompletedRungs",
  "reconciliationRequired",
  "reconciliationCodes",
  "nextSequence",
] as const;

const INGESTED_KEYS = [
  "dedupeKey",
  "accepted",
  "rejectionCode",
  "exchangeTradeId",
  "exchangeOrderId",
  "clientOrderId",
  "side",
  "levelIndex",
  "incrementalQuantity",
  "price",
  "ingestedAt",
  "ingestSequence",
] as const;

const OBLIGATION_KEYS = [
  "obligationId",
  "sourceDedupeKey",
  "sourceOrderIdentity",
  "sourceSide",
  "sourceLevelIndex",
  "targetSide",
  "targetLevelIndex",
  "authoritativeExecutedQuantity",
  "alreadyRepresentedQuantity",
  "outstandingQuantity",
  "placementQuantity",
  "anchorEpoch",
  "lifecycle",
  "replacementClientOrderId",
  "lastApplyDisposition",
  "retryCount",
  "ingestSequence",
  "createdAt",
  "updatedAt",
] as const;

const BINDING_KEYS = ["clientOrderId", "exchangeOrderId"] as const;
const LINEAGE_KEYS = ["orderKey", "cumulative", "incrementalSum", "originalQuantity"] as const;
const LOT_KEYS = ["side", "levelIndex", "quantity", "sourceDedupeKey"] as const;

const LIFECYCLES: ReplacementObligationLifecycle[] = [
  "OBSERVED",
  "DURABLY_INGESTED",
  "READY",
  "SUBMITTING",
  "SUBMIT_UNKNOWN",
  "CONFIRMED_OPEN",
  "TERMINAL_FILLED_OR_REPLACED",
  "TERMINAL_EDGE_NOOP",
  "RECONCILIATION_REQUIRED",
];

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isSide(value: unknown): value is Side {
  return value === "buy" || value === "sell";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableSide(value: unknown): value is Side | null {
  return value === null || isSide(value);
}

function isNullableInt(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function qtyClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= STRATEGY_QTY_EPS;
}

function qtyPositive(value: number): boolean {
  return Number.isFinite(value) && value > STRATEGY_QTY_EPS;
}

export function strategyLedgerIdentity(p: {
  experimentId: string;
  scopeKey: string;
  venue: string;
  market: string;
  anchorEpoch: number;
}): StrategyLedgerIdentity {
  if (!Number.isSafeInteger(p.anchorEpoch) || p.anchorEpoch < 0) {
    throw new Error("STRATEGY_LEDGER_INVALID_EPOCH");
  }
  return {
    schemaVersion: STRATEGY_LEDGER_SCHEMA_VERSION,
    experimentId: assertSafeExperimentId(p.experimentId),
    scopeKey: String(p.scopeKey ?? ""),
    venue: String(p.venue || "").trim().toLowerCase(),
    market: normalizeExecutionCursorMarket(p.market),
    anchorEpoch: p.anchorEpoch,
  };
}

export function resolveStrategyLedgerPath(p: {
  experimentId: string;
  scopeKey: string;
  venue: string;
  market: string;
  anchorEpoch: number;
  baseDir?: string;
}): string {
  const identity = strategyLedgerIdentity(p);
  const digest = sha256Canonical(identity).slice(0, 32);
  return path.join(experimentDir(p.experimentId, p.baseDir), "strategy-ledgers", `${digest}.json`);
}

export function emptyStrategyLedger(identity: StrategyLedgerIdentity): StrategyLedgerPayload {
  return {
    schemaVersion: STRATEGY_LEDGER_SCHEMA_VERSION,
    experimentId: identity.experimentId,
    scopeKey: identity.scopeKey,
    venue: identity.venue,
    market: identity.market,
    anchorEpoch: identity.anchorEpoch,
    ingested: [],
    obligations: [],
    identityBindings: [],
    lineage: [],
    unpairedLots: [],
    authoritativePairedQuantity: 0,
    authoritativeGrossProfitUsd: 0,
    authoritativeCompletedRungs: 0,
    reconciliationRequired: false,
    reconciliationCodes: [],
    nextSequence: 1,
  };
}

export function isStrategyLedgerPayload(value: unknown): value is StrategyLedgerPayload {
  if (!value || typeof value !== "object") return false;
  const row = value as StrategyLedgerPayload;
  if (!exactKeys(row, PAYLOAD_KEYS)) return false;
  if (row.schemaVersion !== STRATEGY_LEDGER_SCHEMA_VERSION) return false;
  if (typeof row.experimentId !== "string" || typeof row.scopeKey !== "string") return false;
  if (typeof row.venue !== "string" || typeof row.market !== "string") return false;
  if (!Number.isSafeInteger(row.anchorEpoch) || row.anchorEpoch < 0) return false;
  if (!Array.isArray(row.ingested) || !row.ingested.every(isIngestedRow)) return false;
  if (!Array.isArray(row.obligations) || !row.obligations.every(isObligationRow)) return false;
  if (!Array.isArray(row.identityBindings) || !row.identityBindings.every(isBindingRow)) return false;
  if (!Array.isArray(row.lineage) || !row.lineage.every(isLineageRow)) return false;
  if (!Array.isArray(row.unpairedLots) || !row.unpairedLots.every(isLotRow)) return false;
  if (!isFiniteNumber(row.authoritativePairedQuantity) || row.authoritativePairedQuantity < 0) return false;
  if (!isFiniteNumber(row.authoritativeGrossProfitUsd)) return false;
  if (!isFiniteNumber(row.authoritativeCompletedRungs) || row.authoritativeCompletedRungs < 0) return false;
  if (typeof row.reconciliationRequired !== "boolean") return false;
  if (!Array.isArray(row.reconciliationCodes) || !row.reconciliationCodes.every((code) => typeof code === "string")) {
    return false;
  }
  if (!Number.isSafeInteger(row.nextSequence) || row.nextSequence < 1) return false;
  return true;
}

function isIngestedRow(value: unknown): value is IngestedStrategyExecution {
  if (!value || typeof value !== "object" || !exactKeys(value, INGESTED_KEYS)) return false;
  const row = value as IngestedStrategyExecution;
  return (
    typeof row.dedupeKey === "string" &&
    row.dedupeKey.length > 0 &&
    typeof row.accepted === "boolean" &&
    isNullableString(row.rejectionCode) &&
    isNullableString(row.exchangeTradeId) &&
    isNullableString(row.exchangeOrderId) &&
    isNullableString(row.clientOrderId) &&
    isNullableSide(row.side) &&
    isNullableInt(row.levelIndex) &&
    isFiniteNumber(row.incrementalQuantity) &&
    row.incrementalQuantity >= 0 &&
    isFiniteNumber(row.price) &&
    typeof row.ingestedAt === "string" &&
    Number.isSafeInteger(row.ingestSequence)
  );
}

function isObligationRow(value: unknown): value is ReplacementObligationRecord {
  if (!value || typeof value !== "object" || !exactKeys(value, OBLIGATION_KEYS)) return false;
  const row = value as ReplacementObligationRecord;
  const lifecycleOk = LIFECYCLES.includes(row.lifecycle);
  const dispOk =
    row.lastApplyDisposition === null ||
    row.lastApplyDisposition === "CONFIRMED" ||
    row.lastApplyDisposition === "REJECTED" ||
    row.lastApplyDisposition === "UNKNOWN";
  const targetSideOk = row.targetSide === null || isSide(row.targetSide);
  const targetLevelOk = isNullableInt(row.targetLevelIndex);
  return (
    typeof row.obligationId === "string" &&
    typeof row.sourceDedupeKey === "string" &&
    typeof row.sourceOrderIdentity === "string" &&
    isSide(row.sourceSide) &&
    Number.isSafeInteger(row.sourceLevelIndex) &&
    targetSideOk &&
    targetLevelOk &&
    isFiniteNumber(row.authoritativeExecutedQuantity) &&
    isFiniteNumber(row.alreadyRepresentedQuantity) &&
    isFiniteNumber(row.outstandingQuantity) &&
    isFiniteNumber(row.placementQuantity) &&
    Number.isSafeInteger(row.anchorEpoch) &&
    lifecycleOk &&
    isNullableString(row.replacementClientOrderId) &&
    dispOk &&
    Number.isSafeInteger(row.retryCount) &&
    row.retryCount >= 0 &&
    Number.isSafeInteger(row.ingestSequence) &&
    typeof row.createdAt === "string" &&
    typeof row.updatedAt === "string"
  );
}

function isBindingRow(value: unknown): value is StrategyIdentityBinding {
  if (!value || typeof value !== "object" || !exactKeys(value, BINDING_KEYS)) return false;
  const row = value as StrategyIdentityBinding;
  return typeof row.clientOrderId === "string" && row.clientOrderId.length > 0 &&
    typeof row.exchangeOrderId === "string" && row.exchangeOrderId.length > 0;
}

function isLineageRow(value: unknown): value is StrategyLineageEntry {
  if (!value || typeof value !== "object" || !exactKeys(value, LINEAGE_KEYS)) return false;
  const row = value as StrategyLineageEntry;
  return typeof row.orderKey === "string" && isFiniteNumber(row.cumulative) && isFiniteNumber(row.incrementalSum) &&
    isFiniteNumber(row.originalQuantity) && row.originalQuantity >= 0;
}

function isLotRow(value: unknown): value is UnpairedExecutionLot {
  if (!value || typeof value !== "object" || !exactKeys(value, LOT_KEYS)) return false;
  const row = value as UnpairedExecutionLot;
  return isSide(row.side) && Number.isSafeInteger(row.levelIndex) && isFiniteNumber(row.quantity) &&
    typeof row.sourceDedupeKey === "string";
}

function cloneLedger(ledger: StrategyLedgerPayload): StrategyLedgerPayload {
  return structuredClone(ledger);
}

function latchRecon(ledger: StrategyLedgerPayload, code: string): void {
  ledger.reconciliationRequired = true;
  if (!ledger.reconciliationCodes.includes(code)) ledger.reconciliationCodes.push(code);
}

function ingestedHas(ledger: StrategyLedgerPayload, dedupeKey: string): boolean {
  return ledger.ingested.some((row) => row.dedupeKey === dedupeKey);
}

function lineageMap(ledger: StrategyLedgerPayload): Map<string, StrategyLineageEntry> {
  return new Map(ledger.lineage.map((row) => [row.orderKey, row]));
}

function setLineage(ledger: StrategyLedgerPayload, entry: StrategyLineageEntry): void {
  const idx = ledger.lineage.findIndex((row) => row.orderKey === entry.orderKey);
  if (idx >= 0) ledger.lineage[idx] = entry;
  else ledger.lineage.push(entry);
}

export function loadStrategyLedger(p: {
  path: string;
  identity: StrategyLedgerIdentity;
  options?: StorageOptions;
}): StrategyLedgerLoad {
  const inspected = inspectChecksummedEnvelopeV2(p.path, {
    kind: STRATEGY_LEDGER_KIND,
    experimentId: p.identity.experimentId,
    scopeKey: p.identity.scopeKey,
    validatePayload: isStrategyLedgerPayload,
  }, p.options);
  if (inspected.condition === "MISSING") {
    return { condition: "MISSING", ledger: emptyStrategyLedger(p.identity) };
  }
  if (inspected.condition !== "VALID" || !inspected.envelope) {
    const condition = inspected.condition === "VALID" ? "CORRUPT" : inspected.condition;
    return { condition, diagnosticCode: inspected.diagnosticCode || condition };
  }
  const payload = inspected.envelope.payload;
  if (
    payload.venue !== p.identity.venue ||
    payload.market !== p.identity.market ||
    payload.anchorEpoch !== p.identity.anchorEpoch ||
    payload.schemaVersion !== p.identity.schemaVersion
  ) {
    return { condition: "IDENTITY_MISMATCH", diagnosticCode: "STRATEGY_LEDGER_IDENTITY_MISMATCH" };
  }
  return { condition: "VALID", ledger: payload, envelope: inspected.envelope };
}

export function persistStrategyLedger(p: {
  path: string;
  identity: StrategyLedgerIdentity;
  ledger: StrategyLedgerPayload;
  predecessor?: ChecksummedEnvelopeV2<StrategyLedgerPayload> | null;
  options?: StorageOptions;
}): { proven: boolean; envelope: ChecksummedEnvelopeV2<StrategyLedgerPayload> | null; diagnosticCode: string | null } {
  try {
    if (!isStrategyLedgerPayload(p.ledger)) {
      return { proven: false, envelope: null, diagnosticCode: "STRATEGY_LEDGER_PAYLOAD_INVALID" };
    }
    if (
      p.ledger.experimentId !== p.identity.experimentId ||
      p.ledger.scopeKey !== p.identity.scopeKey ||
      p.ledger.venue !== p.identity.venue ||
      p.ledger.market !== p.identity.market ||
      p.ledger.anchorEpoch !== p.identity.anchorEpoch
    ) {
      return { proven: false, envelope: null, diagnosticCode: "STRATEGY_LEDGER_IDENTITY_MISMATCH" };
    }
    const writtenAt = new Date().toISOString();
    const envelope = createChecksummedEnvelopeV2({
      kind: STRATEGY_LEDGER_KIND,
      experimentId: p.identity.experimentId,
      scopeKey: p.identity.scopeKey,
      storeGeneration: (p.predecessor?.storeGeneration || 0) + 1,
      leaseGeneration: p.predecessor?.leaseGeneration ?? null,
      createdAt: p.predecessor?.createdAt || writtenAt,
      writtenAt,
      previousEnvelopeSha256: p.predecessor?.envelopeSha256 || null,
      payload: p.ledger,
    });
    const serialized = serializeChecksummedEnvelopeV2(envelope);
    atomicWriteFile(p.path, serialized, p.options);
    const readback = inspectChecksummedEnvelopeV2(p.path, {
      kind: STRATEGY_LEDGER_KIND,
      experimentId: p.identity.experimentId,
      scopeKey: p.identity.scopeKey,
      validatePayload: isStrategyLedgerPayload,
    }, p.options);
    if (readback.condition !== "VALID" || !readback.envelope || !readback.raw) {
      return { proven: false, envelope: null, diagnosticCode: readback.diagnosticCode || "STRATEGY_LEDGER_READBACK_UNPROVEN" };
    }
    if (readback.raw !== serialized) {
      return { proven: false, envelope: null, diagnosticCode: "STRATEGY_LEDGER_READBACK_MISMATCH" };
    }
    if (readback.envelope.envelopeSha256 !== envelope.envelopeSha256) {
      return { proven: false, envelope: null, diagnosticCode: "STRATEGY_LEDGER_READBACK_HASH_MISMATCH" };
    }
    if (sha256Canonical(readback.envelope.payload) !== sha256Canonical(p.ledger)) {
      return { proven: false, envelope: null, diagnosticCode: "STRATEGY_LEDGER_READBACK_PAYLOAD_MISMATCH" };
    }
    return { proven: true, envelope: readback.envelope, diagnosticCode: null };
  } catch {
    return { proven: false, envelope: null, diagnosticCode: "STRATEGY_LEDGER_DURABILITY_UNPROVEN" };
  }
}

function registerBinding(ledger: StrategyLedgerPayload, clientOrderId: string, exchangeOrderId: string): string | null {
  const cid = clientOrderId.trim();
  const ex = exchangeOrderId.trim();
  if (!cid || !ex) return null;
  const byCid = ledger.identityBindings.find((row) => row.clientOrderId === cid);
  const byEx = ledger.identityBindings.find((row) => row.exchangeOrderId === ex);
  if (byCid && byCid.exchangeOrderId !== ex) return "ALIAS_CONFLICT";
  if (byEx && byEx.clientOrderId !== cid) return "ALIAS_CONFLICT";
  if (!byCid && !byEx) ledger.identityBindings.push({ clientOrderId: cid, exchangeOrderId: ex });
  return null;
}

export function registerSnapshotIdentities(ledger: StrategyLedgerPayload, openOrders: LiveOrder[]): string | null {
  for (const order of openOrders) {
    const cid = String(order.clientOrderId || "").trim();
    const ex = String(order.exchangeOrderId || order.id || "").trim();
    if (!cid || !ex) continue;
    const conflict = registerBinding(ledger, cid, ex);
    if (conflict) return conflict;
  }
  return null;
}

function resolveClientOrderId(
  ledger: StrategyLedgerPayload,
  record: ExecutionRecord,
  ownershipPrefix: string,
): { clientOrderId: string } | { code: string } {
  const cid = String(record.clientOrderId || "").trim();
  const ex = String(record.exchangeOrderId || "").trim();
  if (cid) {
    if (ownershipPrefix && !cid.startsWith(ownershipPrefix)) {
      return { code: "MALFORMED_OWNERSHIP_PREFIX" };
    }
    if (ex) {
      const conflict = registerBinding(ledger, cid, ex);
      if (conflict) return { code: conflict };
    }
    return { clientOrderId: cid };
  }
  if (!ex) return { code: "UNKNOWN_ORDER_IDENTITY" };
  const matches = ledger.identityBindings.filter((row) => row.exchangeOrderId === ex);
  if (matches.length === 1) {
    const mapped = matches[0]!.clientOrderId;
    if (ownershipPrefix && !mapped.startsWith(ownershipPrefix)) {
      return { code: "MALFORMED_OWNERSHIP_PREFIX" };
    }
    return { clientOrderId: mapped };
  }
  if (matches.length > 1) return { code: "ALIAS_CONFLICT" };
  return { code: "UNKNOWN_ORDER_IDENTITY" };
}

function resolveOriginalQuantity(
  record: ExecutionRecord,
  priorOriginal: number,
): { original: number } | { code: string } {
  const rem = record.remainingQuantity;
  const cum = record.cumulativeFilledQuantity;
  if (rem !== undefined && (!Number.isFinite(rem) || rem < 0)) return { code: "NON_FINITE_FIELDS" };
  let original = priorOriginal;
  if (cum !== undefined && rem !== undefined) {
    const implied = cum + rem;
    if (original > STRATEGY_QTY_EPS && implied + STRATEGY_QTY_EPS < original) {
      return { code: "QUANTITY_CONFLICT" };
    }
    if (original <= STRATEGY_QTY_EPS) original = implied;
  }
  if (cum !== undefined && original > STRATEGY_QTY_EPS && cum > original + STRATEGY_QTY_EPS) {
    return { code: "CUMULATIVE_EXCEEDS_ORIGINAL" };
  }
  return { original };
}

function resolveIncremental(
  record: ExecutionRecord,
  prior: StrategyLineageEntry | undefined,
): { incremental: number; next: StrategyLineageEntry } | { code: string } {
  const qty = record.quantity;
  if (!Number.isFinite(qty) || !(qty > 0)) return { code: "NON_FINITE_FIELDS" };
  const prev = prior ?? { orderKey: "", cumulative: 0, incrementalSum: 0, originalQuantity: 0 };
  const originalResolved = resolveOriginalQuantity(record, prev.originalQuantity);
  if ("code" in originalResolved) return originalResolved;
  const cum = record.cumulativeFilledQuantity;
  if (cum !== undefined) {
    if (!Number.isFinite(cum) || cum < 0) return { code: "NON_FINITE_FIELDS" };
    if (cum + STRATEGY_QTY_EPS < prev.cumulative) return { code: "CUMULATIVE_REGRESSION" };
    const delta = cum - prev.cumulative;
    let incremental: number;
    if (qtyClose(qty, delta)) incremental = qty;
    else if (qtyClose(qty, cum) && prev.incrementalSum <= STRATEGY_QTY_EPS && prev.cumulative <= STRATEGY_QTY_EPS) {
      incremental = qty;
    } else if (delta > STRATEGY_QTY_EPS && qtyClose(prev.incrementalSum + qty, cum)) {
      incremental = qty;
    } else {
      return { code: "QUANTITY_CONFLICT" };
    }
    if (!qtyPositive(incremental)) return { code: "QUANTITY_CONFLICT" };
    if (prev.incrementalSum + incremental > cum + STRATEGY_QTY_EPS) return { code: "QUANTITY_CONFLICT" };
    return {
      incremental,
      next: {
        orderKey: prev.orderKey,
        cumulative: cum,
        incrementalSum: prev.incrementalSum + incremental,
        originalQuantity: originalResolved.original,
      },
    };
  }
  return {
    incremental: qty,
    next: {
      orderKey: prev.orderKey,
      cumulative: prev.cumulative + qty,
      incrementalSum: prev.incrementalSum + qty,
      originalQuantity: originalResolved.original,
    },
  };
}

function replacementClientOrderId(p: {
  ownershipPrefix: string;
  epoch: number;
  side: Side;
  levelIndex: number;
  obligationId: string;
}): string {
  const token = sha256Canonical(p.obligationId).slice(0, 16);
  return `${p.ownershipPrefix}${p.epoch}-${p.side}-${p.levelIndex}-r-${token}`;
}

function pairLots(
  ledger: StrategyLedgerPayload,
  side: Side,
  levelIndex: number,
  quantity: number,
  spacing: number,
  sizeBase: number,
  sourceDedupeKey: string,
): void {
  let remaining = quantity;
  const opposite: Side = side === "buy" ? "sell" : "buy";
  const oppositeLevel = side === "buy" ? levelIndex + 1 : levelIndex - 1;
  for (const lot of ledger.unpairedLots) {
    if (remaining <= STRATEGY_QTY_EPS) break;
    if (lot.side !== opposite || lot.levelIndex !== oppositeLevel) continue;
    const matched = Math.min(lot.quantity, remaining);
    if (matched <= STRATEGY_QTY_EPS) continue;
    lot.quantity -= matched;
    remaining -= matched;
    ledger.authoritativePairedQuantity += matched;
    ledger.authoritativeGrossProfitUsd += spacing * matched;
    if (sizeBase > 0) ledger.authoritativeCompletedRungs += matched / sizeBase;
  }
  ledger.unpairedLots = ledger.unpairedLots.filter((lot) => lot.quantity > STRATEGY_QTY_EPS);
  if (remaining > STRATEGY_QTY_EPS) {
    ledger.unpairedLots.push({
      side,
      levelIndex,
      quantity: remaining,
      sourceDedupeKey,
    });
  }
}

function appendIngested(ledger: StrategyLedgerPayload, row: Omit<IngestedStrategyExecution, "ingestSequence" | "ingestedAt">, now: string): void {
  ledger.ingested.push({
    ...row,
    ingestedAt: now,
    ingestSequence: ledger.nextSequence,
  });
  ledger.nextSequence += 1;
}

function ingestRecord(p: {
  ledger: StrategyLedgerPayload;
  identity: StrategyLedgerIdentity;
  record: ExecutionRecord;
  ownershipPrefix: string;
  levels: number[];
  spacing: number;
  sizeBase: number;
  mode: GridMode;
  now: string;
}): void {
  const { ledger, identity, record } = p;
  if (ingestedHas(ledger, record.dedupeKey)) return;
  const reject = (code: string) => {
    latchRecon(ledger, code);
    appendIngested(ledger, {
      dedupeKey: record.dedupeKey,
      accepted: false,
      rejectionCode: code,
      exchangeTradeId: record.exchangeTradeId ?? null,
      exchangeOrderId: record.exchangeOrderId ?? null,
      clientOrderId: record.clientOrderId ?? null,
      side: isSide(record.side) ? record.side : null,
      levelIndex: null,
      incrementalQuantity: 0,
      price: Number.isFinite(record.price) ? record.price : 0,
    }, p.now);
  };

  if (record.source !== "exchange" || record.authoritative !== true) {
    reject("NOT_AUTHORITATIVE");
    return;
  }
  if (!record.dedupeKey || typeof record.dedupeKey !== "string") {
    reject("MALFORMED_IDENTITY");
    return;
  }
  if (String(record.venue || "").trim().toLowerCase() !== identity.venue) {
    reject("WRONG_VENUE");
    return;
  }
  if (normalizeExecutionCursorMarket(record.market) !== identity.market) {
    reject("WRONG_MARKET");
    return;
  }
  if (!Number.isFinite(record.quantity) || !(record.quantity > 0) || !Number.isFinite(record.price) || !(record.price > 0)) {
    reject("NON_FINITE_FIELDS");
    return;
  }

  const resolved = resolveClientOrderId(ledger, record, p.ownershipPrefix);
  if ("code" in resolved) {
    reject(resolved.code);
    return;
  }
  const parsed = parseOwnedClientOrderId(resolved.clientOrderId, p.ownershipPrefix);
  if (!parsed) {
    const owned = resolved.clientOrderId.startsWith(p.ownershipPrefix);
    reject(owned ? "MALFORMED_OWNERSHIP_PREFIX" : "UNKNOWN_ORDER_IDENTITY");
    return;
  }
  if (parsed.epoch !== identity.anchorEpoch) {
    reject("STALE_ANCHOR_EPOCH");
    return;
  }
  if (parsed.side !== record.side) {
    reject("SIDE_CONFLICT");
    return;
  }
  const matchedLevel = matchLevelIndex(record.price, p.levels, p.spacing);
  if (matchedLevel !== parsed.levelIndex) {
    const expectedPrice = p.levels[parsed.levelIndex];
    if (expectedPrice == null || Math.abs(record.price - expectedPrice) > p.spacing * PLANNER_PRICE_TOLERANCE_SPACING_FRAC) {
      reject("LEVEL_AMBIGUITY");
      return;
    }
  }

  const orderKey = `${identity.venue}|${identity.market}|${resolved.clientOrderId}`;
  const prior = lineageMap(ledger).get(orderKey);
  const incremental = resolveIncremental(record, prior ? { ...prior, orderKey } : undefined);
  if ("code" in incremental) {
    reject(incremental.code);
    return;
  }
  incremental.next.orderKey = orderKey;
  setLineage(ledger, incremental.next);

  const target = replacementFor(
    { side: parsed.side, levelIndex: parsed.levelIndex },
    p.levels,
    p.mode,
  );
  const seq = ledger.nextSequence;
  appendIngested(ledger, {
    dedupeKey: record.dedupeKey,
    accepted: true,
    rejectionCode: null,
    exchangeTradeId: record.exchangeTradeId ?? null,
    exchangeOrderId: record.exchangeOrderId ?? null,
    clientOrderId: resolved.clientOrderId,
    side: parsed.side,
    levelIndex: parsed.levelIndex,
    incrementalQuantity: incremental.incremental,
    price: record.price,
  }, p.now);

  const obligationId = `ex:${record.dedupeKey}`;
  if (ledger.obligations.some((row) => row.obligationId === obligationId || row.sourceDedupeKey === record.dedupeKey)) {
    return;
  }

  pairLots(ledger, parsed.side, parsed.levelIndex, incremental.incremental, p.spacing, p.sizeBase, record.dedupeKey);

  if (!target) {
    ledger.obligations.push({
      obligationId,
      sourceDedupeKey: record.dedupeKey,
      sourceOrderIdentity: resolved.clientOrderId,
      sourceSide: parsed.side,
      sourceLevelIndex: parsed.levelIndex,
      targetSide: null,
      targetLevelIndex: null,
      authoritativeExecutedQuantity: incremental.incremental,
      alreadyRepresentedQuantity: incremental.incremental,
      outstandingQuantity: 0,
      placementQuantity: 0,
      anchorEpoch: identity.anchorEpoch,
      lifecycle: "TERMINAL_EDGE_NOOP",
      replacementClientOrderId: null,
      lastApplyDisposition: null,
      retryCount: 0,
      ingestSequence: seq,
      createdAt: p.now,
      updatedAt: p.now,
    });
    return;
  }

  const cid = replacementClientOrderId({
    ownershipPrefix: p.ownershipPrefix,
    epoch: identity.anchorEpoch,
    side: target.side,
    levelIndex: target.levelIndex,
    obligationId,
  });
  if (ledger.obligations.some((row) => row.replacementClientOrderId === cid)) {
    latchRecon(ledger, "CLIENT_ORDER_ID_COLLISION");
    ledger.obligations.push({
      obligationId,
      sourceDedupeKey: record.dedupeKey,
      sourceOrderIdentity: resolved.clientOrderId,
      sourceSide: parsed.side,
      sourceLevelIndex: parsed.levelIndex,
      targetSide: target.side,
      targetLevelIndex: target.levelIndex,
      authoritativeExecutedQuantity: incremental.incremental,
      alreadyRepresentedQuantity: 0,
      outstandingQuantity: incremental.incremental,
      placementQuantity: incremental.incremental,
      anchorEpoch: identity.anchorEpoch,
      lifecycle: "RECONCILIATION_REQUIRED",
      replacementClientOrderId: null,
      lastApplyDisposition: null,
      retryCount: 0,
      ingestSequence: seq,
      createdAt: p.now,
      updatedAt: p.now,
    });
    return;
  }
  if (incremental.incremental > record.quantity + STRATEGY_QTY_EPS) {
    latchRecon(ledger, "QUANTITY_CONFLICT");
    return;
  }

  ledger.obligations.push({
    obligationId,
    sourceDedupeKey: record.dedupeKey,
    sourceOrderIdentity: resolved.clientOrderId,
    sourceSide: parsed.side,
    sourceLevelIndex: parsed.levelIndex,
    targetSide: target.side,
    targetLevelIndex: target.levelIndex,
    authoritativeExecutedQuantity: incremental.incremental,
    alreadyRepresentedQuantity: 0,
    outstandingQuantity: incremental.incremental,
    placementQuantity: incremental.incremental,
    anchorEpoch: identity.anchorEpoch,
    lifecycle: "READY",
    replacementClientOrderId: cid,
    lastApplyDisposition: null,
    retryCount: 0,
    ingestSequence: seq,
    createdAt: p.now,
    updatedAt: p.now,
  });
}

export function ingestAuthoritativeDrain(p: {
  path: string;
  identity: StrategyLedgerIdentity;
  drain: Pick<ExecutionJournalDrain, "authoritativeExecutions" | "faults" | "authority">;
  ownershipPrefix: string;
  levels: number[];
  spacing: number;
  sizeBase: number;
  mode: GridMode;
  openOrders?: LiveOrder[];
  now?: string;
  options?: StorageOptions;
}): StrategyIngestResult {
  const loaded = loadStrategyLedger({ path: p.path, identity: p.identity, options: p.options });
  if (loaded.condition !== "MISSING" && loaded.condition !== "VALID") {
    return {
      proven: false,
      ledger: null,
      diagnosticCode: loaded.diagnosticCode,
      ackEligibleDedupeKeys: [],
      riskIncreaseBlocked: true,
      newlyIngestedDedupeKeys: [],
    };
  }
  const predecessor = loaded.condition === "VALID" ? loaded.envelope : null;
  const ledger = cloneLedger(loaded.ledger);
  const now = p.now || new Date().toISOString();
  const beforeKeys = new Set(ledger.ingested.map((row) => row.dedupeKey));

  if (p.drain.authority !== "trusted") latchRecon(ledger, "AUTHORITY_INVALIDATED");
  for (const fault of p.drain.faults) {
    latchRecon(ledger, fault.code);
  }
  const snapshotConflict = registerSnapshotIdentities(ledger, p.openOrders || []);
  if (snapshotConflict) latchRecon(ledger, snapshotConflict);

  const authoritative = Array.isArray(p.drain.authoritativeExecutions) ? p.drain.authoritativeExecutions : [];
  for (const record of authoritative) {
    ingestRecord({
      ledger,
      identity: p.identity,
      record,
      ownershipPrefix: p.ownershipPrefix,
      levels: p.levels,
      spacing: p.spacing,
      sizeBase: p.sizeBase,
      mode: p.mode,
      now,
    });
  }

  const persisted = persistStrategyLedger({
    path: p.path,
    identity: p.identity,
    ledger,
    predecessor,
    options: p.options,
  });
  if (!persisted.proven) {
    return {
      proven: false,
      ledger: loaded.condition === "VALID" || loaded.condition === "MISSING" ? loaded.ledger : null,
      diagnosticCode: persisted.diagnosticCode,
      ackEligibleDedupeKeys: loaded.condition === "VALID"
        ? loaded.ledger.ingested.map((row) => row.dedupeKey)
        : [],
      riskIncreaseBlocked: true,
      newlyIngestedDedupeKeys: [],
    };
  }
  const newlyIngestedDedupeKeys = ledger.ingested
    .filter((row) => !beforeKeys.has(row.dedupeKey))
    .map((row) => row.dedupeKey);
  return {
    proven: true,
    ledger,
    diagnosticCode: ledger.reconciliationRequired ? ledger.reconciliationCodes[0] || "RECONCILIATION_REQUIRED" : null,
    ackEligibleDedupeKeys: ledger.ingested.map((row) => row.dedupeKey),
    riskIncreaseBlocked: ledger.reconciliationRequired,
    newlyIngestedDedupeKeys,
  };
}

export function plannerObligationsFromLedger(ledger: StrategyLedgerPayload): PlannerReplacementObligation[] {
  const out: PlannerReplacementObligation[] = [];
  for (const row of ledger.obligations) {
    if (row.targetSide == null || row.targetLevelIndex == null || !row.replacementClientOrderId) continue;
    if (row.lifecycle !== "READY") continue;
    if (row.retryCount >= STRATEGY_REPLACEMENT_MAX_RETRIES) continue;
    if (!qtyPositive(row.outstandingQuantity)) continue;
    if (row.outstandingQuantity > row.authoritativeExecutedQuantity + STRATEGY_QTY_EPS) continue;
    out.push({
      obligationId: row.obligationId,
      sourceDedupeKey: row.sourceDedupeKey,
      targetSide: row.targetSide,
      targetLevelIndex: row.targetLevelIndex,
      outstandingQuantity: row.outstandingQuantity,
      placementQuantity: row.placementQuantity,
      replacementClientOrderId: row.replacementClientOrderId,
      lifecycle: row.lifecycle,
    });
  }
  return out;
}

export function replacementSizeByClientOrderId(ledger: StrategyLedgerPayload): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of ledger.obligations) {
    if (!row.replacementClientOrderId) continue;
    out[row.replacementClientOrderId] = row.placementQuantity;
  }
  return out;
}

export function markObligationsSubmitting(p: {
  path: string;
  identity: StrategyLedgerIdentity;
  clientOrderIds: string[];
  now?: string;
  options?: StorageOptions;
}): StrategyIngestResult {
  const loaded = loadStrategyLedger({ path: p.path, identity: p.identity, options: p.options });
  if (loaded.condition !== "VALID" && loaded.condition !== "MISSING") {
    return {
      proven: false,
      ledger: null,
      diagnosticCode: loaded.diagnosticCode,
      ackEligibleDedupeKeys: [],
      riskIncreaseBlocked: true,
      newlyIngestedDedupeKeys: [],
    };
  }
  if (p.clientOrderIds.length === 0) {
    return {
      proven: true,
      ledger: loaded.ledger,
      diagnosticCode: null,
      ackEligibleDedupeKeys: loaded.ledger.ingested.map((row) => row.dedupeKey),
      riskIncreaseBlocked: loaded.ledger.reconciliationRequired,
      newlyIngestedDedupeKeys: [],
    };
  }
  const ledger = cloneLedger(loaded.ledger);
  const now = p.now || new Date().toISOString();
  const want = new Set(p.clientOrderIds);
  for (const row of ledger.obligations) {
    if (!row.replacementClientOrderId || !want.has(row.replacementClientOrderId)) continue;
    if (row.lifecycle !== "READY") continue;
    row.lifecycle = "SUBMITTING";
    row.updatedAt = now;
  }
  const predecessor = loaded.condition === "VALID" ? loaded.envelope : null;
  const persisted = persistStrategyLedger({
    path: p.path,
    identity: p.identity,
    ledger,
    predecessor,
    options: p.options,
  });
  if (!persisted.proven) {
    return {
      proven: false,
      ledger: loaded.ledger,
      diagnosticCode: persisted.diagnosticCode,
      ackEligibleDedupeKeys: loaded.ledger.ingested.map((row) => row.dedupeKey),
      riskIncreaseBlocked: true,
      newlyIngestedDedupeKeys: [],
    };
  }
  return {
    proven: true,
    ledger,
    diagnosticCode: null,
    ackEligibleDedupeKeys: ledger.ingested.map((row) => row.dedupeKey),
    riskIncreaseBlocked: ledger.reconciliationRequired,
    newlyIngestedDedupeKeys: [],
  };
}

function observedReplacement(order: LiveOrder, cid: string, size: number, market: string): boolean {
  if (String(order.clientOrderId || "").trim() !== cid) return false;
  if (normalizeExecutionCursorMarket(order.market) !== normalizeExecutionCursorMarket(market)) return false;
  return qtyClose(Number(order.size), size);
}

export function applyReplacementDispositions(p: {
  path: string;
  identity: StrategyLedgerIdentity;
  applyResult: ApplyResult;
  placedClientOrderIds: string[];
  openOrders: LiveOrder[];
  now?: string;
  options?: StorageOptions;
  persistConfirmedBeforeTerminal?: boolean;
}): StrategyIngestResult {
  const loaded = loadStrategyLedger({ path: p.path, identity: p.identity, options: p.options });
  if (loaded.condition !== "VALID" && loaded.condition !== "MISSING") {
    return {
      proven: false,
      ledger: null,
      diagnosticCode: loaded.diagnosticCode,
      ackEligibleDedupeKeys: [],
      riskIncreaseBlocked: true,
      newlyIngestedDedupeKeys: [],
    };
  }
  const ledger = cloneLedger(loaded.ledger);
  const now = p.now || new Date().toISOString();
  const placed = new Set(p.placedClientOrderIds);
  const ambiguous = Boolean(p.applyResult.ambiguous);
  const rejected = !ambiguous && (p.applyResult.failed > 0 || p.applyResult.errors.length > 0);

  const applyOne = (phase: "confirm" | "terminal") => {
    for (const row of ledger.obligations) {
      if (!row.replacementClientOrderId) continue;
      const cid = row.replacementClientOrderId;
      const observed = p.openOrders.some((order) =>
        observedReplacement(order, cid, row.placementQuantity, p.identity.market)
      );
      if (row.lifecycle === "SUBMITTING" || row.lifecycle === "SUBMIT_UNKNOWN" || row.lifecycle === "CONFIRMED_OPEN") {
        if (observed) {
          if (phase === "confirm" && row.lifecycle !== "CONFIRMED_OPEN") {
            row.lifecycle = "CONFIRMED_OPEN";
            row.lastApplyDisposition = "CONFIRMED";
            row.alreadyRepresentedQuantity = row.placementQuantity;
            row.outstandingQuantity = 0;
            row.updatedAt = now;
          }
          if (phase === "terminal") {
            row.lifecycle = "TERMINAL_FILLED_OR_REPLACED";
            row.lastApplyDisposition = "CONFIRMED";
            row.alreadyRepresentedQuantity = row.placementQuantity;
            row.outstandingQuantity = 0;
            row.updatedAt = now;
          }
          continue;
        }
        if (phase !== "confirm") continue;
        if (!placed.has(cid) && row.lifecycle === "CONFIRMED_OPEN") continue;
        if (row.lifecycle === "SUBMITTING" || (row.lifecycle === "SUBMIT_UNKNOWN" && placed.has(cid))) {
          if (ambiguous) {
            row.lifecycle = "SUBMIT_UNKNOWN";
            row.lastApplyDisposition = "UNKNOWN";
            row.updatedAt = now;
          } else if (rejected) {
            row.lifecycle = "READY";
            row.lastApplyDisposition = "REJECTED";
            row.retryCount += 1;
            row.updatedAt = now;
            if (row.retryCount >= STRATEGY_REPLACEMENT_MAX_RETRIES) {
              row.lifecycle = "RECONCILIATION_REQUIRED";
              latchRecon(ledger, "REPLACEMENT_RETRY_EXHAUSTED");
            }
          } else {
            row.lifecycle = "SUBMIT_UNKNOWN";
            row.lastApplyDisposition = "UNKNOWN";
            row.updatedAt = now;
          }
        }
      }
    }
  };

  applyOne("confirm");
  const predecessor = loaded.condition === "VALID" ? loaded.envelope : null;
  if (p.persistConfirmedBeforeTerminal) {
    const mid = persistStrategyLedger({
      path: p.path,
      identity: p.identity,
      ledger,
      predecessor,
      options: p.options,
    });
    if (!mid.proven) {
      return {
        proven: false,
        ledger: loaded.ledger,
        diagnosticCode: mid.diagnosticCode,
        ackEligibleDedupeKeys: loaded.ledger.ingested.map((row) => row.dedupeKey),
        riskIncreaseBlocked: true,
        newlyIngestedDedupeKeys: [],
      };
    }
    applyOne("terminal");
    const fin = persistStrategyLedger({
      path: p.path,
      identity: p.identity,
      ledger,
      predecessor: mid.envelope,
      options: p.options,
    });
    if (!fin.proven) {
      return {
        proven: false,
        ledger: mid.envelope?.payload || ledger,
        diagnosticCode: fin.diagnosticCode,
        ackEligibleDedupeKeys: ledger.ingested.map((row) => row.dedupeKey),
        riskIncreaseBlocked: true,
        newlyIngestedDedupeKeys: [],
      };
    }
    return {
      proven: true,
      ledger,
      diagnosticCode: null,
      ackEligibleDedupeKeys: ledger.ingested.map((row) => row.dedupeKey),
      riskIncreaseBlocked: ledger.reconciliationRequired,
      newlyIngestedDedupeKeys: [],
    };
  }

  applyOne("terminal");
  const persisted = persistStrategyLedger({
    path: p.path,
    identity: p.identity,
    ledger,
    predecessor,
    options: p.options,
  });
  if (!persisted.proven) {
    return {
      proven: false,
      ledger: loaded.ledger,
      diagnosticCode: persisted.diagnosticCode,
      ackEligibleDedupeKeys: loaded.ledger.ingested.map((row) => row.dedupeKey),
      riskIncreaseBlocked: true,
      newlyIngestedDedupeKeys: [],
    };
  }
  return {
    proven: true,
    ledger,
    diagnosticCode: null,
    ackEligibleDedupeKeys: ledger.ingested.map((row) => row.dedupeKey),
    riskIncreaseBlocked: ledger.reconciliationRequired,
    newlyIngestedDedupeKeys: [],
  };
}

export function reconcileUnknownReplacements(p: {
  path: string;
  identity: StrategyLedgerIdentity;
  openOrders: LiveOrder[];
  now?: string;
  options?: StorageOptions;
}): StrategyIngestResult {
  return applyReplacementDispositions({
    path: p.path,
    identity: p.identity,
    applyResult: { placed: 0, cancelled: 0, failed: 0, errors: [] },
    placedClientOrderIds: [],
    openOrders: p.openOrders,
    now: p.now,
    options: p.options,
  });
}

export function authoritativeMetrics(ledger: StrategyLedgerPayload): {
  pairedQuantity: number;
  grossProfitUsd: number;
  completedRungs: number;
  feeBasis: "gross";
} {
  return {
    pairedQuantity: ledger.authoritativePairedQuantity,
    grossProfitUsd: ledger.authoritativeGrossProfitUsd,
    completedRungs: ledger.authoritativeCompletedRungs,
    feeBasis: "gross",
  };
}

export function plannerFilledFromLedger(ledger: StrategyLedgerPayload): Array<{
  side: Side;
  levelIndex: number;
  price: number;
  quantity: number;
}> {
  const out: Array<{ side: Side; levelIndex: number; price: number; quantity: number }> = [];
  for (const row of ledger.ingested) {
    if (!row.accepted || row.side == null || row.levelIndex == null) continue;
    out.push({
      side: row.side,
      levelIndex: row.levelIndex,
      price: row.price,
      quantity: row.incrementalQuantity,
    });
  }
  return out;
}

export type { VenueId };
