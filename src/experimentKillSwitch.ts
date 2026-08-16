import type { VenueSnapshot } from "./types.js";
import {
  loadRiskState,
  persistRiskState,
  type ExperimentRiskState,
  type HaltStatus,
} from "./experimentRisk.js";

export type KillSwitchExecutor = {
  cancelAll(market: string): Promise<void>;
  closePosition(market: string): Promise<void>;
  snapshot(market: string): Promise<VenueSnapshot>;
};

export type KillSwitchResult = {
  cancelOk: boolean;
  closeOk: boolean;
  halted: true;
  flat: boolean;
  status: Exclude<HaltStatus, "RUNNING">;
  position: number;
  openOrders: number;
  attempts: number;
  errors: string[];
  state: ExperimentRiskState;
};

function safeEvent(
  fn: ((event: "CANCEL" | "ERROR" | "RISK_HALT" | "SNAPSHOT", fields: Record<string, unknown>) => void) | undefined,
  event: "CANCEL" | "ERROR" | "RISK_HALT" | "SNAPSHOT",
  fields: Record<string, unknown>
): void {
  try { fn?.(event, fields); } catch { /* telemetry must never control liquidation */ }
}

function errText(error: unknown): string {
  return String((error as any)?.message || error).slice(0, 300);
}

export async function runExperimentKillSwitch(p: {
  ex: KillSwitchExecutor;
  market: string;
  reasons: string[];
  experimentId: string;
  baseDir?: string;
  scopeKey?: string;
  maxAttempts?: number;
  positionTolerance?: number;
  retryDelayMs?: number;
  onEvent?: (event: "CANCEL" | "ERROR" | "RISK_HALT" | "SNAPSHOT", fields: Record<string, unknown>) => void;
}): Promise<KillSwitchResult> {
  const errors: string[] = [];
  const maxAttempts = Math.max(1, Math.min(10, p.maxAttempts ?? 3));
  const tolerance = Math.max(0, p.positionTolerance ?? 1e-10);
  const delay = Math.max(0, p.retryDelayMs ?? 250);
  let cancelOk = false;
  let closeOk = false;
  let snap: VenueSnapshot | null = null;
  let attempts = 0;

  let state = loadRiskState(p.experimentId, p.baseDir, p.scopeKey);
  state = {
    ...state,
    halted: true,
    haltStatus: "HALTING",
    haltReasons: Array.from(new Set([...state.haltReasons, ...p.reasons])),
    acknowledged: false,
    updatedAt: new Date().toISOString(),
  };
  try { persistRiskState(p.experimentId, state, p.baseDir); }
  catch (error) { errors.push(`persist HALTING: ${errText(error)}`); }

  for (attempts = 1; attempts <= maxAttempts; attempts++) {
    try {
      await p.ex.cancelAll(p.market);
      cancelOk = true;
      safeEvent(p.onEvent, "CANCEL", { symbol: p.market, attempt: attempts });
    } catch (error) {
      const msg = errText(error);
      errors.push(`cancelAll[${attempts}]: ${msg}`);
      safeEvent(p.onEvent, "ERROR", { error_code: "CANCEL_ALL_FAILED", attempt: attempts });
    }
    try {
      await p.ex.closePosition(p.market);
      closeOk = true;
    } catch (error) {
      const msg = errText(error);
      errors.push(`closePosition[${attempts}]: ${msg}`);
      safeEvent(p.onEvent, "ERROR", { error_code: "CLOSE_POSITION_FAILED", attempt: attempts });
    }
    try {
      snap = await p.ex.snapshot(p.market);
      safeEvent(p.onEvent, "SNAPSHOT", {
        mid: snap.mid,
        position_qty: snap.position,
        open_order_count: snap.openOrders.length,
        attempt: attempts,
      });
      if (Math.abs(snap.position) <= tolerance && snap.openOrders.length === 0) break;
      errors.push(`verify[${attempts}]: position=${snap.position} openOrders=${snap.openOrders.length}`);
    } catch (error) {
      const msg = errText(error);
      errors.push(`snapshot[${attempts}]: ${msg}`);
      safeEvent(p.onEvent, "ERROR", { error_code: "SNAPSHOT_FAILED", attempt: attempts });
    }
    if (attempts < maxAttempts && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const flat = Boolean(snap && Math.abs(snap.position) <= tolerance && snap.openOrders.length === 0);
  let status: Exclude<HaltStatus, "RUNNING"> = flat
    ? "HALTED_FLAT"
    : snap
      ? "HALTED_UNFLAT"
      : "HALT_FAILED";
  state = {
    ...state,
    halted: true,
    haltStatus: status,
    updatedAt: new Date().toISOString(),
  };
  try { persistRiskState(p.experimentId, state, p.baseDir); }
  catch (error) {
    errors.push(`persist final: ${errText(error)}`);
    status = "HALT_FAILED";
    state = { ...state, haltStatus: status };
  }
  safeEvent(p.onEvent, "RISK_HALT", {
    risk_flags: state.haltReasons,
    error_code: status,
    position_qty: snap?.position ?? null,
    open_order_count: snap?.openOrders.length ?? null,
    attempts,
  });

  return {
    cancelOk,
    closeOk,
    halted: true,
    flat,
    status,
    position: snap?.position ?? Number.NaN,
    openOrders: snap?.openOrders.length ?? -1,
    attempts: Math.min(attempts, maxAttempts),
    errors,
    state,
  };
}
