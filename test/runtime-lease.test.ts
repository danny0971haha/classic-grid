import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  acquireRuntimeLease,
  startRuntimeLeaseHeartbeat,
  withLeaseFence,
} from "../src/runtimeLease.js";

const CHILD = fileURLToPath(new URL("./helpers/runtimeLeaseChild.ts", import.meta.url));
const RUN_CLI = fileURLToPath(new URL("../src/cli/run.ts", import.meta.url));
const LOOP_FAULT_CHILD = fileURLToPath(new URL("./helpers/runtimeLoopFaultChild.ts", import.meta.url));
const TSX_IMPORT = import.meta.resolve("tsx");
const BASE_CHILD_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnLeaseChild(dir: string, mode: "once" | "hold" | "hold-heartbeat", expiryMs = 100): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", TSX_IMPORT, CHILD], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...BASE_CHILD_ENV,
      RUNTIME_LEASE_TEST_DIR: dir,
      RUNTIME_LEASE_TEST_EXPERIMENT: "lease-child",
      RUNTIME_LEASE_TEST_SCOPE: "extended:BTC",
      RUNTIME_LEASE_TEST_MODE: mode,
      RUNTIME_LEASE_TEST_EXPIRY_MS: String(expiryMs),
    },
  });
}

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer | string) => {
      buffered += String(chunk);
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        cleanup();
        resolve(buffered.slice(0, newline));
      }
    };
    const onEnd = () => { cleanup(); reject(new Error(`stream ended before line: ${buffered}`)); };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = waitForExit(child);
  child.kill("SIGTERM");
  await exited;
}

describe("runtime lease", () => {
  it("holds an OS socket, heartbeats metadata, and increments durable generation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-runtime-lease-"));
    const first = await acquireRuntimeLease({
      experimentDir: dir,
      experimentId: "lease-local",
      scopeKey: "extended:BTC",
    });
    const before = JSON.parse(fs.readFileSync(first.metadataPath, "utf8")).heartbeatAt;
    const heartbeat = startRuntimeLeaseHeartbeat({ lease: first, intervalMs: 10 });
    await sleep(35);
    heartbeat.stop();
    const after = JSON.parse(fs.readFileSync(first.metadataPath, "utf8")).heartbeatAt;
    assert.ok(Date.parse(after) >= Date.parse(before));
    await assert.rejects(
      acquireRuntimeLease({ experimentDir: dir, experimentId: "lease-local", scopeKey: "extended:BTC" }),
      /RUNTIME_LEASE_ACTIVE_SOCKET/
    );
    await first.release();
    const second = await acquireRuntimeLease({
      experimentDir: dir,
      experimentId: "lease-local",
      scopeKey: "extended:BTC",
    });
    assert.ok(second.generation > first.generation);
    await second.release();
  });

  it("rejects a true second process even after heartbeat metadata expires", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-runtime-stall-"));
    const owner = spawnLeaseChild(dir, "hold", 25);
    try {
      const ready = JSON.parse(await firstLine(owner.stdout));
      assert.equal(ready.ready, true);
      await sleep(60);
      const contender = spawnLeaseChild(dir, "once", 25);
      const stderr = firstLine(contender.stderr);
      const result = await waitForExit(contender);
      assert.equal(result.code, 2);
      assert.match(await stderr, /RUNTIME_LEASE_ACTIVE_SOCKET/);
    } finally {
      await stopChild(owner);
    }
  });

  it("recovers a stale socket after SIGKILL and advances generation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-runtime-sigkill-"));
    const owner = spawnLeaseChild(dir, "hold-heartbeat", 100);
    const ready = JSON.parse(await firstLine(owner.stdout));
    const ownerExit = waitForExit(owner);
    owner.kill("SIGKILL");
    await ownerExit;
    await sleep(125);

    const successor = spawnLeaseChild(dir, "once", 100);
    const successorLine = firstLine(successor.stdout);
    const successorExit = await waitForExit(successor);
    assert.equal(successorExit.code, 0);
    const next = JSON.parse(await successorLine);
    assert.ok(next.generation > ready.generation);
  });

  it("blocks the transport callback when generation metadata is replaced", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-runtime-fence-"));
    const lease = await acquireRuntimeLease({
      experimentDir: dir,
      experimentId: "lease-fence",
      scopeKey: "extended:BTC",
    });
    const row = JSON.parse(fs.readFileSync(lease.metadataPath, "utf8"));
    row.generation += 1;
    fs.writeFileSync(lease.metadataPath, JSON.stringify(row), "utf8");
    let transportCalled = false;
    await assert.rejects(
      withLeaseFence(lease, async () => {
        transportCalled = true;
      }),
      /RUNTIME_LEASE_GENERATION_MISMATCH/
    );
    assert.equal(transportCalled, false);
    await lease.release();
  });

  it("fails closed instead of pretending the local socket fences another host", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-runtime-cross-host-"));
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, "runtime.lease.json"), JSON.stringify({
      schemaVersion: 2,
      experimentId: "lease-cross-host",
      scopeKey: "extended:BTC",
      leaseId: "foreign-lease",
      generation: 1,
      pid: 999_999,
      hostname: "different-host",
      processBootId: "foreign-boot",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      socketPath: path.join(dir, "runtime.lease.sock"),
    }), "utf8");
    await assert.rejects(
      acquireRuntimeLease({
        experimentDir: dir,
        experimentId: "lease-cross-host",
        scopeKey: "extended:BTC",
      }),
      /RUNTIME_LEASE_CROSS_HOST_UNSUPPORTED/
    );
  });

  it("releases the process-owned lease when corrupt recovery fails after acquisition", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "classic-runtime-lifecycle-"));
    const experimentId = "lease-lifecycle";
    const experimentDir = path.join(cwd, "data", "experiments", experimentId);
    fs.mkdirSync(experimentDir, { recursive: true });
    fs.writeFileSync(path.join(experimentDir, "recovery-checkpoint.json"), "{corrupt", "utf8");
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, RUN_CLI, "--once"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...BASE_CHILD_ENV,
        DRY_RUN: "1",
        EXPERIMENT_MODE: "1",
        EXPERIMENT_ID: experimentId,
        SOFT_RESUME: "1",
        VENUES: "extended",
        MARKETS: "BTC",
      },
    });
    let childStderr = "";
    child.stderr.on("data", (chunk) => { childStderr += String(chunk); });
    const result = await waitForExit(child);
    assert.notEqual(result.code, 0);
    const successor = await acquireRuntimeLease({
      experimentDir,
      experimentId,
      scopeKey: "dry-run:extended:BTC",
    });
    const successorGeneration = successor.generation;
    await successor.release();
    assert.ok(successorGeneration >= 2, childStderr);
  });

  it("releases the lease for every injected post-acquisition startup failure", async () => {
    const stages = [
      "BEFORE_TELEMETRY",
      "BEFORE_RISK_LOAD",
      "AFTER_CHECKPOINT",
      "BEFORE_EXECUTOR_CREATE",
      "BEFORE_CONNECT",
      "BEFORE_OFFICIAL_REFRESH",
    ] as const;
    for (let index = 0; index < stages.length; index++) {
      const stage = stages[index]!;
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "classic-runtime-stage-"));
      const experimentId = `lease-stage-${index}`;
      const experimentDir = path.join(cwd, "data", "experiments", experimentId);
      const child = spawn(process.execPath, ["--import", TSX_IMPORT, LOOP_FAULT_CHILD], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...BASE_CHILD_ENV,
          DRY_RUN: "1",
          EXPERIMENT_MODE: "1",
          EXPERIMENT_ID: experimentId,
          SOFT_RESUME: "1",
          VENUES: "extended",
          MARKETS: "BTC",
          DASHBOARD_PORT: String(21_000 + index),
          RUNTIME_LOOP_FAULT: stage,
        },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const result = await waitForExit(child);
      assert.equal(result.code, 2, `${stage}: ${stderr}`);
      assert.match(stderr, new RegExp(`INJECTED_LIFECYCLE_FAULT:${stage}`));
      const successor = await acquireRuntimeLease({
        experimentDir,
        experimentId,
        scopeKey: "dry-run:extended:BTC",
      });
      assert.ok(successor.generation >= 2, stage);
      await successor.release();
    }
  });
});
