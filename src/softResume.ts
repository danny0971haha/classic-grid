import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./loadEnv.js";
import type { VenueId } from "./types.js";
import { assertSafeExperimentId, readChecksummedJson, writeChecksummedJson } from "./experimentStorage.js";

export type SoftResumeAnchor = { anchorMid: number; gridCount: number; anchorEpoch: number };
type RecoveryCheckpoint = {
  experimentId: string;
  scopeKey: string;
  leaseGeneration: string;
  updatedAt: string;
  anchors: Partial<Record<VenueId, SoftResumeAnchor>>;
};

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes"].includes(String(v || "").trim().toLowerCase());
}

function recoveryPath(experimentId: string, baseDir?: string): string {
  return path.join(
    baseDir || path.resolve(process.cwd(), "data", "experiments"),
    assertSafeExperimentId(experimentId),
    "recovery-checkpoint.json"
  );
}

/** Load only the trading checkpoint. Dashboard status is intentionally not a recovery source. */
export function loadSoftResumeAnchors(opts?: {
  experimentId?: string;
  scopeKey?: string;
  baseDir?: string;
  checkpointPath?: string;
}): Partial<Record<VenueId, SoftResumeAnchor>> {
  loadEnv();
  if (!truthy(process.env.SOFT_RESUME)) return {};
  const experimentId = opts?.experimentId || String(process.env.EXPERIMENT_ID || "").trim();
  if (!experimentId) return {};
  const p = opts?.checkpointPath || recoveryPath(experimentId, opts?.baseDir);
  if (!fs.existsSync(p)) return {};
  try {
    const checkpoint = readChecksummedJson<RecoveryCheckpoint>(p);
    if (checkpoint.experimentId !== experimentId) throw new Error("checkpoint experiment mismatch");
    if (opts?.scopeKey && checkpoint.scopeKey !== opts.scopeKey) throw new Error("checkpoint scope mismatch");
    const out: Partial<Record<VenueId, SoftResumeAnchor>> = {};
    for (const [venue, row] of Object.entries(checkpoint.anchors || {})) {
      const mid = Number(row?.anchorMid);
      const gridCount = Number(row?.gridCount);
      const anchorEpoch = Number(row?.anchorEpoch);
      if (mid > 0 && gridCount > 0 && anchorEpoch > 0) {
        out[venue as VenueId] = { anchorMid: mid, gridCount, anchorEpoch };
      }
    }
    return out;
  } catch (error: any) {
    throw new Error(`recovery checkpoint invalid: ${String(error?.message || error)}`);
  }
}

export function persistSoftResumeAnchor(p: {
  experimentId: string;
  scopeKey: string;
  leaseGeneration: string;
  venue: VenueId;
  anchor: SoftResumeAnchor;
  baseDir?: string;
}): void {
  const file = recoveryPath(p.experimentId, p.baseDir);
  let anchors: Partial<Record<VenueId, SoftResumeAnchor>> = {};
  if (fs.existsSync(file)) {
    const previous = readChecksummedJson<RecoveryCheckpoint>(file);
    if (previous.experimentId !== p.experimentId || previous.scopeKey !== p.scopeKey) {
      throw new Error("refusing to overwrite a recovery checkpoint from another scope");
    }
    anchors = previous.anchors || {};
  }
  writeChecksummedJson(file, {
    experimentId: p.experimentId,
    scopeKey: p.scopeKey,
    leaseGeneration: p.leaseGeneration,
    updatedAt: new Date().toISOString(),
    anchors: { ...anchors, [p.venue]: p.anchor },
  } satisfies RecoveryCheckpoint);
}
