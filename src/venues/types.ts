import type { ApplyResult, Intent, Side, VenueId, VenueSnapshot } from "../types.js";
import type {
  AuthoritativeReductionSnapshot,
  ReductionRequest,
  ReductionResult,
} from "../experimentReduction.js";
import type { ExtendedObservationResult } from "./extendedObservation.js";

export type VenueExecutor = {
  readonly id: VenueId;
  connect(): Promise<void>;
  disconnect(): void;
  snapshot(market: string): Promise<VenueSnapshot>;
  apply(intents: Intent[]): Promise<ApplyResult>;
  cancelAll(market: string): Promise<void>;
  /** 尽力市价/IOC 减仓清仓；无仓则 no-op */
  closePosition(market: string): Promise<void>;
  /** Project-owned reduce-only flatten. Optional so other venue adapters stay unchanged. */
  reduceExposure?(request: ReductionRequest & { side: Side; qty: number }): Promise<ReductionResult>;
  /** Live experiment must refuse venues without both capabilities. */
  experimentCapabilities?: {
    deterministicClientOrderId: boolean;
    leverageReadback: boolean;
  };
  verifyExperimentPreflight?(market: string, leverage: number): Promise<void>;
  /** Bind authoritative observations to the currently held runtime lease. */
  setLeaseGeneration?(generation: number): void;
  /** Venue-native strict read result, when the adapter supports one. */
  strictSnapshot?(market: string): Promise<ExtendedObservationResult>;
  /** Adapter-produced post-write observation. Must not be synthesized by the reduction wrapper. */
  authoritativeReductionSnapshot?(p: {
    market: string;
    mutationAttemptAtMs: number;
    leaseGeneration: string;
  }): Promise<AuthoritativeReductionSnapshot>;
};

export function dryApply(venue: VenueId, intents: Intent[]): ApplyResult {
  const placed = intents.filter((i) => i.type === "place").length;
  const cancelled = intents.filter((i) => i.type === "cancel").length;
  console.log(`[${venue}:dry] apply place=${placed} cancel=${cancelled}`);
  return { placed, cancelled, failed: 0, errors: [] };
}

export type { ApplyResult } from "../types.js";
