import fs from "node:fs";
import {
  acknowledgeDurableHalt,
  emptyRiskState,
  loadRiskState,
  persistRiskState,
  type AckLifecycleStep,
  type ExperimentRiskState,
  type HaltStatus,
  type RiskStateStoreOptions,
} from "../../src/experimentRisk.js";
import type { AtomicWriteStep } from "../../src/experimentStorage.js";

type WorkerAction = "seed-halted" | "seed-running" | "ack" | "reload" | "persist-newer-halt";

const ATOMIC_STEPS: AtomicWriteStep[] = [
  "BEFORE_TEMP_OPEN",
  "AFTER_TEMP_OPEN",
  "AFTER_WRITE",
  "AFTER_FILE_FSYNC",
  "BEFORE_RENAME",
  "AFTER_RENAME",
  "BEFORE_DIRECTORY_FSYNC",
  "AFTER_DIRECTORY_FSYNC",
];

const ACK_STEPS: AckLifecycleStep[] = [
  "BEFORE_PREDECESSOR_INSPECTION",
  "AFTER_PREDECESSOR_INSPECTION",
  "BEFORE_COMMIT",
  "AFTER_COMMIT",
  "BEFORE_FINAL_VERIFICATION",
];

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

function haltedState(partial: Partial<ExperimentRiskState> = {}): ExperimentRiskState {
  return {
    ...emptyRiskState(partial.scopeKey ?? (process.env.CLASSIC_RISK_SCOPE || "extended:BTC")),
    halted: true,
    haltStatus: (partial.haltStatus as HaltStatus) || "HALTED_FLAT",
    haltId: partial.haltId || required("CLASSIC_RISK_HALT_ID"),
    haltReasons: partial.haltReasons || ["DAILY_LOSS"],
    leaseGeneration: partial.leaseGeneration ?? (process.env.CLASSIC_RISK_LEASE || "lease-1"),
    acknowledged: false,
    updatedAt: new Date().toISOString(),
  };
}

function crashIf(step: string, targetPath: string): void {
  const crashStep = String(process.env.CLASSIC_RISK_CRASH_STEP || "").trim();
  const crashTarget = String(process.env.CLASSIC_RISK_CRASH_TARGET || "").trim();
  if (!crashStep) return;
  if (crashStep !== step) return;
  if (crashTarget && !targetPath.endsWith(crashTarget) && targetPath !== crashTarget) return;
  process.stderr.write(`CRASH ${step} ${targetPath}\n`);
  process.exit(33);
}

function storeOptions(): RiskStateStoreOptions {
  return {
    onAtomicWriteStep(step, targetPath) {
      crashIf(step, targetPath);
    },
    onAckStep(step, targetPath) {
      crashIf(step, targetPath);
    },
  };
}

function printState(label: string, state: ExperimentRiskState): void {
  process.stdout.write(`${JSON.stringify({
    label,
    halted: state.halted,
    haltStatus: state.haltStatus,
    haltId: state.haltId,
    haltReasons: state.haltReasons,
    acknowledged: state.acknowledged,
    scopeKey: state.scopeKey,
    leaseGeneration: state.leaseGeneration,
  })}\n`);
}

const action = required("CLASSIC_RISK_ACTION") as WorkerAction;
const experimentId = required("CLASSIC_RISK_ID");
const baseDir = required("CLASSIC_RISK_DIR");

try {
  if (action === "seed-running") {
    persistRiskState(experimentId, emptyRiskState(process.env.CLASSIC_RISK_SCOPE || "extended:BTC"), baseDir);
    printState("seed-running", loadRiskState(experimentId, baseDir));
    process.exit(0);
  }

  if (action === "seed-halted") {
    persistRiskState(experimentId, haltedState(), baseDir);
    printState("seed-halted", loadRiskState(experimentId, baseDir));
    process.exit(0);
  }

  if (action === "persist-newer-halt") {
    persistRiskState(experimentId, haltedState({
      haltId: required("CLASSIC_RISK_NEW_HALT_ID"),
      haltStatus: "HALTED_UNFLAT",
      haltReasons: ["DRAWDOWN_FROM_START"],
    }), baseDir);
    printState("persist-newer-halt", loadRiskState(experimentId, baseDir));
    process.exit(0);
  }

  if (action === "ack") {
    const callerRaw = process.env.CLASSIC_RISK_CALLER_JSON;
    const caller = callerRaw
      ? JSON.parse(callerRaw) as ExperimentRiskState
      : loadRiskState(experimentId, baseDir);
    if (process.env.CLASSIC_RISK_ACK_TOKEN != null) {
      process.env.EXPERIMENT_HALT_ACK = process.env.CLASSIC_RISK_ACK_TOKEN;
    }
    const result = acknowledgeDurableHalt(experimentId, caller, baseDir, storeOptions());
    printState("ack", result.state);
    process.stdout.write(`${JSON.stringify({
      label: "ack-result",
      accepted: result.accepted,
      persistenceProven: result.persistenceProven,
      acknowledgedHaltId: result.acknowledgedHaltId,
      reasons: result.reasons,
      tokenRemaining: process.env.EXPERIMENT_HALT_ACK || null,
    })}\n`);
    process.exit(result.accepted ? 0 : 4);
  }

  if (action === "reload") {
    const state = loadRiskState(experimentId, baseDir, process.env.CLASSIC_RISK_SCOPE || undefined);
    printState("reload", state);
    process.exit(state.halted ? 0 : 0);
  }

  process.stderr.write(`unknown action ${action}\n`);
  process.exit(2);
} catch (error) {
  process.stderr.write(`${String((error as Error)?.message || error)}\n`);
  process.exit(1);
}

void ATOMIC_STEPS;
void ACK_STEPS;
