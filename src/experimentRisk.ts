import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Intent, LiveOrder } from "./types.js";
import {
  assertSafeExperimentId,
  readChecksummedJson,
  writeChecksummedJson,
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

function failClosedState(reason: string, scopeKey?: string): ExperimentRiskState {
  return {
    ...emptyRiskState(scopeKey || null),
    halted: true,
    haltStatus: "HALT_FAILED",
    haltId: crypto.randomUUID(),
    haltReasons: [reason],
    acknowledged: false,
  };
}

function normalizeState(raw: any, expectedScope?: string): ExperimentRiskState {
  const rawStatus = String(raw?.haltStatus || "");
  const statusOk = ["RUNNING", "HALTING", "HALTED_UNFLAT", "HALTED_FLAT", "HALT_FAILED"].includes(rawStatus);
  const halted = Boolean(raw?.halted) || (statusOk && rawStatus !== "RUNNING");
  const state: ExperimentRiskState = {
    ...emptyRiskState(expectedScope || null),
    halted,
    haltStatus: statusOk ? rawStatus as HaltStatus : halted ? "HALTED_UNFLAT" : "RUNNING",
    haltId: raw?.haltId ? String(raw.haltId) : halted ? crypto.randomUUID() : null,
    haltReasons: Array.isArray(raw?.haltReasons) ? raw.haltReasons.map(String) : [],
    scopeKey: raw?.scopeKey ? String(raw.scopeKey) : expectedScope || null,
    leaseGeneration: raw?.leaseGeneration ? String(raw.leaseGeneration) : null,
    startingEquityUsd: raw?.startingEquityUsd != null && Number.isFinite(Number(raw.startingEquityUsd)) ? Number(raw.startingEquityUsd) : null,
    highWaterMarkUsd: raw?.highWaterMarkUsd != null && Number.isFinite(Number(raw.highWaterMarkUsd)) ? Number(raw.highWaterMarkUsd) : null,
    drawdownFromStartUsd: Number(raw?.drawdownFromStartUsd) || 0,
    drawdownFromHwmUsd: Number(raw?.drawdownFromHwmUsd) || 0,
    acknowledged: Boolean(raw?.acknowledged),
    updatedAt: String(raw?.updatedAt || new Date().toISOString()),
  };
  if (expectedScope && state.scopeKey && state.scopeKey !== expectedScope) {
    return failClosedState("RISK_STATE_SCOPE_MISMATCH", expectedScope);
  }
  return state;
}

export function loadRiskState(
  experimentId: string,
  baseDir?: string,
  expectedScope?: string
): ExperimentRiskState {
  const p = riskStatePath(experimentId, baseDir);
  if (!fs.existsSync(p)) return emptyRiskState(expectedScope || null);
  try { return normalizeState(readChecksummedJson(p), expectedScope); }
  catch {
    const backupPath = `${p}.bak`;
    if (fs.existsSync(backupPath)) {
      try {
        const backup = normalizeState(readChecksummedJson(backupPath), expectedScope);
        return {
          ...backup,
          halted: true,
          haltStatus: "HALT_FAILED",
          haltId: crypto.randomUUID(),
          haltReasons: Array.from(new Set([...backup.haltReasons, "RISK_STATE_PRIMARY_CORRUPT"])),
          acknowledged: false,
          updatedAt: new Date().toISOString(),
        };
      } catch {
        // both copies invalid
      }
    }
  }
  // One-time compatibility for a syntactically valid pre-envelope state. Invalid
  // JSON or an object without an explicit halted flag remains fail-closed.
  try {
    const legacy = JSON.parse(fs.readFileSync(p, "utf8"));
    if (typeof legacy?.halted === "boolean") return normalizeState(legacy, expectedScope);
  } catch {
    // handled by fail-closed return below
  }
  return failClosedState("RISK_STATE_CORRUPT", expectedScope);
}

export function persistRiskState(
  experimentId: string,
  state: ExperimentRiskState,
  baseDir?: string
): void {
  writeChecksummedJson(riskStatePath(experimentId, baseDir), state);
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
