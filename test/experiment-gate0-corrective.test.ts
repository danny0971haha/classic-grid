import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  acknowledgeDurableHalt,
  emptyRiskState,
  evaluateExperimentRisk,
  experimentDir,
  loadRiskState,
  persistRiskState,
  type ExperimentRiskLimits,
  type ExperimentRiskState,
} from "../src/experimentRisk.js";
import { runExperimentKillSwitch } from "../src/experimentKillSwitch.js";
import { acquireRuntimeLease, beginRuntimeSession, requireVerifiedOpenSession } from "../src/runtimeLease.js";
import type { AtomicWriteStep } from "../src/experimentStorage.js";
import { withEnv } from "./helpers/env.js";
import { diskDisposition, halted, liveLease, SCOPE, tmpDir } from "./helpers/gate0Corrective.js";

const WORKER = fileURLToPath(new URL("./fixtures/experiment-risk-crash-worker.ts", import.meta.url));
const STALE_OWNER = fileURLToPath(new URL("./fixtures/stale-owner-ack-worker.ts", import.meta.url));

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

const ACK_STEPS = [
  "BEFORE_PREDECESSOR_INSPECTION",
  "AFTER_PREDECESSOR_INSPECTION",
  "BEFORE_COMMIT",
  "AFTER_COMMIT",
  "BEFORE_FINAL_VERIFICATION",
] as const;

function seedHalted(id: string, dir: string, state: ExperimentRiskState = halted()): ExperimentRiskState {
  persistRiskState(id, state, dir);
  return loadRiskState(id, dir, state.scopeKey || SCOPE);
}

function spawnWorker(env: Record<string, string>): { status: number | null; stdout: string; stderr: string; lastJson: any } {
  const result = spawnSync(process.execPath, ["--import", "tsx", WORKER], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  let lastJson: any = null;
  for (const line of lines) {
    try { lastJson = JSON.parse(line); } catch { /* ignore */ }
  }
  return { status: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), lastJson };
}

function reloadInFreshProcess(id: string, dir: string): ExperimentRiskState {
  const child = spawnWorker({
    CLASSIC_RISK_ACTION: "reload",
    CLASSIC_RISK_ID: id,
    CLASSIC_RISK_DIR: dir,
    CLASSIC_RISK_SCOPE: SCOPE,
  });
  assert.equal(child.status, 0, child.stderr);
  return child.lastJson as ExperimentRiskState;
}

function startupCheckFresh(id: string, dir: string, leaseGeneration: string): { allowsTrading: boolean; reasonCode: string | null; state: any } {
  const child = spawnWorker({
    CLASSIC_RISK_ACTION: "startup-check",
    CLASSIC_RISK_ID: id,
    CLASSIC_RISK_DIR: dir,
    CLASSIC_RISK_SCOPE: SCOPE,
    CLASSIC_RISK_ACTIVE_LEASE: leaseGeneration,
  });
  assert.ok(child.lastJson, child.stderr || child.stdout);
  return {
    allowsTrading: Boolean(child.lastJson.allowsTrading),
    reasonCode: child.lastJson.reasonCode ?? null,
    state: child.lastJson,
  };
}

function assertAcceptablePostCrash(label: string, id: string, dir: string, leaseGeneration: string): {
  outcome: "old_halted" | "complete_ack_reconciliation" | "fail_closed";
  disposition: ReturnType<typeof diskDisposition>;
} {
  const expDir = experimentDir(id, dir);
  const disposition = diskDisposition(expDir);
  const reloaded = reloadInFreshProcess(id, dir);
  const startup = startupCheckFresh(id, dir, leaseGeneration);
  if (reloaded.haltStatus === "RUNNING") {
    assert.equal(reloaded.halted, false, label);
    assert.equal(reloaded.haltId, null, label);
    assert.ok(reloaded.lastAcknowledgement?.haltId, `${label}: naked RUNNING without ACK lineage`);
    assert.equal(reloaded.leaseGeneration, reloaded.lastAcknowledgement?.activeLeaseGeneration, label);
    assert.equal(startup.allowsTrading, false, `${label}: crash must not authorize trading`);
    return { outcome: "complete_ack_reconciliation", disposition };
  }
  assert.equal(reloaded.halted, true, `${label}: ${JSON.stringify(reloaded)}`);
  assert.ok(reloaded.haltId && String(reloaded.haltId).length > 0, label);
  assert.equal(startup.allowsTrading, false, `${label}: halted/unproven restart must not trade`);
  const outcome = reloaded.haltReasons.some((reason) =>
    /CORRUPT|MISSING|UNPROVEN|CONFLICT|RECONCILIATION|SESSION/i.test(reason)
  ) || disposition.primaryParse === "CORRUPT"
    ? "fail_closed"
    : "old_halted";
  return { outcome, disposition };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(file: string, timeoutMs = 8000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    await sleep(20);
  }
  throw new Error(`ready file not written: ${file}`);
}

async function hardKillAck(p: {
  id: string;
  dir: string;
  haltId: string;
  lease: string;
  activeLease: string;
  crashStep: string;
  crashTarget?: string;
}): Promise<{ method: string; signal: NodeJS.Signals | null; ready: string }> {
  if (process.platform === "win32") {
    return { method: "UNSUPPORTED_WIN32", signal: null, ready: "" };
  }
  const readyFile = path.join(p.dir, `${p.id}-ready`);
  const child = spawn(process.execPath, ["--import", "tsx", WORKER], {
    env: {
      ...process.env,
      CLASSIC_RISK_ACTION: "ack",
      CLASSIC_RISK_ID: p.id,
      CLASSIC_RISK_DIR: p.dir,
      CLASSIC_RISK_SCOPE: SCOPE,
      CLASSIC_RISK_HALT_ID: p.haltId,
      CLASSIC_RISK_LEASE: p.lease,
      CLASSIC_RISK_ACTIVE_LEASE: p.activeLease,
      CLASSIC_RISK_ACK_TOKEN: p.haltId,
      CLASSIC_RISK_CRASH_STEP: p.crashStep,
      CLASSIC_RISK_CRASH_TARGET: p.crashTarget || "",
      CLASSIC_RISK_HARD_KILL: "1",
      CLASSIC_RISK_READY_FILE: readyFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = await waitForReady(readyFile);
  assert.ok(child.pid, "child pid");
  child.kill("SIGKILL");
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
    child.once("exit", (_code, sig) => resolve(sig));
  });
  return { method: "SIGKILL", signal, ready };
}

describe("Gate 0 Corrective 1", () => {
  it("C1: active lease gN clears predecessor halt from gN-1 and commits RUNNING at gN", () => {
    const dir = tmpDir("c1");
    const id = "c1-lease-bind";
    const caller = seedHalted(id, dir, halted({ leaseGeneration: "gN-1", haltId: "halt-C1" }));
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-C1" }, () =>
      acknowledgeDurableHalt(id, caller, dir, { activeLease: liveLease("gN") })
    );
    assert.equal(result.accepted, true, result.reasons.join(","));
    assert.equal(result.state.haltStatus, "RUNNING");
    assert.equal(result.state.leaseGeneration, "gN");
    assert.equal(result.state.lastAcknowledgement?.priorLeaseGeneration, "gN-1");
    assert.equal(result.state.lastAcknowledgement?.activeLeaseGeneration, "gN");
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.leaseGeneration, "gN");
    assert.equal(reloaded.lastAcknowledgement?.haltId, "halt-C1");
  });

  it("C2: crash after ACK write and before final verification stays fail-closed or complete+reconcile", async () => {
    const dir = tmpDir("c2");
    const id = "c2-ack-preverify";
    beginRuntimeSession({
      experimentDir: experimentDir(id, dir),
      experimentId: id,
      scopeKey: SCOPE,
      leaseGeneration: "gN",
    });
    seedHalted(id, dir, halted({ haltId: "halt-C2", leaseGeneration: "gN-1" }));
    const killed = await hardKillAck({
      id, dir, haltId: "halt-C2", lease: "gN-1", activeLease: "gN",
      crashStep: "BEFORE_FINAL_VERIFICATION",
    });
    assert.equal(killed.method, "SIGKILL");
    assert.equal(killed.signal, "SIGKILL");
    assertAcceptablePostCrash("C2", id, dir, "gN");
  });

  it("C3: crash before any post-ACK lease rebind cannot authorize stale-lease RUNNING", async () => {
    const dir = tmpDir("c3");
    const id = "c3-no-rebind";
    beginRuntimeSession({
      experimentDir: experimentDir(id, dir),
      experimentId: id,
      scopeKey: SCOPE,
      leaseGeneration: "gN",
    });
    seedHalted(id, dir, halted({ haltId: "halt-C3", leaseGeneration: "gN-1" }));
    const killed = await hardKillAck({
      id, dir, haltId: "halt-C3", lease: "gN-1", activeLease: "gN",
      crashStep: "AFTER_COMMIT",
    });
    assert.equal(killed.signal, "SIGKILL");
    const reloaded = reloadInFreshProcess(id, dir);
    if (reloaded.haltStatus === "RUNNING") {
      assert.notEqual(reloaded.leaseGeneration, "gN-1", "stale-lease RUNNING");
      assert.equal(reloaded.leaseGeneration, "gN");
      assert.ok(reloaded.lastAcknowledgement?.haltId);
    } else {
      assert.equal(reloaded.halted, true);
      assert.equal(reloaded.haltId, "halt-C3");
    }
    assert.equal(startupCheckFresh(id, dir, "gN+1").allowsTrading, false);
  });

  it("C4: lease lost immediately before ACK mutation does not clear", () => {
    const dir = tmpDir("c4");
    const id = "c4-lease-lost";
    const caller = seedHalted(id, dir, halted({ haltId: "halt-C4" }));
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-C4" }, () => {
      const acknowledged = acknowledgeDurableHalt(id, caller, dir, {
        activeLease: {
          generation: "gN",
          scopeKey: SCOPE,
          assertCurrent() { throw new Error("RUNTIME_LEASE_LOST"); },
        },
      });
      return { acknowledged, tokenRemaining: process.env.EXPERIMENT_HALT_ACK };
    });
    assert.equal(result.acknowledged.accepted, false);
    assert.equal(result.tokenRemaining, "halt-C4");
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, true);
    assert.equal(reloaded.haltId, "halt-C4");
  });

  it("C5: lease generation replaced between inspection and mutation does not clear", () => {
    const dir = tmpDir("c5");
    const id = "c5-lease-replaced";
    const caller = seedHalted(id, dir, halted({ haltId: "halt-C5", leaseGeneration: "gN-1" }));
    let flipped = false;
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-C5" }, () =>
      acknowledgeDurableHalt(id, caller, dir, {
        activeLease: {
          generation: "gN",
          scopeKey: SCOPE,
          assertCurrent() {
            if (flipped) throw new Error("RUNTIME_LEASE_GENERATION_MISMATCH");
          },
        },
        onAckStep(step) {
          if (step === "AFTER_PREDECESSOR_INSPECTION") flipped = true;
        },
      })
    );
    assert.equal(result.accepted, false);
    assert.ok(result.reasons.includes("RUNTIME_LEASE_LOST") || result.reasons.includes("RUNTIME_LEASE_GENERATION_MISMATCH") || result.reasons.includes("RISK_STATE_PERSIST_FAILED"));
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, true);
    assert.equal(reloaded.haltId, "halt-C5");
  });

  it("C6: stale owner cannot commit after a newer fencing generation exists", () => {
    const dir = tmpDir("c6");
    const id = "c6-stale-owner";
    seedHalted(id, dir, halted({ haltId: "halt-C6", leaseGeneration: "1" }));
    const fence = path.join(dir, "fence-generation");
    fs.writeFileSync(fence, "2", "utf8");
    const child = spawnSync(process.execPath, ["--import", "tsx", STALE_OWNER], {
      env: {
        ...process.env,
        CLASSIC_RISK_ID: id,
        CLASSIC_RISK_DIR: dir,
        CLASSIC_RISK_SCOPE: SCOPE,
        CLASSIC_RISK_STALE_GENERATION: "1",
        CLASSIC_RISK_FENCE_FILE: fence,
        CLASSIC_RISK_ACK_TOKEN: "halt-C6",
      },
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0, child.stdout);
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.halted, true);
    assert.equal(reloaded.haltId, "halt-C6");
  });

  it("C6b: real lease turnover — stale generation cannot clear after acquire of gN+1", async () => {
    const dir = tmpDir("c6b");
    const id = "c6b-lease";
    const expDir = experimentDir(id, dir);
    fs.mkdirSync(expDir, { recursive: true });
    const first = await acquireRuntimeLease({ experimentDir: expDir, experimentId: id, scopeKey: SCOPE });
    seedHalted(id, dir, halted({ haltId: "halt-C6b", leaseGeneration: String(first.generation) }));
    await first.release();
    const second = await acquireRuntimeLease({ experimentDir: expDir, experimentId: id, scopeKey: SCOPE });
    const fence = path.join(dir, "lease-fence");
    fs.writeFileSync(fence, String(second.generation), "utf8");
    const child = spawnSync(process.execPath, ["--import", "tsx", STALE_OWNER], {
      env: {
        ...process.env,
        CLASSIC_RISK_ID: id,
        CLASSIC_RISK_DIR: dir,
        CLASSIC_RISK_SCOPE: SCOPE,
        CLASSIC_RISK_STALE_GENERATION: String(first.generation),
        CLASSIC_RISK_FENCE_FILE: fence,
        CLASSIC_RISK_ACK_TOKEN: "halt-C6b",
      },
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0, child.stdout);
    const reloaded = reloadInFreshProcess(id, dir);
    assert.equal(reloaded.haltId, "halt-C6b");
    assert.equal(reloaded.halted, true);
    await second.release();
  });

  it("C7: durable ACK record contains exact haltId and predecessor lineage", () => {
    const dir = tmpDir("c7");
    const id = "c7-ack-record";
    const caller = seedHalted(id, dir, halted({ haltId: "halt-C7", leaseGeneration: "gN-1" }));
    const primary = JSON.parse(fs.readFileSync(path.join(experimentDir(id, dir), "risk-state.json"), "utf8"));
    const result = withEnv({ EXPERIMENT_HALT_ACK: "halt-C7" }, () =>
      acknowledgeDurableHalt(id, caller, dir, { activeLease: liveLease("gN") })
    );
    assert.equal(result.accepted, true);
    const rec = result.state.lastAcknowledgement;
    assert.ok(rec);
    assert.equal(rec.haltId, "halt-C7");
    assert.equal(rec.scopeKey, SCOPE);
    assert.equal(rec.predecessorStoreGeneration, primary.storeGeneration);
    assert.equal(rec.predecessorEnvelopeSha256, primary.envelopeSha256);
    assert.equal(rec.priorLeaseGeneration, "gN-1");
    assert.equal(rec.activeLeaseGeneration, "gN");
    const reloaded = reloadInFreshProcess(id, dir);
    assert.deepEqual(reloaded.lastAcknowledgement, rec);
    const hashed = JSON.parse(fs.readFileSync(path.join(experimentDir(id, dir), "risk-state.json"), "utf8"));
    assert.equal(hashed.payload.lastAcknowledgement.haltId, "halt-C7");
  });

  it("C8: both HALTING persist and final halt persist fail; emergency still runs", async () => {
    const dir = tmpDir("c8");
    const id = "c8-dual-persist-fail";
    const begun = beginRuntimeSession({
      experimentDir: experimentDir(id, dir),
      experimentId: id,
      scopeKey: SCOPE,
      leaseGeneration: "gN",
    });
    assert.equal(begun.allowsTrading, true, begun.reasonCode || "");
    seedHalted(id, dir, halted({ haltId: "halt-prior", leaseGeneration: "gN-1" }));
    withEnv({ EXPERIMENT_HALT_ACK: "halt-prior" }, () =>
      acknowledgeDurableHalt(id, loadRiskState(id, dir, SCOPE), dir, { activeLease: liveLease("gN") })
    );
    const running = loadRiskState(id, dir, SCOPE);
    assert.equal(running.haltStatus, "RUNNING");
    let cancelCalls = 0;
    let closeCalls = 0;
    const result = await runExperimentKillSwitch({
      ex: {
        async cancelAll() { cancelCalls += 1; },
        async closePosition() { closeCalls += 1; },
        async snapshot(market: string) {
          return { venue: "extended" as const, market, mid: 100_000, position: 0, openOrders: [] };
        },
      },
      market: "BTC",
      reasons: ["DAILY_LOSS"],
      experimentId: id,
      baseDir: dir,
      scopeKey: SCOPE,
      retryDelayMs: 0,
      persistOptions: {
        onAtomicWriteStep(step, target) {
          if (path.basename(target) === "risk-state.json" && step === "BEFORE_RENAME") {
            throw new Error("injected persist failure");
          }
        },
      },
    });
    assert.equal(cancelCalls, 1);
    assert.equal(closeCalls, 1);
    assert.equal(result.halted, true);
    assert.ok(result.errors.some((error) => /persist/i.test(error)));
    const durable = loadRiskState(id, dir, SCOPE);
    assert.equal(durable.haltStatus, "RUNNING", "older RUNNING bytes remain after both persist failures");
  });

  it("C9: fresh restart after C8 blocks normal operation despite older durable RUNNING", async () => {
    const dir = tmpDir("c9");
    const id = "c9-restart-block";
    beginRuntimeSession({
      experimentDir: experimentDir(id, dir),
      experimentId: id,
      scopeKey: SCOPE,
      leaseGeneration: "gN",
    });
    seedHalted(id, dir, halted({ haltId: "halt-prior", leaseGeneration: "gN-1" }));
    withEnv({ EXPERIMENT_HALT_ACK: "halt-prior" }, () =>
      acknowledgeDurableHalt(id, loadRiskState(id, dir, SCOPE), dir, { activeLease: liveLease("gN") })
    );
    await runExperimentKillSwitch({
      ex: {
        async cancelAll() {},
        async closePosition() {},
        async snapshot(market: string) {
          return { venue: "extended" as const, market, mid: 100_000, position: 0, openOrders: [] };
        },
      },
      market: "BTC",
      reasons: ["DAILY_LOSS"],
      experimentId: id,
      baseDir: dir,
      scopeKey: SCOPE,
      retryDelayMs: 0,
      persistOptions: {
        onAtomicWriteStep(step, target) {
          if (path.basename(target) === "risk-state.json" && step === "BEFORE_RENAME") {
            throw new Error("injected persist failure");
          }
        },
      },
    });
    assert.equal(reloadInFreshProcess(id, dir).haltStatus, "RUNNING");
    const startup = startupCheckFresh(id, dir, "gN+1");
    assert.equal(startup.allowsTrading, false);
    assert.ok(startup.reasonCode);
  });

  it("C10: session marker missing/corrupt/conflicting/stale fails closed", () => {
    const dir = tmpDir("c10");
    const id = "c10-session";
    const expDir = experimentDir(id, dir);
    fs.mkdirSync(expDir, { recursive: true });
    persistRiskState(id, halted({ haltId: "halt-C10" }), dir);
    assert.throws(
      () => requireVerifiedOpenSession({ experimentDir: expDir, experimentId: id, scopeKey: SCOPE, leaseGeneration: "gN" }),
      /RUNTIME_SESSION/
    );
    const missing = beginRuntimeSession({
      experimentDir: expDir,
      experimentId: id,
      scopeKey: SCOPE,
      leaseGeneration: "gN",
    });
    assert.equal(missing.allowsTrading, false);

    const cleanDir = tmpDir("c10-open");
    const cleanId = "c10-open";
    const opened = beginRuntimeSession({
      experimentDir: experimentDir(cleanId, cleanDir),
      experimentId: cleanId,
      scopeKey: SCOPE,
      leaseGeneration: "gN",
    });
    assert.equal(opened.allowsTrading, true);
    const sessionPath = path.join(experimentDir(cleanId, cleanDir), "runtime-session.json");
    fs.writeFileSync(sessionPath, "{broken", "utf8");
    assert.throws(
      () => requireVerifiedOpenSession({
        experimentDir: experimentDir(cleanId, cleanDir),
        experimentId: cleanId,
        scopeKey: SCOPE,
        leaseGeneration: "gN",
      }),
      /RUNTIME_SESSION/
    );
    const corruptBegin = beginRuntimeSession({
      experimentDir: experimentDir(cleanId, cleanDir),
      experimentId: cleanId,
      scopeKey: SCOPE,
      leaseGeneration: "gN",
    });
    assert.equal(corruptBegin.allowsTrading, false);

    const conflictDir = tmpDir("c10-conflict");
    const conflictId = "c10-conflict";
    beginRuntimeSession({
      experimentDir: experimentDir(conflictId, conflictDir),
      experimentId: conflictId,
      scopeKey: SCOPE,
      leaseGeneration: "gN",
    });
    const primary = path.join(experimentDir(conflictId, conflictDir), "runtime-session.json");
    const row = JSON.parse(fs.readFileSync(primary, "utf8"));
    fs.writeFileSync(`${primary}.bak`, JSON.stringify({
      ...row,
      writtenAt: "2026-08-22T00:00:09.000Z",
      envelopeSha256: "a".repeat(64),
    }, null, 2), "utf8");
    const conflict = beginRuntimeSession({
      experimentDir: experimentDir(conflictId, conflictDir),
      experimentId: conflictId,
      scopeKey: SCOPE,
      leaseGeneration: "gN",
    });
    assert.equal(conflict.allowsTrading, false);

    const staleDir = tmpDir("c10-stale");
    const staleId = "c10-stale";
    beginRuntimeSession({
      experimentDir: experimentDir(staleId, staleDir),
      experimentId: staleId,
      scopeKey: SCOPE,
      leaseGeneration: "gN",
    });
    assert.throws(
      () => requireVerifiedOpenSession({
        experimentDir: experimentDir(staleId, staleDir),
        experimentId: staleId,
        scopeKey: SCOPE,
        leaseGeneration: "gN-other",
      }),
      /STALE|LEASE|RUNTIME_SESSION/
    );
  });

  for (const step of ATOMIC_STEPS) {
    it(`C11: hard termination at backup ${step}`, async () => {
      const dir = tmpDir(`c11-${step.toLowerCase()}`);
      const id = `c11-${step.toLowerCase()}`;
      beginRuntimeSession({
        experimentDir: experimentDir(id, dir),
        experimentId: id,
        scopeKey: SCOPE,
        leaseGeneration: "gN",
      });
      seedHalted(id, dir, halted({ haltId: "halt-C11", leaseGeneration: "gN-1" }));
      const killed = await hardKillAck({
        id, dir, haltId: "halt-C11", lease: "gN-1", activeLease: "gN",
        crashStep: step,
        crashTarget: ".bak",
      });
      assert.equal(killed.method, "SIGKILL");
      assert.equal(killed.signal, "SIGKILL");
      assertAcceptablePostCrash(`C11 ${step}`, id, dir, "gN");
    });
  }

  for (const step of ATOMIC_STEPS) {
    it(`C12: hard termination at primary ${step}`, async () => {
      const dir = tmpDir(`c12-${step.toLowerCase()}`);
      const id = `c12-${step.toLowerCase()}`;
      beginRuntimeSession({
        experimentDir: experimentDir(id, dir),
        experimentId: id,
        scopeKey: SCOPE,
        leaseGeneration: "gN",
      });
      seedHalted(id, dir, halted({ haltId: "halt-C12", leaseGeneration: "gN-1" }));
      const killed = await hardKillAck({
        id, dir, haltId: "halt-C12", lease: "gN-1", activeLease: "gN",
        crashStep: step,
        crashTarget: "risk-state.json",
      });
      assert.equal(killed.method, "SIGKILL");
      assert.equal(killed.signal, "SIGKILL");
      assertAcceptablePostCrash(`C12 ${step}`, id, dir, "gN");
    });
  }

  for (const step of ACK_STEPS) {
    it(`C13: hard termination during ACK ${step}`, async () => {
      const dir = tmpDir(`c13-${step.toLowerCase()}`);
      const id = `c13-${step.toLowerCase()}`;
      beginRuntimeSession({
        experimentDir: experimentDir(id, dir),
        experimentId: id,
        scopeKey: SCOPE,
        leaseGeneration: "gN",
      });
      seedHalted(id, dir, halted({ haltId: "halt-C13", leaseGeneration: "gN-1" }));
      const killed = await hardKillAck({
        id, dir, haltId: "halt-C13", lease: "gN-1", activeLease: "gN",
        crashStep: step,
      });
      assert.equal(killed.method, "SIGKILL");
      assert.equal(killed.signal, "SIGKILL");
      assertAcceptablePostCrash(`C13 ${step}`, id, dir, "gN");
    });
  }

  it("C14: ACK token is consumed only after final exact durable state is verified", () => {
    const dir = tmpDir("c14");
    const id = "c14-token";
    const caller = seedHalted(id, dir, halted({ haltId: "halt-C14" }));
    const primary = path.join(experimentDir(id, dir), "risk-state.json");
    const failed = withEnv({ EXPERIMENT_HALT_ACK: "halt-C14" }, () => {
      const acknowledged = acknowledgeDurableHalt(id, caller, dir, {
        activeLease: liveLease("gN"),
        onAckStep(step) {
          if (step === "BEFORE_FINAL_VERIFICATION") {
            fs.writeFileSync(primary, "truncated-after-commit", "utf8");
          }
        },
      });
      return { acknowledged, tokenRemaining: process.env.EXPERIMENT_HALT_ACK };
    });
    assert.equal(failed.acknowledged.accepted, false);
    assert.equal(failed.tokenRemaining, "halt-C14");

    const dirOk = tmpDir("c14-ok");
    const idOk = "c14-ok";
    const callerOk = seedHalted(idOk, dirOk, halted({ haltId: "halt-C14" }));
    const ok = withEnv({ EXPERIMENT_HALT_ACK: "halt-C14" }, () => {
      const acknowledged = acknowledgeDurableHalt(idOk, callerOk, dirOk, { activeLease: liveLease("gN") });
      return { acknowledged, tokenRemaining: process.env.EXPERIMENT_HALT_ACK };
    });
    assert.equal(ok.acknowledged.accepted, true);
    assert.equal(ok.tokenRemaining, undefined);
    const reloaded = reloadInFreshProcess(idOk, dirOk);
    assert.equal(reloaded.haltStatus, "RUNNING");
    assert.equal(reloaded.lastAcknowledgement?.haltId, "halt-C14");
    assert.equal(reloaded.leaseGeneration, "gN");
  });

  it("C15: same incident preserves haltId; a later incident mints a new haltId", () => {
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
    const incident = first.next.haltId;
    assert.ok(incident);
    const dir = tmpDir("c15");
    const id = "c15-identity";
    persistRiskState(id, { ...first.next, haltStatus: "HALTED_UNFLAT", acknowledged: false }, dir);
    persistRiskState(id, { ...first.next, haltStatus: "HALTED_FLAT", acknowledged: false, updatedAt: "2026-08-22T00:00:02.000Z" }, dir);
    const same = reloadInFreshProcess(id, dir);
    assert.equal(same.haltId, incident);
    const acked = withEnv({ EXPERIMENT_HALT_ACK: incident }, () =>
      acknowledgeDurableHalt(id, same, dir, { activeLease: liveLease("gN") })
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
    assert.ok(second.next.haltId);
    assert.notEqual(second.next.haltId, incident);
  });
});
