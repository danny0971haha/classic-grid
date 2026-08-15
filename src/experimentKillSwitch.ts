import type { VenueSnapshot } from "./types.js";
import {
  persistRiskState,
  loadRiskState,
  type ExperimentRiskState,
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
  position: number;
  openOrders: number;
  errors: string[];
  state: ExperimentRiskState;
};

export async function runExperimentKillSwitch(p: {
  ex: KillSwitchExecutor;
  market: string;
  reasons: string[];
  experimentId: string;
  baseDir?: string;
  onEvent?: (event: "CANCEL" | "ERROR" | "RISK_HALT" | "SNAPSHOT", fields: Record<string, unknown>) => void;
}): Promise<KillSwitchResult> {
  const errors: string[] = [];
  let cancelOk = false;
  let closeOk = false;
  let snap: VenueSnapshot | null = null;

  try {
    await p.ex.cancelAll(p.market);
    cancelOk = true;
    p.onEvent?.("CANCEL", { symbol: p.market });
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    errors.push(`cancelAll: ${msg}`);
    p.onEvent?.("ERROR", { error_message: msg, error_code: "CANCEL_ALL_FAILED" });
  }

  try {
    await p.ex.closePosition(p.market);
    closeOk = true;
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    errors.push(`closePosition: ${msg}`);
    p.onEvent?.("ERROR", { error_message: msg, error_code: "CLOSE_POSITION_FAILED" });
  }

  try {
    snap = await p.ex.snapshot(p.market);
    p.onEvent?.("SNAPSHOT", {
      mid: snap.mid,
      position_qty: snap.position,
      open_order_count: snap.openOrders.length,
    });
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    errors.push(`snapshot: ${msg}`);
    p.onEvent?.("ERROR", { error_message: msg, error_code: "SNAPSHOT_FAILED" });
  }

  const prev = loadRiskState(p.experimentId, p.baseDir);
  const state: ExperimentRiskState = {
    ...prev,
    halted: true,
    haltReasons: Array.from(new Set([...prev.haltReasons, ...p.reasons])),
    acknowledged: false,
    updatedAt: new Date().toISOString(),
  };
  persistRiskState(p.experimentId, state, p.baseDir);
  p.onEvent?.("RISK_HALT", {
    risk_flags: state.haltReasons,
    error_message: errors[0] || state.haltReasons.join(","),
    position_qty: snap?.position ?? null,
    open_order_count: snap?.openOrders.length ?? null,
  });

  return {
    cancelOk,
    closeOk,
    halted: true,
    position: snap?.position ?? NaN,
    openOrders: snap?.openOrders.length ?? -1,
    errors,
    state,
  };
}
