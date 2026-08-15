import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./loadEnv.js";
import type { VenueId } from "./types.js";

export type SoftResumeAnchor = { anchorMid: number; gridCount: number };

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes", "YES"].includes(String(v || "").trim());
}

/** 软启：从 data/status.json 恢复锚点，避免重锚导致误撤现有挂单 */
export function loadSoftResumeAnchors(
  statusPath?: string
): Partial<Record<VenueId, SoftResumeAnchor>> {
  loadEnv();
  if (!truthy(process.env.SOFT_RESUME)) return {};
  try {
    const p = statusPath || path.resolve(process.cwd(), "data", "status.json");
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const out: Partial<Record<VenueId, SoftResumeAnchor>> = {};
    for (const v of j.venues || []) {
      const id = String(v.venue) as VenueId;
      const mid = Number(v.anchorMid);
      const gc = Number(v.gridCount);
      if (mid > 0 && gc > 0) out[id] = { anchorMid: mid, gridCount: gc };
    }
    console.log(
      `[soft-resume] loaded anchors: ${
        Object.entries(out)
          .map(([k, v]) => `${k}=${v!.anchorMid.toFixed(1)}`)
          .join(", ") || "(none)"
      }`
    );
    return out;
  } catch (e: any) {
    console.warn(`[soft-resume] load failed: ${String(e?.message || e).slice(0, 120)}`);
    return {};
  }
}
