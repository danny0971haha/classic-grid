import {
  evaluateExperimentRisk,
  emptyRiskState,
  loadRiskState,
  type ExperimentRiskLimits,
  type ExperimentRiskState,
} from "../../src/experimentRisk.js";
import { experimentAllowsReseed } from "../../src/experimentReduction.js";

const LIMITS: ExperimentRiskLimits = {
  maxGrossNotionalUsd: 150,
  dailyLossUsd: 5,
  maxDrawdownUsd: 10,
  boundaryBufferPct: 0.01,
};

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

const experimentId = required("CLASSIC_RISK_ID");
const baseDir = required("CLASSIC_RISK_DIR");
const scope = process.env.CLASSIC_RISK_SCOPE || "extended:BTC";

const state: ExperimentRiskState = loadRiskState(experimentId, baseDir, scope);
const evaluated = evaluateExperimentRisk(
  {
    mid: 100_000,
    equityUsd: 100,
    dailyPnlUsd: 0,
    positionQty: 0,
    positionNotionalUsd: 0,
    plannedGrossNotionalUsd: 120,
    gridLower: 97_000,
    gridUpper: 103_000,
  },
  LIMITS,
  state.halted ? state : emptyRiskState(scope)
);

process.stdout.write(`${JSON.stringify({
  durableHalted: state.halted,
  durableHaltStatus: state.haltStatus,
  durableHaltId: state.haltId,
  durableReasons: state.haltReasons,
  decisionHalt: evaluated.decision.halt,
  decisionReasons: evaluated.decision.reasons,
  nextHaltStatus: evaluated.next.haltStatus,
  nextHaltId: evaluated.next.haltId,
  nextHalted: evaluated.next.halted,
  reseedAllowedFromDurable: experimentAllowsReseed(state),
  reseedAllowedFromEvaluated: experimentAllowsReseed(evaluated.next),
})}\n`);
