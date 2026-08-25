import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../fixtures/checkpoint-f-worker.ts", import.meta.url));

function lastJson(stdout: string): any {
  const lines = String(stdout || "").trim().split("\n").filter(Boolean);
  let parsed: any = null;
  for (const line of lines) {
    try { parsed = JSON.parse(line); } catch { /* ignore */ }
  }
  return parsed;
}

export function spawnFWorker(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--import", "tsx", WORKER], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    lastJson: lastJson(String(result.stdout || "")),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(file: string, timeoutMs = 12_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    await sleep(20);
  }
  throw new Error(`ready file not written: ${file}`);
}

export async function hardKillFWorker(p: {
  action: string;
  ledgerPath: string;
  experimentId: string;
  tradeId: string;
  crashAt: string;
  cursorPath?: string;
}): Promise<{ method: "SIGKILL"; signal: NodeJS.Signals | null; ready: string; pid: number | undefined }> {
  if (process.platform === "win32") {
    throw new Error("STRATEGY_LEDGER_SIGKILL_UNSUPPORTED_WIN32");
  }
  const readyFile = `${p.ledgerPath}.ready`;
  try { fs.unlinkSync(readyFile); } catch { /* first run */ }
  const child = spawn(process.execPath, ["--import", "tsx", WORKER], {
    env: {
      ...process.env,
      CLASSIC_F_ACTION: p.action,
      CLASSIC_F_LEDGER_PATH: p.ledgerPath,
      CLASSIC_F_EXPERIMENT_ID: p.experimentId,
      CLASSIC_F_TRADE_ID: p.tradeId,
      CLASSIC_F_CRASH_AT: p.crashAt,
      CLASSIC_F_HARD_KILL: "1",
      CLASSIC_F_READY_FILE: readyFile,
      ...(p.cursorPath ? { CLASSIC_F_CURSOR_PATH: p.cursorPath } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = await waitForReady(readyFile);
  assert.ok(child.pid, "child pid");
  child.kill("SIGKILL");
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
    child.once("exit", (_code, sig) => resolve(sig));
  });
  return { method: "SIGKILL", signal, ready, pid: child.pid };
}
