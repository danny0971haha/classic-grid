import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  acknowledgeDurableHalt,
  emptyRiskState,
  evaluateExperimentRisk,
  initializeRiskStateStore,
  loadRiskState,
  persistRiskState,
  riskStatePath,
  type ExperimentRiskLimits,
  type ExperimentRiskState,
  type HaltStatus,
} from "../src/experimentRisk.js";
import {
  createChecksummedEnvelopeV2,
  serializeChecksummedEnvelopeV2,
  type AtomicWriteStep,
} from "../src/experimentStorage.js";
import { withEnv } from "./helpers/env.js";
import { liveLease } from "./helpers/gate0Corrective.js";

const WORKER = fileURLToPath(new URL("./fixtures/experiment-risk-crash-worker.ts", import.meta.url));
const SCOPE = "extended:BTC";
const LIMITS: ExperimentRiskLimits = {
  maxGrossNotionalUsd: 150,
  dailyLossUsd: 2.5,
  maxDrawdownUsd: 5,
  boundaryBufferPct: 0.01,
};

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

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `classic-ack-${label}-`));
}

function halted(partial: Partial<ExperimentRiskState> = {}): ExperimentRiskState {
  return {
    ...emptyRiskState(partial.scopeKey ?? SCOPE),
    halted: true,
    haltStatus: (partial.haltStatus as HaltStatus) || "HALTED_FLAT",
    haltId: Object.prototype.hasOwnProperty.call(partial, "haltId") ? (partial.haltId as string | null) : "halt-H1",
    haltReasons: partial.haltReasons ?? ["DAILY_LOSS"],
    leaseGeneration: Object.prototype.hasOwnProperty.call(partial, "leaseGeneration")
      ? (partial.leaseGeneration as string | null)
      : "lease-1",
    acknowledged: false,
    updatedAt: partial.updatedAt ?? "2026-08-22T00:00:00.000Z",
    startingEquityUsd: partial.startingEquityUsd ?? 50,
    highWaterMarkUsd: partial.highWaterMarkUsd ?? 50,
  };
}

function assertFailClosedOrCompleteAck(state: any, label: string): void {
    if (state.haltStatus === "RUNNING") {
    assert.equal(state.halted, false, label);
    assert.equal(state.haltId, null, label);
    assert.deepEqual(state.haltReasons, [], label);
    assert.equal(state.acknowledged, true, `${label}: RUNNING after crash must be a complete ACK`);
    assert.ok(state.lastAcknowledgement?.haltId, `${label}: RUNNING after crash must retain ACK lineage`);
    return;
  }
  assert.equal(state.halted, true, `${label}: ${JSON.stringify(state)}`);
  assert.ok(state.haltId && String(state.haltId).length > 0, label);
  assert.equal(state.acknowledged, false, label);
}

function seedHalted(id: string, dir: string, state: ExperimentRiskState = halted()): ExperimentRiskState {
  persistRiskState(id, state, dir);
  return loadRiskState(id, dir, state.scopeKey || SCOPE);
}

function spawnWorker(env: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
  lastJson: any;
} {
  const result = spawnSync(process.execPath, ["--import", "tsx", WORKER], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  let lastJson: any = null;
  for (const line of lines) {
    try { lastJson = JSON.parse(line); } catch { /* ignore non-json */ }
  }
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    lastJson,
  };
}

function reloadInFreshProcess(id: string, dir: string, scope = SCOPE): ExperimentRiskState {
  const child = spawnWorker({
    CLASSIC_RISK_ACTION: "reload",
    CLASSIC_RISK_ID: id,
    CLASSIC_RISK_DIR: dir,
    CLASSIC_RISK_SCOPE: scope,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.lastJson, child.stdout);
  return child.lastJson as ExperimentRiskState;
}

describe("Gate 0 durable ACK authority", () => {
  it("G0-ACK-STATIC-YES: rejects static YES and leaves halt durable", () => {
    const dir = tmpDir("static-yes");
    const id = "ack-static-yes";
    seedHalted(id, dir);
    const result = withEnv({ EXPERIMENT_HALT_ACK: "YES" }, () => {
      const acknowledged = acknowledgeDurableHalt(id, loadRiskState(id, dir), dir);
      return { acknowledged, tokenRemaining: process.env.EXPERIMENT_HALT_ACK };
    });
    assert.equal(result.acknowledged.accepted, false);
    assert.equal(result.acknowledged.state.halted, true);
    assert.equal(result.acknowledged.state.haltId, "halt-H1");
    assert.equal(result.tokenRemaining, "YES");
    assert.equal(reloadInFreshProcess(id, dir).halted, true);
    assert.equal(reloadInFreshProcess(id, dir).haltId, "halt-H1");
  });

  it("G0-ACK-OLD-TOKEN: old halt token cannot clear a newer committed halt", () => {
    const dir = tmpDir("old-token");
    const id = "ack-old-token";
    seedHalted(id, dir, halted({ haltId: "halt-H1" }));
    persistRiskState(id, halted({ haltId: "halt-H2", haltStatus: "HALTED_UNFLAT", haltReasons: ["DRAWDOWN_FROM_START"] }), dir);
    const callerH1 = { ...halted({ haltId: "halt-H1" }) };
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H1" }, () =>
      acknowledgeDurableHalt(id, callerH1, dir)
    );
    assert.equal(result.accepted, false);
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, true);
    assert.equal(reloaded.haltId, "halt-H2");
    assert.ok(reloaded.haltReasons.includes("DRAWDOWN_FROM_START"));
  });

  it("G0-ACK-FORGED-RUNNING: caller-forged RUNNING cannot authorize a clear", () => {
    const dir = tmpDir("forged");
    const id = "ack-forged-running";
    seedHalted(id, dir);
    const forged = emptyRiskState(SCOPE);
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H1" }, () =>
      acknowledgeDurableHalt(id, forged, dir)
    );
    assert.equal(result.accepted, false);
    assert.equal(reloadInFreshProcess(id, dir).halted, true);
    assert.equal(reloadInFreshProcess(id, dir).haltId, "halt-H1");
  });

  it("G0-ACK-STALE-HALTID: stale caller haltId is rejected even when env token matches durable", () => {
    const dir = tmpDir("stale-id");
    const id = "ack-stale-haltid";
    seedHalted(id, dir, halted({ haltId: "halt-H2" }));
    const stale = halted({ haltId: "halt-H1" });
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H2" }, () =>
      acknowledgeDurableHalt(id, stale, dir)
    );
    assert.equal(result.accepted, false);
    assert.equal(reloadInFreshProcess(id, dir).haltId, "halt-H2");
    assert.equal(reloadInFreshProcess(id, dir).halted, true);
  });

  it("G0-ACK-STALE-SCOPE: stale caller scope is rejected", () => {
    const dir = tmpDir("stale-scope");
    const id = "ack-stale-scope";
    seedHalted(id, dir, halted({ scopeKey: SCOPE }));
    const stale = halted({ scopeKey: "extended:ETH" });
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H1" }, () =>
      acknowledgeDurableHalt(id, stale, dir)
    );
    assert.equal(result.accepted, false);
    assert.equal(reloadInFreshProcess(id, dir).halted, true);
    assert.equal(reloadInFreshProcess(id, dir).scopeKey, SCOPE);
  });

  it("G0-ACK-STALE-LEASE: stale caller lease generation is rejected", () => {
    const dir = tmpDir("stale-lease");
    const id = "ack-stale-lease";
    seedHalted(id, dir, halted({ leaseGeneration: "lease-9" }));
    const stale = halted({ leaseGeneration: "lease-1" });
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H1" }, () =>
      acknowledgeDurableHalt(id, stale, dir)
    );
    assert.equal(result.accepted, false);
    assert.equal(reloadInFreshProcess(id, dir).halted, true);
    assert.equal(reloadInFreshProcess(id, dir).leaseGeneration, "lease-9");
  });

  it("G0-ACK-PRED-GEN: predecessor generation change between inspection and commit is rejected", () => {
    const dir = tmpDir("pred-gen");
    const id = "ack-pred-gen";
    const first = seedHalted(id, dir, halted({ haltId: "halt-H1" }));
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H1" }, () => {
      const acknowledged = acknowledgeDurableHalt(id, first, dir, {
        activeLease: liveLease("lease-1"),
        onAckStep(step) {
          if (step === "AFTER_PREDECESSOR_INSPECTION") {
            persistRiskState(id, halted({
              haltId: "halt-H2",
              haltStatus: "HALTED_UNFLAT",
              haltReasons: ["DRAWDOWN_FROM_START"],
              leaseGeneration: "lease-1",
            }), dir);
          }
        },
      });
      return { acknowledged, tokenRemaining: process.env.EXPERIMENT_HALT_ACK };
    });
    assert.equal(result.acknowledged.accepted, false);
    assert.equal(result.tokenRemaining, "halt-H1");
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, true);
    assert.equal(reloaded.haltId, "halt-H2");
  });

  it("G0-ACK-PRED-HASH: predecessor hash change between inspection and commit is rejected", () => {
    const dir = tmpDir("pred-hash");
    const id = "ack-pred-hash";
    const first = seedHalted(id, dir, halted({ haltId: "halt-H1" }));
    const primary = riskStatePath(id, dir);
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H1" }, () =>
      acknowledgeDurableHalt(id, first, dir, {
        activeLease: liveLease("lease-1"),
        onAckStep(step) {
          if (step === "AFTER_PREDECESSOR_INSPECTION") {
            const current = JSON.parse(fs.readFileSync(primary, "utf8"));
            const rewritten = createChecksummedEnvelopeV2({
              kind: current.kind,
              experimentId: id,
              scopeKey: current.scopeKey,
              storeGeneration: current.storeGeneration,
              leaseGeneration: current.leaseGeneration,
              createdAt: current.createdAt,
              writtenAt: "2026-08-22T00:00:01.000Z",
              previousEnvelopeSha256: current.previousEnvelopeSha256,
              payload: halted({
                haltId: "halt-H1",
                haltReasons: ["DAILY_LOSS", "SNAPSHOT_STALE"],
                leaseGeneration: "lease-1",
                updatedAt: "2026-08-22T00:00:01.000Z",
              }),
            });
            fs.writeFileSync(primary, serializeChecksummedEnvelopeV2(rewritten), "utf8");
          }
        },
      })
    );
    assert.equal(result.accepted, false);
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, true);
    assert.notEqual(reloaded.haltStatus, "RUNNING");
    assert.notEqual(reloaded.haltId, null);
  });

  it("G0-ACK-PRIMARY-CORRUPT: truncated primary with valid backup never incorrectly clears", () => {
    const dir = tmpDir("primary-corrupt");
    const id = "ack-primary-corrupt";
    seedHalted(id, dir);
    const primary = riskStatePath(id, dir);
    const raw = fs.readFileSync(primary, "utf8");
    fs.writeFileSync(primary, raw.slice(0, Math.max(1, Math.floor(raw.length / 3))), "utf8");
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H1" }, () =>
      acknowledgeDurableHalt(id, halted(), dir)
    );
    assert.equal(result.accepted, false);
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, true);
    assert.notEqual(reloaded.haltStatus, "RUNNING");
  });

  it("G0-ACK-GEN-HASH-CONFLICT: same-generation primary/backup hash conflict is rejected", () => {
    const dir = tmpDir("conflict");
    const id = "ack-conflict";
    seedHalted(id, dir);
    const primary = riskStatePath(id, dir);
    const current = JSON.parse(fs.readFileSync(primary, "utf8"));
    const conflicting = createChecksummedEnvelopeV2({
      kind: current.kind,
      experimentId: id,
      scopeKey: SCOPE,
      storeGeneration: current.storeGeneration,
      leaseGeneration: current.leaseGeneration,
      createdAt: current.createdAt,
      writtenAt: current.writtenAt,
      previousEnvelopeSha256: current.previousEnvelopeSha256,
      payload: halted({ haltId: "halt-H1", updatedAt: "2026-08-22T00:00:09.000Z" }),
    });
    fs.writeFileSync(`${primary}.bak`, serializeChecksummedEnvelopeV2(conflicting), "utf8");
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H1" }, () =>
      acknowledgeDurableHalt(id, halted(), dir)
    );
    assert.equal(result.accepted, false);
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, true);
    assert.ok(reloaded.haltReasons.includes("RISK_STATE_GENERATION_HASH_CONFLICT"));
  });

  it("G0-ACK-PERSIST-FAIL: persistence failure after token validation remains halted and keeps the token", () => {
    const dir = tmpDir("persist-fail");
    const id = "ack-persist-fail";
    const caller = seedHalted(id, dir);
    const primary = riskStatePath(id, dir);
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H1" }, () => {
      const acknowledged = acknowledgeDurableHalt(id, caller, dir, {
        activeLease: liveLease("lease-1"),
        onAtomicWriteStep(step, target) {
          if (target === primary && step === "BEFORE_RENAME") throw new Error("primary commit failed");
        },
      });
      return { acknowledged, tokenRemaining: process.env.EXPERIMENT_HALT_ACK };
    });
    assert.equal(result.acknowledged.accepted, false);
    assert.equal(result.acknowledged.persistenceProven, false);
    assert.equal(result.tokenRemaining, "halt-H1");
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, true);
    assert.equal(reloaded.haltId, "halt-H1");
  });

  it("G0-ACK-VERIFY-FAIL: commit that cannot be re-verified does not consume the token", () => {
    const dir = tmpDir("verify-fail");
    const id = "ack-verify-fail";
    const caller = seedHalted(id, dir);
    const primary = riskStatePath(id, dir);
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-H1" }, () => {
      const acknowledged = acknowledgeDurableHalt(id, caller, dir, {
        activeLease: liveLease("lease-1"),
        onAckStep(step) {
          if (step === "BEFORE_FINAL_VERIFICATION") {
            fs.writeFileSync(primary, "truncated-after-commit", "utf8");
          }
        },
      });
      return { acknowledged, tokenRemaining: process.env.EXPERIMENT_HALT_ACK };
    });
    assert.equal(result.acknowledged.accepted, false);
    assert.equal(result.tokenRemaining, "halt-H1");
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, true);
    assert.notEqual(reloaded.haltStatus, "RUNNING");
  });

  it("G0-ACK-HAPPY: matching durable token commits RUNNING only after reinspection and then consumes ACK", () => {
    const dir = tmpDir("happy");
    const id = "ack-happy";
    const caller = seedHalted(id, dir, halted({ haltId: "halt-unique-123" }));
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-unique-123" }, () => {
      const acknowledged = acknowledgeDurableHalt(id, caller, dir, { activeLease: liveLease("lease-1") });
      return { acknowledged, tokenRemaining: process.env.EXPERIMENT_HALT_ACK };
    });
    assert.equal(result.acknowledged.accepted, true);
    assert.equal(result.acknowledged.persistenceProven, true);
    assert.equal(result.acknowledged.acknowledgedHaltId, "halt-unique-123");
    assert.equal(result.acknowledged.state.halted, false);
    assert.equal(result.acknowledged.state.haltStatus, "RUNNING");
    assert.equal(result.acknowledged.state.haltId, null);
    assert.deepEqual(result.acknowledged.state.haltReasons, []);
    assert.equal(result.acknowledged.state.acknowledged, true);
    assert.equal(result.tokenRemaining, undefined);
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, false);
    assert.equal(reloaded.haltId, null);
    assert.equal(reloaded.acknowledged, true);
  });
});

describe("Gate 0 halt identity invariant", () => {
  it("G0-ID-NON-RUNNING: persist rejects haltId=null and haltId empty for every non-RUNNING status", () => {
    const statuses: HaltStatus[] = ["HALTING", "HALTED_UNFLAT", "HALTED_FLAT", "HALT_FAILED"];
    for (const haltStatus of statuses) {
      for (const haltId of [null, ""]) {
        const dir = tmpDir(`id-${haltStatus}-${haltId === null ? "null" : "empty"}`);
        const id = `id-${haltStatus}`;
        assert.throws(() => persistRiskState(id, {
          ...halted({ haltStatus, haltId: haltId as string | null }),
        }, dir), /RISK_STATE_PAYLOAD_INVALID|haltId/);
      }
    }
  });

  it("G0-ID-RUNNING: RUNNING must have halted=false, haltId=null, and empty haltReasons", () => {
    const dir = tmpDir("id-running");
    const id = "id-running";
    initializeRiskStateStore({ experimentId: id, baseDir: dir, scopeKey: SCOPE, leaseGeneration: "lease-1" });
    persistRiskState(id, emptyRiskState(SCOPE), dir);
    const loaded = loadRiskState(id, dir, SCOPE);
    assert.equal(loaded.haltStatus, "RUNNING");
    assert.equal(loaded.halted, false);
    assert.equal(loaded.haltId, null);
    assert.deepEqual(loaded.haltReasons, []);
    assert.throws(() => persistRiskState(id, {
      ...emptyRiskState(SCOPE),
      haltId: "should-not-exist",
    }, dir), /RISK_STATE_PAYLOAD_INVALID/);
    assert.throws(() => persistRiskState(id, {
      ...emptyRiskState(SCOPE),
      haltReasons: ["DAILY_LOSS"],
    }, dir), /RISK_STATE_PAYLOAD_INVALID/);
  });

  it("G0-ID-PRESERVE: same incident keeps haltId across HALTING → HALTED_UNFLAT → HALTED_FLAT", () => {
    const first = evaluateExperimentRisk(
      {
        mid: 100_000,
        equityUsd: 50,
        dailyPnlUsd: -3,
        positionQty: 0,
        positionNotionalUsd: 0,
        plannedGrossNotionalUsd: 150,
        gridLower: 97_000,
        gridUpper: 103_000,
      },
      LIMITS,
      emptyRiskState(SCOPE)
    );
    assert.equal(first.next.haltStatus, "HALTING");
    assert.equal(typeof first.next.haltId, "string");
    assert.ok(first.next.haltId && first.next.haltId.length > 0);
    const incident = first.next.haltId;

    const unflat = {
      ...first.next,
      haltStatus: "HALTED_UNFLAT" as const,
      acknowledged: false,
    };
    const dir = tmpDir("id-preserve");
    const id = "id-preserve";
    persistRiskState(id, unflat, dir);
    persistRiskState(id, { ...unflat, haltStatus: "HALTED_FLAT", updatedAt: "2026-08-22T00:00:02.000Z" }, dir);
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.haltId, incident);
    assert.equal(reloaded.haltStatus, "HALTED_FLAT");
    assert.equal(reloaded.acknowledged, false);
  });

  it("G0-ID-NEW-INCIDENT: a halt after successful ACK mints a new haltId", () => {
    const dir = tmpDir("id-new");
    const id = "id-new-incident";
    const first = seedHalted(id, dir, halted({ haltId: "halt-old" }));
    const acked = withEnv({ EXPERIMENT_HALT_ACK: "halt-old" }, () =>
      acknowledgeDurableHalt(id, first, dir, { activeLease: liveLease("lease-1") })
    );
    assert.equal(acked.accepted, true);
    const second = evaluateExperimentRisk(
      {
        mid: 100_000,
        equityUsd: 50,
        dailyPnlUsd: -3,
        positionQty: 0,
        positionNotionalUsd: 0,
        plannedGrossNotionalUsd: 150,
        gridLower: 97_000,
        gridUpper: 103_000,
      },
      LIMITS,
      acked.state
    );
    assert.equal(second.next.halted, true);
    assert.ok(second.next.haltId);
    assert.notEqual(second.next.haltId, "halt-old");
    assert.equal(second.next.acknowledged, false);
  });

  it("G0-ID-LOAD-FAILCLOSED: fail-closed synthesized states always carry a non-empty haltId", () => {
    const dir = tmpDir("id-missing");
    const missing = loadRiskState("missing-halt-id", dir, SCOPE);
    assert.equal(missing.halted, true);
    assert.ok(missing.haltId && missing.haltId.length > 0);
    initializeRiskStateStore({ experimentId: "init-halt-id", baseDir: dir, scopeKey: SCOPE });
    const initialized = loadRiskState("init-halt-id", dir, SCOPE);
    assert.equal(initialized.halted, true);
    assert.ok(initialized.haltId && initialized.haltId.length > 0);
  });
});

describe("Gate 0 crash / persistence matrix (fresh process reload)", () => {
  const ackPhases = [
    "BEFORE_PREDECESSOR_INSPECTION",
    "AFTER_PREDECESSOR_INSPECTION",
    "BEFORE_COMMIT",
    "AFTER_COMMIT",
    "BEFORE_FINAL_VERIFICATION",
  ] as const;

  for (const step of ATOMIC_STEPS) {
    it(`G0-CRASH-ATOMIC-${step}: restart cannot authorize RUNNING incorrectly`, () => {
      const dir = tmpDir(`crash-${step.toLowerCase()}`);
      const id = `crash-${step.toLowerCase()}`;
      const seed = spawnWorker({
        CLASSIC_RISK_ACTION: "seed-halted",
        CLASSIC_RISK_ID: id,
        CLASSIC_RISK_DIR: dir,
        CLASSIC_RISK_SCOPE: SCOPE,
        CLASSIC_RISK_HALT_ID: "halt-crash-1",
        CLASSIC_RISK_LEASE: "lease-1",
      });
      assert.equal(seed.status, 0, seed.stderr);

      spawnWorker({
        CLASSIC_RISK_ACTION: "ack",
        CLASSIC_RISK_ID: id,
        CLASSIC_RISK_DIR: dir,
        CLASSIC_RISK_SCOPE: SCOPE,
        CLASSIC_RISK_HALT_ID: "halt-crash-1",
        CLASSIC_RISK_ACK_TOKEN: "halt-crash-1",
        CLASSIC_RISK_CRASH_STEP: step,
        CLASSIC_RISK_CRASH_TARGET: "risk-state.json",
      });

      const reloaded = spawnWorker({
        CLASSIC_RISK_ACTION: "reload",
        CLASSIC_RISK_ID: id,
        CLASSIC_RISK_DIR: dir,
        CLASSIC_RISK_SCOPE: SCOPE,
      });
      assert.equal(reloaded.status, 0, reloaded.stderr);
      assertFailClosedOrCompleteAck(reloaded.lastJson, step);
    });
  }

  for (const phase of ackPhases) {
    it(`G0-CRASH-ACK-${phase}: unverified ACK remains fail closed after restart`, () => {
      const dir = tmpDir(`ackphase-${phase.toLowerCase()}`);
      const id = `ackphase-${phase.toLowerCase()}`;
      const seed = spawnWorker({
        CLASSIC_RISK_ACTION: "seed-halted",
        CLASSIC_RISK_ID: id,
        CLASSIC_RISK_DIR: dir,
        CLASSIC_RISK_SCOPE: SCOPE,
        CLASSIC_RISK_HALT_ID: "halt-phase-1",
        CLASSIC_RISK_LEASE: "lease-1",
      });
      assert.equal(seed.status, 0, seed.stderr);

      spawnWorker({
        CLASSIC_RISK_ACTION: "ack",
        CLASSIC_RISK_ID: id,
        CLASSIC_RISK_DIR: dir,
        CLASSIC_RISK_SCOPE: SCOPE,
        CLASSIC_RISK_HALT_ID: "halt-phase-1",
        CLASSIC_RISK_ACK_TOKEN: "halt-phase-1",
        CLASSIC_RISK_CRASH_STEP: phase,
      });

      const reloaded = spawnWorker({
        CLASSIC_RISK_ACTION: "reload",
        CLASSIC_RISK_ID: id,
        CLASSIC_RISK_DIR: dir,
        CLASSIC_RISK_SCOPE: SCOPE,
      });
      assert.equal(reloaded.status, 0, reloaded.stderr);
      assertFailClosedOrCompleteAck(reloaded.lastJson, phase);
    });
  }

  it("G0-CRASH-NEWER-HALT: crash during ACK cannot erase a newer halt written after inspection", () => {
    const dir = tmpDir("crash-newer");
    const id = "crash-newer-halt";
    const seed = spawnWorker({
      CLASSIC_RISK_ACTION: "seed-halted",
      CLASSIC_RISK_ID: id,
      CLASSIC_RISK_DIR: dir,
      CLASSIC_RISK_SCOPE: SCOPE,
      CLASSIC_RISK_HALT_ID: "halt-old",
      CLASSIC_RISK_LEASE: "lease-1",
    });
    assert.equal(seed.status, 0, seed.stderr);
    const newer = spawnWorker({
      CLASSIC_RISK_ACTION: "persist-newer-halt",
      CLASSIC_RISK_ID: id,
      CLASSIC_RISK_DIR: dir,
      CLASSIC_RISK_SCOPE: SCOPE,
      CLASSIC_RISK_HALT_ID: "halt-old",
      CLASSIC_RISK_NEW_HALT_ID: "halt-new",
      CLASSIC_RISK_LEASE: "lease-1",
    });
    assert.equal(newer.status, 0, newer.stderr);

    spawnWorker({
      CLASSIC_RISK_ACTION: "ack",
      CLASSIC_RISK_ID: id,
      CLASSIC_RISK_DIR: dir,
      CLASSIC_RISK_SCOPE: SCOPE,
      CLASSIC_RISK_ACK_TOKEN: "halt-old",
      CLASSIC_RISK_CALLER_JSON: JSON.stringify(halted({ haltId: "halt-old" })),
      CLASSIC_RISK_CRASH_STEP: "BEFORE_RENAME",
      CLASSIC_RISK_CRASH_TARGET: "risk-state.json",
    });

    const reloaded = spawnWorker({
      CLASSIC_RISK_ACTION: "reload",
      CLASSIC_RISK_ID: id,
      CLASSIC_RISK_DIR: dir,
      CLASSIC_RISK_SCOPE: SCOPE,
    });
    assert.equal(reloaded.lastJson.halted, true);
    assert.equal(reloaded.lastJson.haltId, "halt-new");
  });
});
