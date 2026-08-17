import { acquireRuntimeLease, startRuntimeLeaseHeartbeat } from "../../src/runtimeLease.js";

const experimentDir = String(process.env.RUNTIME_LEASE_TEST_DIR || "");
const experimentId = String(process.env.RUNTIME_LEASE_TEST_EXPERIMENT || "lease-child");
const scopeKey = String(process.env.RUNTIME_LEASE_TEST_SCOPE || "extended:BTC");
const mode = String(process.env.RUNTIME_LEASE_TEST_MODE || "once");
const expiryMs = Number(process.env.RUNTIME_LEASE_TEST_EXPIRY_MS || 100);

if (!experimentDir) throw new Error("RUNTIME_LEASE_TEST_DIR_REQUIRED");

try {
  const lease = await acquireRuntimeLease({ experimentDir, experimentId, scopeKey, expiryMs });
  const heartbeat = mode === "hold-heartbeat"
    ? startRuntimeLeaseHeartbeat({ lease, intervalMs: 20 })
    : null;
  process.stdout.write(`${JSON.stringify({ ready: true, generation: lease.generation, pid: process.pid })}\n`);
  if (mode === "once") {
    await lease.release();
  } else {
    const keepAlive = setInterval(() => {}, 1_000);
    const shutdown = async () => {
      clearInterval(keepAlive);
      heartbeat?.stop();
      await lease.release();
      process.exitCode = 0;
    };
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
  }
} catch (error: any) {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exitCode = 2;
}
