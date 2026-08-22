import fs from "node:fs";
import {
  acknowledgeDurableHalt,
  loadRiskState,
} from "../../src/experimentRisk.js";

const experimentId = String(process.env.CLASSIC_RISK_ID || "").trim();
const baseDir = String(process.env.CLASSIC_RISK_DIR || "").trim();
const staleGeneration = String(process.env.CLASSIC_RISK_STALE_GENERATION || "").trim();
const fencePath = String(process.env.CLASSIC_RISK_FENCE_FILE || "").trim();
const scope = String(process.env.CLASSIC_RISK_SCOPE || "extended:BTC");

if (!experimentId || !baseDir || !staleGeneration || !fencePath) {
  process.stderr.write("missing stale-owner worker env\n");
  process.exit(2);
}

const caller = loadRiskState(experimentId, baseDir, scope);
process.env.EXPERIMENT_HALT_ACK = String(process.env.CLASSIC_RISK_ACK_TOKEN || caller.haltId || "");

const result = acknowledgeDurableHalt(experimentId, caller, baseDir, {
  activeLease: {
    generation: staleGeneration,
    scopeKey: scope,
    assertCurrent() {
      const current = fs.readFileSync(fencePath, "utf8").trim();
      if (current !== staleGeneration) throw new Error("RUNTIME_LEASE_GENERATION_MISMATCH");
    },
  },
});

process.stdout.write(`${JSON.stringify({
  label: "stale-owner-ack",
  accepted: result.accepted,
  reasons: result.reasons,
  halted: result.state.halted,
  haltId: result.state.haltId,
})}\n`);
process.exit(result.accepted ? 0 : 4);
