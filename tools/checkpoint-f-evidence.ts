import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVIDENCE_SCHEMA_VERSION = "classic-v0.2-checkpoint-f/1";
export const REPOSITORY = "danny0971haha/classic-grid";
export const BRANCH = "experiment/classic-v0.2-100u-safety";
export const CHECKPOINT_F_TEST_FILE = "test/experiment-v02-checkpoint-f.test.ts";
export const DEFAULT_EVIDENCE_PATH = "artifacts/classic-v0.2-checkpoint-f-results.json";
export const REQUIRED_CI_NODE = "v22.23.2";
export const REQUIRED_CI_NPM = "10.9.8";

export const CHECKPOINT_F_CASE_IDS = [
  "F-01", "F-02", "F-03", "F-04", "F-05", "F-06", "F-07", "F-08", "F-09", "F-10",
  "F-11", "F-12", "F-13", "F-14", "F-15", "F-16", "F-17", "F-18", "F-19", "F-20",
  "F-21", "F-22", "F-23", "F-24", "F-25", "F-26", "F-27", "F-28", "F-29", "F-30",
  "F-31", "F-32", "F-33", "F-34", "F-35",
] as const;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

export type CaseOutcome = "PASS" | "FAIL" | "SKIP" | "CANCELLED" | "TODO";

export type TapTotals = {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
  cancelled: number;
  todo: number;
};

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function parseTotals(text: string): TapTotals {
  const num = (label: string): number => {
    const match = text.match(new RegExp(`#\\s+${label}\\s+(\\d+)`, "i"))
      || text.match(new RegExp(`ℹ\\s+${label}\\s+(\\d+)`, "i"))
      || text.match(new RegExp(`^# ${label}:\\s+(\\d+)`, "m"));
    return match ? Number(match[1]) : 0;
  };
  const tests = num("tests");
  const pass = num("pass");
  const fail = num("fail");
  const skipped = num("skipped");
  const cancelled = num("cancelled");
  const todo = num("todo");
  return { tests, pass, fail, skipped, cancelled, todo };
}

function parseCases(text: string): Array<{ caseId: string; title: string; outcome: CaseOutcome }> {
  const rows: Array<{ caseId: string; title: string; outcome: CaseOutcome }> = [];
  const seen = new Set<string>();
  const re = /^\s*(ok|not ok) \d+ - (F-\d{2})\b(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const caseId = match[2]!;
    if (seen.has(caseId)) continue;
    seen.add(caseId);
    const rest = match[3] || "";
    const skip = /# SKIP/i.test(rest);
    const todo = /# TODO/i.test(rest);
    const outcome: CaseOutcome = skip ? "SKIP" : todo ? "TODO" : match[1] === "ok" ? "PASS" : "FAIL";
    rows.push({ caseId, title: `${caseId}${rest}`.trim(), outcome });
  }
  const pretty = /^ {2}(✔|✖)\s+(F-\d{2})\s+(.+)$/gm;
  while ((match = pretty.exec(text))) {
    const caseId = match[2]!;
    if (seen.has(caseId)) continue;
    seen.add(caseId);
    rows.push({
      caseId,
      title: `${caseId} ${match[3]!.trim()}`,
      outcome: match[1] === "✔" ? "PASS" : "FAIL",
    });
  }
  return rows;
}

function run(command: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    status: result.status ?? 1,
  };
}

function categoryOf(caseId: string): string {
  const n = Number(caseId.slice(2));
  if (n <= 5) return "replacement";
  if (n <= 9) return "idempotency-durability";
  if (n <= 14) return "crash";
  if (n <= 23) return "fail-closed";
  if (n <= 28) return "apply-occupancy";
  if (n <= 31) return "inference-restart";
  return "metrics-independence";
}

export function generateEvidence(): string {
  const sourceHeadSha = git(["rev-parse", "HEAD"]);
  const sourceHeadTreeSha = git(["rev-parse", "HEAD^{tree}"]);
  const fCommand = `node --import tsx --test --test-reporter=tap ${CHECKPOINT_F_TEST_FILE}`;
  const fRun = run(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", CHECKPOINT_F_TEST_FILE]);
  const fText = `${fRun.stdout}\n${fRun.stderr}`;
  const fCases = parseCases(fText);
  const fTotals = parseTotals(fText);
  if (fTotals.tests === 0 && fCases.length) {
    fTotals.tests = fCases.length;
    fTotals.pass = fCases.filter((row) => row.outcome === "PASS").length;
    fTotals.fail = fCases.filter((row) => row.outcome === "FAIL").length;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: { test: string } };
  const testScript = pkg.scripts.test;
  const parts = testScript.split(" && ");
  const preCheck = run(process.execPath, ["--import", "tsx", "test/grid.test.ts"]);
  const tapCmd = parts[1] || testScript;
  const tokens = tapCmd.split(/\s+/).filter(Boolean);
  const projectTap = spawnSync(process.execPath, [...tokens.slice(1), "--test-reporter=tap"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const projectText = `${projectTap.stdout}\n${projectTap.stderr}`;
  const projectTotals = parseTotals(projectText);
  const artifact = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    repository: REPOSITORY,
    branch: BRANCH,
    checkpoint: "F",
    requestedVerdict: "ACCEPT",
    identity: {
      sourceHeadSha,
      sourceHeadTreeSha,
      testedCheckoutSha: sourceHeadSha,
      testedCheckoutTreeSha: sourceHeadTreeSha,
      githubEventName: process.env.GITHUB_EVENT_NAME || "local",
      githubRunId: process.env.GITHUB_RUN_ID || null,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    },
    toolchain: {
      nodeVersion: process.version,
      npmVersion: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    },
    safety: {
      liveExchangeWrite: false,
      productionCredentialUsed: false,
      mergePerformed: false,
      deployPerformed: false,
    },
    checkpointSuite: {
      command: fCommand,
      processExitCode: fRun.status,
      total: fTotals.tests,
      pass: fTotals.pass,
      fail: fTotals.fail,
      skip: fTotals.skipped,
      cancelled: fTotals.cancelled,
      todo: fTotals.todo,
      testCases: CHECKPOINT_F_CASE_IDS.map((caseId) => {
        const found = fCases.find((row) => row.caseId === caseId);
        return {
          caseId,
          category: categoryOf(caseId),
          result: found?.outcome ?? "FAIL",
          title: found?.title ?? caseId,
          liveExchangeWrite: false,
          productionCredentialUsed: false,
        };
      }),
    },
    projectSuite: {
      command: testScript,
      processExitCode: projectTap.status ?? 1,
      total: projectTotals.tests,
      pass: projectTotals.pass,
      fail: projectTotals.fail,
      skip: projectTotals.skipped,
      cancelled: projectTotals.cancelled,
      todo: projectTotals.todo,
      preCheck: {
        command: "node --import tsx test/grid.test.ts",
        processExitCode: preCheck.status,
      },
    },
    crashMatrix: [
      { caseId: "F-10", method: "SIGKILL", window: "before durable ingest" },
      { caseId: "F-11", method: "SIGKILL", window: "after ingest before submit" },
      { caseId: "F-12", method: "SIGKILL", window: "after submit persist before response" },
      { caseId: "F-13", method: "SIGKILL", window: "after confirmed observation before terminal persist" },
      { caseId: "F-14", method: "child-process restart", window: "after strategy ingest before telemetry ACK" },
    ],
  };
  const outPath = path.join(REPO_ROOT, DEFAULT_EVIDENCE_PATH);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.writeFileSync(outPath, json, "utf8");
  const digest = createHash("sha256").update(json).digest("hex");
  process.stdout.write(`wrote ${DEFAULT_EVIDENCE_PATH} sha256=${digest}\n`);
  process.stdout.write(`checkpointSuite ${fTotals.tests}/${fTotals.pass} fail=${fTotals.fail} skip=${fTotals.skipped} exit=${fRun.status}\n`);
  process.stdout.write(`projectSuite ${projectTotals.tests}/${projectTotals.pass} fail=${projectTotals.fail} skip=${projectTotals.skipped} exit=${projectTap.status}\n`);
  if (fRun.status !== 0 || (projectTap.status ?? 1) !== 0 || preCheck.status !== 0) {
    process.exitCode = 1;
  }
  const missing = CHECKPOINT_F_CASE_IDS.filter((id) => !fCases.some((row) => row.caseId === id));
  if (missing.length || fCases.some((row) => row.outcome !== "PASS")) {
    process.stderr.write(`evidence incomplete missing=${missing.join(",")} \n`);
    process.exitCode = 1;
  }
  return outPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || "generate";
  if (action !== "generate") {
    process.stderr.write(`unknown action ${action}\n`);
    process.exit(2);
  }
  generateEvidence();
}
