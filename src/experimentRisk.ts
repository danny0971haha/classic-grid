import fs from "node:fs";
import path from "node:path";
import type { Intent } from "./types.js";

export type RiskDecision = {
  halt: boolean;
  reduceOnly: boolean;
  reasons: string[];
};

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
};

export type ExperimentRiskState = {
  halted: boolean;
  haltReasons: string[];
  startingEquityUsd: number | null;
  highWaterMarkUsd: number | null;
  drawdownFromStartUsd: number;
  drawdownFromHwmUsd: number;
  acknowledged: boolean;
  updatedAt: string;
};

export function emptyRiskState(): ExperimentRiskState {
  return {
    halted: false,
    haltReasons: [],
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
  return path.join(root, experimentId);
}

export function riskStatePath(experimentId: string, baseDir?: string): string {
  return path.join(experimentDir(experimentId, baseDir), "risk-state.json");
}

export function loadRiskState(experimentId: string, baseDir?: string): ExperimentRiskState {
  try {
    const p = riskStatePath(experimentId, baseDir);
    if (!fs.existsSync(p)) return emptyRiskState();
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      ...emptyRiskState(),
      halted: Boolean(j?.halted),
      haltReasons: Array.isArray(j?.haltReasons) ? j.haltReasons.map(String) : [],
      startingEquityUsd:
        j?.startingEquityUsd != null && Number.isFinite(Number(j.startingEquityUsd))
          ? Number(j.startingEquityUsd)
          : null,
      highWaterMarkUsd:
        j?.highWaterMarkUsd != null && Number.isFinite(Number(j.highWaterMarkUsd))
          ? Number(j.highWaterMarkUsd)
          : null,
      drawdownFromStartUsd: Number(j?.drawdownFromStartUsd) || 0,
      drawdownFromHwmUsd: Number(j?.drawdownFromHwmUsd) || 0,
      acknowledged: Boolean(j?.acknowledged),
      updatedAt: String(j?.updatedAt || new Date().toISOString()),
    };
  } catch {
    return emptyRiskState();
  }
}

export function persistRiskState(
  experimentId: string,
  state: ExperimentRiskState,
  baseDir?: string
): void {
  const dir = experimentDir(experimentId, baseDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(riskStatePath(experimentId, baseDir), JSON.stringify(state, null, 2), "utf8");
}

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes", "YES"].includes(String(v || "").trim());
}

/** 硬停后必须 EXPERIMENT_HALT_ACK=YES 才能清 HALTED */
export function acknowledgeHaltIfRequested(
  experimentId: string,
  state: ExperimentRiskState,
  baseDir?: string
): ExperimentRiskState {
  if (!state.halted) return state;
  if (!truthy(process.env.EXPERIMENT_HALT_ACK)) return state;
  const next: ExperimentRiskState = {
    ...state,
    halted: false,
    haltReasons: [],
    acknowledged: true,
    updatedAt: new Date().toISOString(),
  };
  persistRiskState(experimentId, next, baseDir);
  return next;
}

export function evaluateExperimentRisk(
  input: RiskMarketInput,
  limits: ExperimentRiskLimits,
  state: ExperimentRiskState
): { decision: RiskDecision; next: ExperimentRiskState } {
  const reasons: string[] = [];
  let halt = false;
  let reduceOnly = false;

  const next: ExperimentRiskState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };

  if (input.equityUsd != null && Number.isFinite(input.equityUsd)) {
    if (next.startingEquityUsd == null) next.startingEquityUsd = input.equityUsd;
    next.highWaterMarkUsd =
      next.highWaterMarkUsd == null
        ? input.equityUsd
        : Math.max(next.highWaterMarkUsd, input.equityUsd);
    next.drawdownFromStartUsd = Math.max(0, next.startingEquityUsd - input.equityUsd);
    next.drawdownFromHwmUsd = Math.max(0, next.highWaterMarkUsd - input.equityUsd);
    if (next.drawdownFromStartUsd + 1e-9 >= limits.maxDrawdownUsd) {
      halt = true;
      reasons.push("DRAWDOWN_FROM_START");
    }
  }

  if (input.dailyPnlUsd != null && Number.isFinite(input.dailyPnlUsd)) {
    if (input.dailyPnlUsd <= -limits.dailyLossUsd + 1e-9) {
      halt = true;
      reasons.push("DAILY_LOSS");
    }
  }

  if (input.gridLower > 0 && input.gridUpper > 0 && input.mid > 0) {
    const lowerKill = input.gridLower * (1 - limits.boundaryBufferPct);
    const upperKill = input.gridUpper * (1 + limits.boundaryBufferPct);
    const longAdverse = input.positionQty > 0 && input.mid < lowerKill;
    const shortAdverse = input.positionQty < 0 && input.mid > upperKill;
    if (longAdverse || shortAdverse) {
      halt = true;
      reasons.push("RISK_BOUNDARY_BREACH");
    }
  }

  if (input.plannedGrossNotionalUsd > limits.maxGrossNotionalUsd + 1e-9) {
    reduceOnly = true;
    reasons.push("PLANNED_NOTIONAL_CAP");
  }
  if (input.positionNotionalUsd > limits.maxGrossNotionalUsd + 1e-9) {
    reduceOnly = true;
    reasons.push("ACTUAL_NOTIONAL_CAP");
  }

  if (state.halted) {
    halt = true;
    for (const r of state.haltReasons) {
      if (!reasons.includes(r)) reasons.push(r);
    }
  }

  if (halt) {
    reduceOnly = true;
    next.halted = true;
    next.haltReasons = reasons.length ? reasons : state.haltReasons;
    next.acknowledged = false;
  }

  return {
    decision: { halt, reduceOnly, reasons },
    next,
  };
}

export function filterRiskIncreasingIntents(
  intents: Intent[],
  decision: RiskDecision
): Intent[] {
  if (!decision.halt && !decision.reduceOnly) return intents;
  return intents.filter((i) => i.type === "cancel");
}

export function combineDailyPnl(p: {
  realizedPnlUsd?: number | null;
  feesUsd?: number | null;
  fundingUsd?: number | null;
}): number | null {
  const has =
    p.realizedPnlUsd != null || p.feesUsd != null || p.fundingUsd != null;
  if (!has) return null;
  const realized = Number(p.realizedPnlUsd) || 0;
  const fees = Number(p.feesUsd) || 0;
  const funding = Number(p.fundingUsd) || 0;
  return realized - Math.abs(fees) + funding;
}
