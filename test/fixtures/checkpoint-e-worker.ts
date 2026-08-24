import fs from "node:fs";
import { planFromFillsAndSeed } from "../../src/grid.js";
import { beginRuntimeSession } from "../../src/runtimeLease.js";
import { experimentDir } from "../../src/experimentRisk.js";
import type { LiveOrder } from "../../src/types.js";

const action = String(process.env.CLASSIC_E_ACTION || "").trim();

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

if (action === "uncaught") {
  fs.writeFileSync(required("CLASSIC_E_MARKER"), "not-placed\n");
  throw new Error("E24_UNCAUGHT");
}

if (action === "rejection") {
  fs.writeFileSync(required("CLASSIC_E_MARKER"), "not-placed\n");
  Promise.reject(new Error("E25_UNHANDLED"));
} else if (action === "plan") {
  const orders = JSON.parse(required("CLASSIC_E_ORDERS")) as LiveOrder[];
  const extra = JSON.parse(process.env.CLASSIC_E_PLAN_EXTRA || "{}") as Record<string, unknown>;
  const plan = planFromFillsAndSeed({
    market: "BTC",
    mid: 100_000,
    levels: [99_000, 100_000, 101_000],
    spacing: 1_000,
    mode: "neutral",
    sizeBase: 0.001,
    openOrders: orders,
    prevActive: new Map(),
    maxWrites: 10,
    seeded: true,
    ownershipPrefix: "cg:test:",
    anchorEpoch: 42,
    ...extra,
  });
  process.stdout.write(`${JSON.stringify({
    intents: plan.intents,
    nextActive: [...plan.nextActive.entries()],
    filled: plan.filled,
    completedRungs: plan.completedRungs,
    diagnostics: plan.diagnostics,
    currentSnapshotVenueCount: plan.currentSnapshotVenueCount,
    plannedCancelCount: plan.plannedCancelCount,
    capacityAfterAuthoritativeSnapshot: plan.capacityAfterAuthoritativeSnapshot,
    plannerDisposition: plan.plannerDisposition,
    riskIncreaseBlocked: plan.riskIncreaseBlocked,
  })}\n`);
  process.exit(0);
} else if (action === "session-open" || action === "session-resume") {
  const experimentId = required("CLASSIC_E_EXPERIMENT_ID");
  const baseDir = required("CLASSIC_E_BASE_DIR");
  const result = beginRuntimeSession({
    experimentDir: experimentDir(experimentId, baseDir),
    experimentId,
    scopeKey: process.env.CLASSIC_E_SCOPE || "dry-run:extended:BTC",
    leaseGeneration: process.env.CLASSIC_E_LEASE || "lease-1",
  });
  process.stdout.write(`${JSON.stringify({
    allowsTrading: result.allowsTrading,
    reasonCode: result.reasonCode,
    status: result.session?.status ?? null,
  })}\n`);
  process.exit(0);
} else if (action !== "rejection") {
  process.stderr.write(`unknown action ${action}\n`);
  process.exit(2);
}
