import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Intent, LiveOrder } from "./types.js";
import {
  assertSafeExperimentId,
  atomicWriteFile,
  createChecksummedEnvelopeV2,
  inspectChecksummedEnvelopeV2,
  serializeChecksummedEnvelopeV2,
  sha256Json,
  type ChecksummedEnvelopeV2,
  type EnvelopeInspection,
  type EnvelopeInspectionCondition,
  type StorageOptions,
} from "./experimentStorage.js";

export type RiskDecision = { halt: boolean; reduceOnly: boolean; reasons: string[] };
export type HaltStatus =
  | "RUNNING"
  | "HALTING"
  | "HALTED_UNFLAT"
  | "HALTED_FLAT"
  | "HALT_FAILED";

export type ExperimentRiskLimits = {
  maxGrossNotionalUsd: number;
  dailyLossUsd: number;
  maxDrawdownUsd: number;
  boundaryBufferPct: number;
};

export type RiskMarketInput = {
  mid: number;
  equityUsd: number | null;
  dailyPnlUsd: number | null;
  positionQty: number;
  positionNotionalUsd: number;
  plannedGrossNotionalUsd: number;
  gridLower: number;
  gridUpper: number;
  requireFreshInputs?: boolean;
  snapshotAgeMs?: number | null;
  pnlAgeMs?: number | null;
  maxInputAgeMs?: number;
};

export type ExperimentRiskState = {
  halted: boolean;
  haltStatus: HaltStatus;
  haltId: string | null;
  haltReasons: string[];
  scopeKey: string | null;
  leaseGeneration: string | null;
  startingEquityUsd: number | null;
  highWaterMarkUsd: number | null;
  drawdownFromStartUsd: number;
  drawdownFromHwmUsd: number;
  acknowledged: boolean;
  updatedAt: string;
};

export type RiskStateStoreOptions = StorageOptions & {
  now?: () => Date;
  randomId?: () => string;
};

const RISK_STATE_KIND = "experiment-risk-state";
const UNSCOPED = "UNSCOPED";
const HALT_STATUSES: HaltStatus[] = ["RUNNING", "HALTING", "HALTED_UNFLAT", "HALTED_FLAT", "HALT_FAILED"];

function nowIso(options?: RiskStateStoreOptions): string {
  return (options?.now?.() || new Date()).toISOString();
}

function newHaltId(options?: RiskStateStoreOptions): string {
  return options?.randomId?.() || crypto.randomUUID();
}

export function emptyRiskState(scopeKey: string | null = null): ExperimentRiskState {
  return {
    halted: false,
    haltStatus: "RUNNING",
    haltId: null,
    haltReasons: [],
    scopeKey,
    leaseGeneration: null,
    startingEquityUsd: null,
    highWaterMarkUsd: null,
    drawdownFromStartUsd: 0,
    drawdownFromHwmUsd: 0,
    acknowledged: false,
    updatedAt: new Date().toISOString(),
  };
}

export function experimentDir(experimentId: string, baseDir?: string): string {
  const root = baseDir || path.resolve(process.cwd(), "data", "experiments");
  return path.join(root, assertSafeExperimentId(experimentId));
}

export function riskStatePath(experimentId: string, baseDir?: string): string {
  return path.join(experimentDir(experimentId, baseDir), "risk-state.json");
}

function failClosedState(
  reasons: string | string[],
  scopeKey?: string,
  options?: RiskStateStoreOptions
): ExperimentRiskState {
  return {
    ...emptyRiskState(scopeKey || null),
    halted: true,
    haltStatus: "HALT_FAILED",
    haltId: newHaltId(options),
    haltReasons: Array.from(new Set(Array.isArray(reasons) ? reasons : [reasons])),
    acknowledged: false,
    updatedAt: nowIso(options),
  };
}

function isNullableFinite(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isExperimentRiskState(value: unknown): value is ExperimentRiskState {
  const row = value as Partial<ExperimentRiskState> | null;
  if (!row || typeof row !== "object") return false;
  if (typeof row.halted !== "boolean" || !HALT_STATUSES.includes(row.haltStatus as HaltStatus)) return false;
  if (row.halted === (row.haltStatus === "RUNNING")) return false;
  if (!(row.haltId === null || typeof row.haltId === "string")) return false;
  if (!Array.isArray(row.haltReasons) || !row.haltReasons.every((reason) => typeof reason === "string")) return false;
  if (!(row.scopeKey === null || typeof row.scopeKey === "string")) return false;
  if (!(row.leaseGeneration === null || typeof row.leaseGeneration === "string")) return false;
  if (!isNullableFinite(row.startingEquityUsd) || !isNullableFinite(row.highWaterMarkUsd)) return false;
  if (typeof row.drawdownFromStartUsd !== "number" || !Number.isFinite(row.drawdownFromStartUsd) || row.drawdownFromStartUsd < 0) return false;
  if (typeof row.drawdownFromHwmUsd !== "number" || !Number.isFinite(row.drawdownFromHwmUsd) || row.drawdownFromHwmUsd < 0) return false;
  if (typeof row.acknowledged !== "boolean") return false;
  return typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt));
}

function normalizeLegacyState(raw: any, expectedScope: string | undefined, options: RiskStateStoreOptions): ExperimentRiskState | null {
  if (typeof raw?.halted !== "boolean") return null;
  const rawStatus = String(raw?.haltStatus || "");
  const statusOk = HALT_STATUSES.includes(rawStatus as HaltStatus);
  const legacyHalted = Boolean(raw.halted) || (statusOk && rawStatus !== "RUNNING");
  const state: ExperimentRiskState = {
    ...emptyRiskState(expectedScope || null),
    halted: legacyHalted,
    haltStatus: statusOk ? rawStatus as HaltStatus : legacyHalted ? "HALTED_UNFLAT" : "RUNNING",
    haltId: raw?.haltId ? String(raw.haltId) : legacyHalted ? newHaltId(options) : null,
    haltReasons: Array.isArray(raw?.haltReasons) ? raw.haltReasons.map(String) : [],
    scopeKey: raw?.scopeKey ? String(raw.scopeKey) : expectedScope || null,
    leaseGeneration: raw?.leaseGeneration ? String(raw.leaseGeneration) : null,
    startingEquityUsd: raw?.startingEquityUsd != null && Number.isFinite(Number(raw.startingEquityUsd)) ? Number(raw.startingEquityUsd) : null,
    highWaterMarkUsd: raw?.highWaterMarkUsd != null && Number.isFinite(Number(raw.highWaterMarkUsd)) ? Number(raw.highWaterMarkUsd) : null,
    drawdownFromStartUsd: Math.max(0, Number(raw?.drawdownFromStartUsd) || 0),
    drawdownFromHwmUsd: Math.max(0, Number(raw?.drawdownFromHwmUsd) || 0),
    acknowledged: Boolean(raw?.acknowledged),
    updatedAt: Number.isFinite(Date.parse(String(raw?.updatedAt || ""))) ? String(raw.updatedAt) : nowIso(options),
  };
  if (expectedScope && state.scopeKey && state.scopeKey !== expectedScope) return null;
  return state;
}

function forceHalt(
  state: ExperimentRiskState,
  reason: string,
  expectedScope: string | undefined,
  options: RiskStateStoreOptions
): ExperimentRiskState {
  return {
    ...state,
    halted: true,
    haltStatus: "HALT_FAILED",
    haltId: state.haltId || newHaltId(options),
    haltReasons: Array.from(new Set([...state.haltReasons, reason])),
    scopeKey: expectedScope || state.scopeKey,
    acknowledged: false,
    updatedAt: nowIso(options),
  };
}

function envelopeExpected(experimentId: string, expectedScope?: string) {
  return {
    kind: RISK_STATE_KIND,
    experimentId,
    scopeKey: expectedScope,
    validatePayload: isExperimentRiskState,
  };
}

function inspectRiskCopy(
  filePath: string,
  experimentId: string,
  expectedScope: string | undefined,
  options: RiskStateStoreOptions
): EnvelopeInspection<ExperimentRiskState> {
  const inspected = inspectChecksummedEnvelopeV2(filePath, envelopeExpected(experimentId, expectedScope), options);
  if (inspected.condition === "VALID" && inspected.envelope) {
    const payloadScope = inspected.envelope.payload.scopeKey || UNSCOPED;
    if (
      payloadScope !== inspected.envelope.scopeKey ||
      inspected.envelope.payload.leaseGeneration !== inspected.envelope.leaseGeneration
    ) {
      return {
        condition: "CORRUPT",
        raw: inspected.raw,
        diagnosticCode: "RISK_STATE_ENVELOPE_PAYLOAD_IDENTITY_MISMATCH",
      };
    }
  }
  return inspected;
}

function pairFailureReason(
  primary: ChecksummedEnvelopeV2<ExperimentRiskState>,
  backup: ChecksummedEnvelopeV2<ExperimentRiskState>
): string | null {
  if (backup.storeGeneration > primary.storeGeneration) return "RISK_STATE_BACKUP_NEWER";
  if (backup.storeGeneration === primary.storeGeneration) {
    return backup.envelopeSha256 === primary.envelopeSha256 ? null : "RISK_STATE_GENERATION_HASH_CONFLICT";
  }
  if (backup.storeGeneration !== primary.storeGeneration - 1) return "RISK_STATE_GENERATION_GAP";
  if (primary.previousEnvelopeSha256 !== backup.envelopeSha256) return "RISK_STATE_CHAIN_MISMATCH";
  return null;
}

function copyConditionReason(condition: EnvelopeInspectionCondition, prefix: "PRIMARY" | "BACKUP"): string {
  return `RISK_STATE_${prefix}_${condition}`;
}

function writeEnvelope(filePath: string, envelope: ChecksummedEnvelopeV2<ExperimentRiskState>, options: RiskStateStoreOptions): void {
  atomicWriteFile(filePath, serializeChecksummedEnvelopeV2(envelope), options);
}

function createInitialPair(
  experimentId: string,
  state: ExperimentRiskState,
  baseDir: string | undefined,
  options: RiskStateStoreOptions
): void {
  const primaryPath = riskStatePath(experimentId, baseDir);
  const scopeKey = state.scopeKey || UNSCOPED;
  const writtenAt = nowIso(options);
  const envelope = createChecksummedEnvelopeV2({
    kind: RISK_STATE_KIND,
    experimentId,
    scopeKey,
    storeGeneration: 1,
    leaseGeneration: state.leaseGeneration,
    createdAt: writtenAt,
    writtenAt,
    previousEnvelopeSha256: null,
    payload: state,
  });
  writeEnvelope(primaryPath, envelope, options);
  const verified = inspectRiskCopy(primaryPath, experimentId, scopeKey, options);
  if (verified.condition !== "VALID" || !verified.raw) throw new Error("RISK_STATE_INITIAL_PRIMARY_VERIFY_FAILED");
  atomicWriteFile(`${primaryPath}.bak`, verified.raw, options);
}

export function initializeRiskStateStore(p: {
  experimentId: string;
  baseDir?: string;
  scopeKey?: string;
  leaseGeneration?: string | null;
  options?: RiskStateStoreOptions;
}): ExperimentRiskState {
  const options = p.options || {};
  const primaryPath = riskStatePath(p.experimentId, p.baseDir);
  const storage = options.fileSystem;
  if ((storage?.existsSync(primaryPath) ?? false) || (storage?.existsSync(`${primaryPath}.bak`) ?? false)) {
    throw new Error("RISK_STATE_ALREADY_INITIALIZED");
  }
  if (!storage) {
    const primary = inspectRiskCopy(primaryPath, p.experimentId, p.scopeKey, options);
    const backup = inspectRiskCopy(`${primaryPath}.bak`, p.experimentId, p.scopeKey, options);
    if (primary.condition !== "MISSING" || backup.condition !== "MISSING") throw new Error("RISK_STATE_ALREADY_INITIALIZED");
  }
  const state = failClosedState("INITIAL_RECONCILIATION_REQUIRED", p.scopeKey, options);
  state.leaseGeneration = p.leaseGeneration || null;
  createInitialPair(p.experimentId, state, p.baseDir, options);
  return state;
}

function readLegacyRiskState(
  filePath: string,
  expectedScope: string | undefined,
  options: RiskStateStoreOptions
): ExperimentRiskState | null {
  const storage = options.fileSystem || fs;
  try {
    const rawText = storage.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(rawText);
    let payload = parsed;
    if (parsed?.schema_version === "1") {
      if (parsed.payload == null || parsed.checksum_sha256 !== sha256Json(parsed.payload)) return null;
      payload = parsed.payload;
    }
    return normalizeLegacyState(payload, expectedScope, options);
  } catch {
    return null;
  }
}

export function loadRiskState(
  experimentId: string,
  baseDir?: string,
  expectedScope?: string,
  options: RiskStateStoreOptions = {}
): ExperimentRiskState {
  const primaryPath = riskStatePath(experimentId, baseDir);
  const backupPath = `${primaryPath}.bak`;
  const primary = inspectRiskCopy(primaryPath, experimentId, expectedScope, options);
  const backup = inspectRiskCopy(backupPath, experimentId, expectedScope, options);

  if (primary.condition === "VALID" && primary.envelope && primary.raw) {
    if (backup.condition === "VALID" && backup.envelope) {
      const pairError = pairFailureReason(primary.envelope, backup.envelope);
      if (pairError) return failClosedState(pairError, expectedScope || primary.envelope.scopeKey, options);
    } else if (backup.condition === "MISSING" || backup.condition === "CORRUPT") {
      try {
        atomicWriteFile(backupPath, primary.raw, options);
        const repaired = inspectRiskCopy(backupPath, experimentId, primary.envelope.scopeKey, options);
        if (repaired.condition !== "VALID" || repaired.envelope?.envelopeSha256 !== primary.envelope.envelopeSha256) {
          return failClosedState("RISK_STATE_BACKUP_REPAIR_VERIFY_FAILED", expectedScope || primary.envelope.scopeKey, options);
        }
      } catch {
        return failClosedState("RISK_STATE_BACKUP_REPAIR_FAILED", expectedScope || primary.envelope.scopeKey, options);
      }
    } else {
      return failClosedState(copyConditionReason(backup.condition, "BACKUP"), expectedScope || primary.envelope.scopeKey, options);
    }
    return primary.envelope.payload;
  }

  if (backup.condition === "VALID" && backup.envelope) {
    return forceHalt(
      backup.envelope.payload,
      copyConditionReason(primary.condition, "PRIMARY"),
      expectedScope || backup.envelope.scopeKey,
      options
    );
  }

  const backupCouldBeLegacy = backup.condition === "MISSING" || backup.condition === "CORRUPT";
  const legacy = backupCouldBeLegacy ? readLegacyRiskState(primaryPath, expectedScope, options) : null;
  if (legacy) {
    const migrated = forceHalt(legacy, "RISK_STATE_LEGACY_MIGRATED", expectedScope, options);
    try {
      createInitialPair(experimentId, migrated, baseDir, options);
    } catch {
      return forceHalt(migrated, "RISK_STATE_MIGRATION_PERSIST_FAILED", expectedScope, options);
    }
    return migrated;
  }

  if (primary.condition === "MISSING" && backup.condition === "MISSING") {
    return failClosedState("RISK_STATE_MISSING", expectedScope, options);
  }
  return failClosedState([
    "RISK_STATE_CORRUPT",
    copyConditionReason(primary.condition, "PRIMARY"),
    copyConditionReason(backup.condition, "BACKUP"),
  ], expectedScope, options);
}

export function persistRiskState(
  experimentId: string,
  state: ExperimentRiskState,
  baseDir?: string,
  options: RiskStateStoreOptions = {}
): void {
  if (!isExperimentRiskState(state)) throw new Error("RISK_STATE_PAYLOAD_INVALID");
  const primaryPath = riskStatePath(experimentId, baseDir);
  const backupPath = `${primaryPath}.bak`;
  const scopeKey = state.scopeKey || UNSCOPED;
  const primary = inspectRiskCopy(primaryPath, experimentId, scopeKey, options);
  const backup = inspectRiskCopy(backupPath, experimentId, scopeKey, options);

  if (primary.condition === "MISSING" && backup.condition === "MISSING") {
    // Backward-compatible bootstrap for existing callers is deliberately
    // fail-closed. A RUNNING store can only follow a committed halted store.
    const initial = state.halted
      ? state
      : failClosedState("INITIAL_RECONCILIATION_REQUIRED", state.scopeKey || undefined, options);
    initial.leaseGeneration = state.leaseGeneration;
    createInitialPair(experimentId, initial, baseDir, options);
    return;
  }

  let predecessor: ChecksummedEnvelopeV2<ExperimentRiskState>;
  if (primary.condition === "VALID" && primary.envelope && primary.raw) {
    if (backup.condition === "VALID" && backup.envelope) {
      const pairError = pairFailureReason(primary.envelope, backup.envelope);
      if (pairError) throw new Error(pairError);
    } else if (backup.condition !== "MISSING" && backup.condition !== "CORRUPT") {
      throw new Error(copyConditionReason(backup.condition, "BACKUP"));
    }
    atomicWriteFile(backupPath, primary.raw, options);
    predecessor = primary.envelope;
  } else if (backup.condition === "VALID" && backup.envelope) {
    predecessor = backup.envelope;
  } else {
    throw new Error("RISK_STATE_NO_VALID_PREDECESSOR");
  }

  const writtenAt = nowIso(options);
  const next = createChecksummedEnvelopeV2({
    kind: RISK_STATE_KIND,
    experimentId,
    scopeKey,
    storeGeneration: predecessor.storeGeneration + 1,
    leaseGeneration: state.leaseGeneration,
    createdAt: predecessor.createdAt,
    writtenAt,
    previousEnvelopeSha256: predecessor.envelopeSha256,
    payload: state,
  });
  writeEnvelope(primaryPath, next, options);
}

/** Clear exactly one halt by presenting its unique halt id. Static YES is rejected. */
export function acknowledgeHaltIfRequested(
  experimentId: string,
  state: ExperimentRiskState,
  baseDir?: string
): ExperimentRiskState {
  if (!state.halted) return state;
  const ack = String(process.env.EXPERIMENT_HALT_ACK || "").trim();
  if (!state.haltId || ack !== state.haltId) return state;
  const next: ExperimentRiskState = {
    ...state,
    halted: false,
    haltStatus: "RUNNING",
    haltId: null,
    haltReasons: [],
    acknowledged: true,
    updatedAt: new Date().toISOString(),
  };
  persistRiskState(experimentId, next, baseDir);
  delete process.env.EXPERIMENT_HALT_ACK;
  return next;
}

/** Cancels are not subtracted until a fresh exchange snapshot confirms them gone. */
export function worstCaseGrossNotionalUsd(p: {
  positionQty: number;
  mid: number;
  openOrders?: LiveOrder[];
  intents?: Intent[];
}): number {
  const proposed = (p.intents || [])
    .filter((i): i is Extract<Intent, { type: "place" }> => i.type === "place")
    .map((i) => i.order);
  const rows = [...(p.openOrders || []), ...proposed];
  const buyQty = rows.filter((o) => o.side === "buy").reduce((s, o) => s + Math.max(0, Number(o.size) || 0), 0);
  const sellQty = rows.filter((o) => o.side === "sell").reduce((s, o) => s + Math.max(0, Number(o.size) || 0), 0);
  return Math.max(
    Math.abs(p.positionQty + buyQty),
    Math.abs(p.positionQty - sellQty)
  ) * p.mid;
}

export function evaluateExperimentRisk(
  input: RiskMarketInput,
  limits: ExperimentRiskLimits,
  state: ExperimentRiskState
): { decision: RiskDecision; next: ExperimentRiskState } {
  const reasons: string[] = [];
  let halt = false;
  let reduceOnly = false;
  const next: ExperimentRiskState = { ...state, updatedAt: new Date().toISOString() };
  const maxAge = input.maxInputAgeMs ?? 120_000;

  if (input.requireFreshInputs) {
    if (input.equityUsd == null || !Number.isFinite(input.equityUsd)) { halt = true; reasons.push("EQUITY_UNAVAILABLE"); }
    if (input.dailyPnlUsd == null || !Number.isFinite(input.dailyPnlUsd)) { halt = true; reasons.push("DAILY_PNL_UNAVAILABLE"); }
    if (input.snapshotAgeMs == null || input.snapshotAgeMs > maxAge) { halt = true; reasons.push("SNAPSHOT_STALE"); }
    if (input.pnlAgeMs == null || input.pnlAgeMs > maxAge) { halt = true; reasons.push("DAILY_PNL_STALE"); }
  }
  if (input.equityUsd != null && Number.isFinite(input.equityUsd)) {
    if (next.startingEquityUsd == null) next.startingEquityUsd = input.equityUsd;
    next.highWaterMarkUsd = next.highWaterMarkUsd == null ? input.equityUsd : Math.max(next.highWaterMarkUsd, input.equityUsd);
    next.drawdownFromStartUsd = Math.max(0, next.startingEquityUsd - input.equityUsd);
    next.drawdownFromHwmUsd = Math.max(0, next.highWaterMarkUsd - input.equityUsd);
    if (next.drawdownFromStartUsd + 1e-9 >= limits.maxDrawdownUsd) { halt = true; reasons.push("DRAWDOWN_FROM_START"); }
  }
  if (input.dailyPnlUsd != null && input.dailyPnlUsd <= -limits.dailyLossUsd + 1e-9) { halt = true; reasons.push("DAILY_LOSS"); }
  if (input.gridLower > 0 && input.gridUpper > 0 && input.mid > 0) {
    const longAdverse = input.positionQty > 0 && input.mid < input.gridLower * (1 - limits.boundaryBufferPct);
    const shortAdverse = input.positionQty < 0 && input.mid > input.gridUpper * (1 + limits.boundaryBufferPct);
    if (longAdverse || shortAdverse) { halt = true; reasons.push("RISK_BOUNDARY_BREACH"); }
  }
  if (input.plannedGrossNotionalUsd > limits.maxGrossNotionalUsd + 1e-9) { reduceOnly = true; reasons.push("PLANNED_NOTIONAL_CAP"); }
  if (input.positionNotionalUsd > limits.maxGrossNotionalUsd + 1e-9) { reduceOnly = true; reasons.push("ACTUAL_NOTIONAL_CAP"); }
  if (state.halted) {
    halt = true;
    for (const reason of state.haltReasons) if (!reasons.includes(reason)) reasons.push(reason);
  }
  if (halt) {
    reduceOnly = true;
    next.halted = true;
    next.haltStatus = state.halted ? state.haltStatus : "HALTING";
    next.haltId = state.haltId || crypto.randomUUID();
    next.haltReasons = reasons.length ? reasons : state.haltReasons;
    next.acknowledged = false;
  }
  return { decision: { halt, reduceOnly, reasons }, next };
}

export function filterRiskIncreasingIntents(intents: Intent[], decision: RiskDecision): Intent[] {
  if (!decision.halt && !decision.reduceOnly) return intents;
  return intents.filter((i) => i.type === "cancel");
}

export function combineDailyPnl(p: {
  realizedPnlUsd?: number | null;
  feesUsd?: number | null;
  fundingUsd?: number | null;
}): number | null {
  if (p.realizedPnlUsd == null && p.feesUsd == null && p.fundingUsd == null) return null;
  return (Number(p.realizedPnlUsd) || 0) - Math.abs(Number(p.feesUsd) || 0) + (Number(p.fundingUsd) || 0);
}
