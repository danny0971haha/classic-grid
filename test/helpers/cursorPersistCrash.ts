import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../fixtures/execution-cursor-crash-worker.ts", import.meta.url));

export type CursorInspect = {
  label: string;
  exists: boolean;
  landedValid: boolean | null;
  diskPendingTradeIds: string[];
  diskPublishedCount: number;
  authority: string;
  blocked: boolean;
  snapshotTradeIds: Array<string | undefined>;
  authoritativeCount: number;
  drainAuthoritativeIds: Array<string | undefined>;
  faultCodes: string[];
};

export type CursorReplay = {
  label: string;
  fills: string[];
  drainAuthoritativeIds: Array<string | undefined>;
  blocked: boolean;
  faultCodes: string[];
  authoritativeCount: number;
};

function lastJson(stdout: string): any {
  const lines = String(stdout || "").trim().split("\n").filter(Boolean);
  let parsed: any = null;
  for (const line of lines) {
    try { parsed = JSON.parse(line); } catch { /* ignore non-JSON */ }
  }
  return parsed;
}

function spawnWorker(env: Record<string, string>) {
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

export function inspectCursorFresh(p: {
  cursorPath: string;
  experimentId: string;
}): CursorInspect {
  const child = spawnWorker({
    CLASSIC_CURSOR_ACTION: "inspect",
    CLASSIC_CURSOR_PATH: p.cursorPath,
    CLASSIC_CURSOR_EXPERIMENT_ID: p.experimentId,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.ok(child.lastJson, child.stderr || child.stdout);
  return child.lastJson as CursorInspect;
}

export function replayCursorFresh(p: {
  cursorPath: string;
  experimentId: string;
  tradeId: string;
}): CursorReplay {
  const child = spawnWorker({
    CLASSIC_CURSOR_ACTION: "replay",
    CLASSIC_CURSOR_PATH: p.cursorPath,
    CLASSIC_CURSOR_EXPERIMENT_ID: p.experimentId,
    CLASSIC_CURSOR_TRADE_ID: p.tradeId,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.ok(child.lastJson, child.stderr || child.stdout);
  return child.lastJson as CursorReplay;
}

export async function hardKillCursorAccept(p: {
  cursorPath: string;
  experimentId: string;
  tradeId: string;
  crashAt: string;
}): Promise<{ method: "SIGKILL"; signal: NodeJS.Signals | null; ready: string; pid: number | undefined }> {
  if (process.platform === "win32") {
    throw new Error("CURSOR_SIGKILL_UNSUPPORTED_WIN32");
  }
  const readyFile = `${p.cursorPath}.ready`;
  try { fs.unlinkSync(readyFile); } catch { /* first run */ }
  const child = spawn(process.execPath, ["--import", "tsx", WORKER], {
    env: {
      ...process.env,
      CLASSIC_CURSOR_ACTION: "accept",
      CLASSIC_CURSOR_PATH: p.cursorPath,
      CLASSIC_CURSOR_EXPERIMENT_ID: p.experimentId,
      CLASSIC_CURSOR_TRADE_ID: p.tradeId,
      CLASSIC_CURSOR_CRASH_AT: p.crashAt,
      CLASSIC_CURSOR_HARD_KILL: "1",
      CLASSIC_CURSOR_READY_FILE: readyFile,
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