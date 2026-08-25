import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EVIDENCE_SCHEMA_VERSION = "classic-v0.2-checkpoint-f/2";
export const REPOSITORY = "danny0971haha/classic-grid";
export const BRANCH = "experiment/classic-v0.2-100u-safety";
export const PR_BASE_REF = "origin/experiment/classic-v0.1";
export const CHECKPOINT_F_TEST_FILE = "test/experiment-v02-checkpoint-f.test.ts";
export const DEFAULT_EVIDENCE_COMMAND =
  `node --import tsx --test --test-reporter=tap ${CHECKPOINT_F_TEST_FILE}`;
export const DEFAULT_PRECHECK_COMMAND = "node --import tsx test/grid.test.ts";
export const DEFAULT_EVIDENCE_PATH = "artifacts/classic-v0.2-checkpoint-f-results.json";
export const MIN_PROJECT_SUITE_TOTAL = 393;
export const REQUIRED_CI_NODE = "v22.23.2";
export const REQUIRED_CI_NPM = "10.9.8";
export const NULL_SHA = "0".repeat(40);
export const SOURCE_HEAD_SHA_ENV = "EVIDENCE_SOURCE_HEAD_SHA";
export const BASE_SHA_ENV = "EVIDENCE_BASE_SHA";

export const CHECKPOINT_F_CASE_IDS = [
  "F-01", "F-02", "F-03", "F-04", "F-05", "F-06", "F-07", "F-08", "F-09", "F-10",
  "F-11", "F-12", "F-13", "F-14", "F-15", "F-16", "F-17", "F-18", "F-19", "F-20",
  "F-21", "F-22", "F-23", "F-24", "F-25", "F-26", "F-27", "F-28", "F-29", "F-30",
  "F-31", "F-32", "F-33", "F-34", "F-35", "F-36", "F-37", "F-38", "F-39", "F-40",
] as const;

export type CheckpointFCaseId = typeof CHECKPOINT_F_CASE_IDS[number];

export const REQUIRED_HASH_PATHS = [
  CHECKPOINT_F_TEST_FILE,
  "test/experiment-v02-checkpoint-f-evidence.test.ts",
  "test/fixtures/checkpoint-f-worker.ts",
  "test/helpers/strategyLedgerCrash.ts",
  "tools/checkpoint-f-evidence.ts",
  "docs/classic-v0.2-checkpoint-f.md",
  "docs/classic-v0.2-implementation-contract.md",
  ".github/workflows/ci.yml",
] as const;

export const LEGACY_SCHEMA_KEYS = [
  "requestedVerdict",
  "eCases",
  "fullSuite",
  "testedCommitSha",
  "testedTreeSha",
] as const;

export type CaseOutcome = "PASS" | "FAIL" | "SKIP" | "CANCELLED" | "TODO";
export type GithubEventName = "local" | "push" | "pull_request";

export type EvidenceErrorCode =
  | "PROCESS_NONZERO_EXIT"
  | "PRECHECK_NONZERO_EXIT"
  | "MISSING_CASE"
  | "DUPLICATE_CASE"
  | "UNEXPECTED_CASE"
  | "CASE_FAILED"
  | "CASE_SKIPPED"
  | "CASE_CANCELLED"
  | "CASE_TODO"
  | "SUITE_FAILED"
  | "SUITE_SKIPPED"
  | "SUITE_CANCELLED"
  | "SUITE_TODO"
  | "TOTALS_MISMATCH"
  | "TAP_SUMMARY_MISSING"
  | "MISSING_SOURCE_IDENTITY"
  | "INVALID_SOURCE_SHA"
  | "SOURCE_COMMIT_UNAVAILABLE"
  | "SOURCE_NOT_IN_CHECKOUT_ANCESTRY"
  | "SOURCE_CHECKOUT_MISMATCH"
  | "SOURCE_IDENTITY_CONFLICT"
  | "SOURCE_TREE_MISMATCH"
  | "TESTED_TREE_MISMATCH"
  | "STALE_SOURCE_HEAD_SHA"
  | "STALE_SOURCE_HEAD_TREE"
  | "STALE_TESTED_CHECKOUT_SHA"
  | "STALE_TESTED_CHECKOUT_TREE"
  | "IDENTITY_COLLISION"
  | "PROJECT_SUITE_IS_CHECKPOINT"
  | "PROJECT_SUITE_TOO_SMALL"
  | "MALFORMED_TOTALS"
  | "SCHEMA_INVALID"
  | "FILE_HASH_MISMATCH"
  | "LIVE_WRITE_CLAIM";

export class EvidenceError extends Error {
  readonly code: EvidenceErrorCode;
  constructor(code: EvidenceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "EvidenceError";
    this.code = code;
  }
}

export type ParsedFCase = {
  caseId: string;
  title: string;
  ok: boolean;
  skip: boolean;
  todo: boolean;
  cancelled: boolean;
  outcome: CaseOutcome;
};

export type TapTotals = {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
  cancelled: number;
  todo: number;
};

export type ParsedCheckpointFTap = {
  cases: ParsedFCase[];
  totals: TapTotals;
};

export type EvidenceCaseRow = {
  caseId: CheckpointFCaseId;
  category: string;
  result: CaseOutcome;
  title: string;
  liveExchangeWrite: false;
  productionCredentialUsed: false;
};

export type CountBlock = {
  total: number;
  pass: number;
  fail: number;
  skip: number;
  cancelled: number;
  todo: number;
};

export type SuiteExecution = {
  command: string;
  processExitCode: number;
};

export type CheckpointSuiteBlock = SuiteExecution & CountBlock & {
  testCases: EvidenceCaseRow[];
};

export type ProjectSuiteBlock = SuiteExecution & CountBlock & {
  preCheck: SuiteExecution;
};

export type EvidenceIdentity = {
  sourceHeadSha: string;
  sourceHeadTreeSha: string;
  testedCheckoutSha: string;
  testedCheckoutTreeSha: string;
  baseSha: string;
  githubEventName: GithubEventName;
  githubRunId: string;
  githubRunAttempt: string;
  githubJobId: string;
};

export type CheckpointFEvidence = {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  repository: typeof REPOSITORY;
  branch: string;
  checkpoint: "F";
  identity: EvidenceIdentity;
  toolchain: {
    nodeVersion: string;
    npmVersion: string;
  };
  safety: {
    liveExchangeWrite: false;
    productionCredentialUsed: false;
    mergePerformed: false;
    deployPerformed: false;
  };
  checkpointSuite: CheckpointSuiteBlock;
  projectSuite: ProjectSuiteBlock;
  generatedAt: string;
  fileHashes: Record<string, string>;
};

export type GenerateMeta = {
  branch: string;
  identity: EvidenceIdentity;
  toolchain: {
    nodeVersion: string;
    npmVersion: string;
  };
  checkpoint: SuiteExecution;
  project: SuiteExecution & { preCheck: SuiteExecution };
  generatedAt?: string;
  fileHashes: Record<string, string>;
};

const CASE_LINE = /^(\s*)(ok|not ok)\s+\d+\s+-\s+(F-\d{2})\b(.*)$/;
const TOTAL_LINE = /^#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/;
const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(HERE), "..");
const SPAWN_OPTS = { encoding: "utf8" as const, maxBuffer: 32 * 1024 * 1024 };

export function categoryFor(caseId: string): string {
  const n = Number(caseId.slice(2));
  if (n <= 5) return "replacement";
  if (n <= 9) return "idempotency-durability";
  if (n <= 14) return "crash";
  if (n <= 23) return "fail-closed";
  if (n <= 28) return "apply-occupancy";
  if (n <= 31) return "inference-restart";
  if (n <= 35) return "metrics-independence";
  return "adversarial-authority";
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function collectFileHashes(root = REPO_ROOT): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const rel of REQUIRED_HASH_PATHS) {
    hashes[rel] = sha256File(path.join(root, rel));
  }
  return hashes;
}

export function outcomeOf(p: {
  ok: boolean;
  skip: boolean;
  todo: boolean;
  cancelled: boolean;
}): CaseOutcome {
  if (p.skip) return "SKIP";
  if (p.todo) return "TODO";
  if (p.cancelled) return "CANCELLED";
  return p.ok ? "PASS" : "FAIL";
}

export function renderCheckpointFTap(p: {
  cases: Array<{
    id: string;
    title?: string;
    ok?: boolean;
    skip?: boolean;
    todo?: boolean;
    cancelled?: boolean;
  }>;
  totals?: Partial<TapTotals>;
}): string {
  const lines = ["TAP version 13", "# Subtest: Checkpoint F authoritative execution consumption"];
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  let cancelled = 0;
  let todo = 0;
  p.cases.forEach((row, index) => {
    const title = row.title ?? row.id;
    const ok = row.ok !== false && !row.cancelled;
    let directive = "";
    if (row.skip) directive = " # SKIP fixture";
    else if (row.todo) directive = " # TODO fixture";
    const status = ok && !row.skip && !row.todo && !row.cancelled ? "ok" : row.skip || row.todo ? "ok" : "not ok";
    lines.push(`    # Subtest: ${title}`);
    lines.push(`    ${status} ${index + 1} - ${title}${directive}`);
    if (row.cancelled) {
      lines.push("      ---");
      lines.push("      failureType: 'cancelledByParent'");
      lines.push("      ...");
    }
    if (row.skip) skipped += 1;
    else if (row.todo) todo += 1;
    else if (row.cancelled) cancelled += 1;
    else if (status === "ok") pass += 1;
    else fail += 1;
  });
  lines.push(`    1..${p.cases.length}`);
  lines.push("ok 1 - Checkpoint F authoritative execution consumption");
  lines.push("  ---");
  lines.push("  type: 'suite'");
  lines.push("  ...");
  lines.push("1..1");
  const totals: TapTotals = {
    tests: p.totals?.tests ?? p.cases.length,
    pass: p.totals?.pass ?? pass,
    fail: p.totals?.fail ?? fail,
    skipped: p.totals?.skipped ?? skipped,
    cancelled: p.totals?.cancelled ?? cancelled,
    todo: p.totals?.todo ?? todo,
  };
  lines.push(`# tests ${totals.tests}`);
  lines.push("# suites 1");
  lines.push(`# pass ${totals.pass}`);
  lines.push(`# fail ${totals.fail}`);
  lines.push(`# cancelled ${totals.cancelled}`);
  lines.push(`# skipped ${totals.skipped}`);
  lines.push(`# todo ${totals.todo}`);
  lines.push("# duration_ms 1");
  return `${lines.join("\n")}\n`;
}

export function renderProjectTap(p: Partial<TapTotals> & { tests: number; pass: number }): string {
  const totals: TapTotals = {
    tests: p.tests,
    pass: p.pass,
    fail: p.fail ?? 0,
    skipped: p.skipped ?? 0,
    cancelled: p.cancelled ?? 0,
    todo: p.todo ?? 0,
  };
  return [
    "TAP version 13",
    "# Subtest: project suite fixture",
    "ok 1 - project suite fixture",
    "1..1",
    `# tests ${totals.tests}`,
    "# suites 1",
    `# pass ${totals.pass}`,
    `# fail ${totals.fail}`,
    `# cancelled ${totals.cancelled}`,
    `# skipped ${totals.skipped}`,
    `# todo ${totals.todo}`,
    "# duration_ms 1",
    "",
  ].join("\n");
}

function readTapTotals(tap: string): Partial<TapTotals> {
  const totals: Partial<TapTotals> = {};
  for (const line of String(tap || "").split(/\r?\n/)) {
    const total = TOTAL_LINE.exec(line);
    if (!total) continue;
    const key = total[1] === "skipped" ? "skipped" : total[1] as keyof TapTotals;
    (totals as Record<string, number>)[key] = Number(total[2]);
  }
  return totals;
}

export function parseTapSummary(tap: string): TapTotals {
  const totals = readTapTotals(tap);
  if (
    totals.tests == null
    || totals.pass == null
    || totals.fail == null
    || totals.skipped == null
    || totals.cancelled == null
    || totals.todo == null
  ) {
    throw new EvidenceError("TAP_SUMMARY_MISSING", "TAP summary counts are incomplete");
  }
  return {
    tests: totals.tests,
    pass: totals.pass,
    fail: totals.fail,
    skipped: totals.skipped,
    cancelled: totals.cancelled,
    todo: totals.todo,
  };
}

export function parseCheckpointFTap(tap: string): ParsedCheckpointFTap {
  const cases: ParsedFCase[] = [];
  const lines = String(tap || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = CASE_LINE.exec(lines[i] ?? "");
    if (!match) continue;
    const ok = match[2] === "ok";
    const caseId = match[3]!;
    const rest = match[4] ?? "";
    const title = `${caseId}${rest.split("#")[0] ?? ""}`.trim();
    let skip = /#\s*SKIP\b/i.test(rest);
    let todo = /#\s*TODO\b/i.test(rest);
    let cancelled = false;
    if ((lines[i + 1] ?? "").trim() === "---") {
      const yaml: string[] = [];
      for (let j = i + 2; j < lines.length && (lines[j] ?? "").trim() !== "..."; j++) {
        yaml.push(lines[j] ?? "");
      }
      const block = yaml.join("\n");
      if (/failureType:\s*'cancelledByParent'/.test(block) || /^\s*cancelled:\s*true/m.test(block)) {
        cancelled = true;
      }
      if (/^\s*skip:\s*true/m.test(block)) skip = true;
      if (/^\s*todo:\s*true/m.test(block)) todo = true;
    }
    cases.push({
      caseId,
      title,
      ok,
      skip,
      todo,
      cancelled,
      outcome: outcomeOf({ ok, skip, todo, cancelled }),
    });
  }
  return { cases, totals: parseTapSummary(tap) };
}

export function parseNpmTestScript(script: string): { preCheckCommand: string | null; tapFiles: string[] } {
  const parts = script.split("&&").map((part) => part.trim()).filter(Boolean);
  let preCheckCommand: string | null = null;
  let tapPart: string | null = null;
  for (const part of parts) {
    if (/(^|\s)--test(\s|$)/.test(part)) tapPart = part;
    else preCheckCommand = preCheckCommand ? `${preCheckCommand} && ${part}` : part;
  }
  if (!tapPart) throw new EvidenceError("SCHEMA_INVALID", "npm test script has no node:test invocation");
  const tokens = tapPart.split(/\s+/);
  const testIdx = tokens.indexOf("--test");
  if (testIdx < 0) throw new EvidenceError("SCHEMA_INVALID", "npm test --test flag missing");
  const tapFiles = tokens.slice(testIdx + 1).filter((token) => token.length > 0 && !token.startsWith("-"));
  if (tapFiles.length === 0) throw new EvidenceError("SCHEMA_INVALID", "npm test file list is empty");
  return { preCheckCommand, tapFiles };
}

export function readNpmTestPlan(root = REPO_ROOT): {
  npmTestScript: string;
  preCheckCommand: string;
  tapFiles: string[];
} {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    scripts?: { test?: string };
  };
  const npmTestScript = String(pkg.scripts?.test ?? "");
  const parsed = parseNpmTestScript(npmTestScript);
  return {
    npmTestScript,
    preCheckCommand: parsed.preCheckCommand ?? DEFAULT_PRECHECK_COMMAND,
    tapFiles: parsed.tapFiles,
  };
}

export function projectTapCommand(tapFiles: string[]): string {
  return `node --import tsx --test --test-reporter=tap ${tapFiles.join(" ")}`;
}

export function defaultProjectTapCommand(root = REPO_ROOT): string {
  return projectTapCommand(readNpmTestPlan(root).tapFiles);
}

export function assertCaseSet(cases: ParsedFCase[]): void {
  const seen = new Map<string, number>();
  for (const row of cases) {
    seen.set(row.caseId, (seen.get(row.caseId) ?? 0) + 1);
  }
  for (const [caseId, count] of seen) {
    if (!(CHECKPOINT_F_CASE_IDS as readonly string[]).includes(caseId)) {
      throw new EvidenceError("UNEXPECTED_CASE", `unexpected ${caseId}`);
    }
    if (count > 1) throw new EvidenceError("DUPLICATE_CASE", `duplicate ${caseId}`);
  }
  const missing = CHECKPOINT_F_CASE_IDS.filter((id) => !seen.has(id));
  if (missing.length > 0) throw new EvidenceError("MISSING_CASE", `missing ${missing.join(",")}`);
}

export function assertCaseOutcomes(cases: ParsedFCase[]): void {
  for (const row of cases) {
    if (row.skip) throw new EvidenceError("CASE_SKIPPED", row.caseId);
    if (row.todo) throw new EvidenceError("CASE_TODO", row.caseId);
    if (row.cancelled) throw new EvidenceError("CASE_CANCELLED", row.caseId);
    if (!row.ok || row.outcome !== "PASS") throw new EvidenceError("CASE_FAILED", row.caseId);
  }
}

export function countBlockFromOutcomes(outcomes: CaseOutcome[]): CountBlock {
  const block: CountBlock = { total: outcomes.length, pass: 0, fail: 0, skip: 0, cancelled: 0, todo: 0 };
  for (const outcome of outcomes) {
    if (outcome === "PASS") block.pass += 1;
    else if (outcome === "FAIL") block.fail += 1;
    else if (outcome === "SKIP") block.skip += 1;
    else if (outcome === "CANCELLED") block.cancelled += 1;
    else block.todo += 1;
  }
  if (block.pass + block.fail + block.skip + block.cancelled + block.todo !== block.total) {
    throw new EvidenceError("MALFORMED_TOTALS", "outcome counts do not sum to total");
  }
  return block;
}

export function countBlockFromTap(totals: TapTotals): CountBlock {
  const block: CountBlock = {
    total: totals.tests,
    pass: totals.pass,
    fail: totals.fail,
    skip: totals.skipped,
    cancelled: totals.cancelled,
    todo: totals.todo,
  };
  if (block.pass + block.fail + block.skip + block.cancelled + block.todo !== block.total) {
    throw new EvidenceError("MALFORMED_TOTALS", "TAP summary counts do not sum to tests");
  }
  return block;
}

export function assertTapTotals(parsed: ParsedCheckpointFTap): void {
  const fBlock = countBlockFromOutcomes(parsed.cases.map((row) => row.outcome));
  const tap = parsed.totals;
  if (tap.pass + tap.fail + tap.skipped + tap.cancelled + tap.todo !== tap.tests) {
    throw new EvidenceError("MALFORMED_TOTALS", "TAP summary counts do not sum to tests");
  }
  if (tap.tests !== parsed.cases.length) {
    throw new EvidenceError("TOTALS_MISMATCH", `TAP tests=${tap.tests} parsed=${parsed.cases.length}`);
  }
  if (
    tap.pass !== fBlock.pass
    || tap.fail !== fBlock.fail
    || tap.skipped !== fBlock.skip
    || tap.cancelled !== fBlock.cancelled
    || tap.todo !== fBlock.todo
  ) {
    throw new EvidenceError("TOTALS_MISMATCH", "TAP summary does not match parsed F-case outcomes");
  }
}

function projectTapLooksLikeCheckpoint(tap: string): boolean {
  try {
    const parsed = parseCheckpointFTap(tap);
    return parsed.totals.tests === CHECKPOINT_F_CASE_IDS.length
      && parsed.cases.length === CHECKPOINT_F_CASE_IDS.length;
  } catch {
    try {
      return parseTapSummary(tap).tests === CHECKPOINT_F_CASE_IDS.length;
    } catch {
      return false;
    }
  }
}

function assertProjectCommand(command: string, root = REPO_ROOT): void {
  if (command === DEFAULT_EVIDENCE_COMMAND) {
    throw new EvidenceError("PROJECT_SUITE_IS_CHECKPOINT", "projectSuite.command is the Checkpoint F command");
  }
  const { tapFiles } = readNpmTestPlan(root);
  const missing = tapFiles.filter((file) => !command.includes(file));
  if (missing.length > 0) {
    throw new EvidenceError("PROJECT_SUITE_IS_CHECKPOINT", `projectSuite.command missing ${missing.join(",")}`);
  }
  if (!command.includes("--test-reporter=tap")) {
    throw new EvidenceError("SCHEMA_INVALID", "projectSuite.command must use the TAP reporter");
  }
}

function assertPreCheckCommand(command: string, root = REPO_ROOT): void {
  const { preCheckCommand } = readNpmTestPlan(root);
  if (command !== preCheckCommand) {
    throw new EvidenceError("SCHEMA_INVALID", `preCheck.command ${command}`);
  }
}

function assertGreenCounts(block: CountBlock, processExitCode: number, label: string): void {
  if (processExitCode !== 0) {
    throw new EvidenceError("PROCESS_NONZERO_EXIT", `${label} exit ${processExitCode}`);
  }
  if (block.skip !== 0) throw new EvidenceError("SUITE_SKIPPED", `${label} skip=${block.skip}`);
  if (block.todo !== 0) throw new EvidenceError("SUITE_TODO", `${label} todo=${block.todo}`);
  if (block.cancelled !== 0) throw new EvidenceError("SUITE_CANCELLED", `${label} cancelled=${block.cancelled}`);
  if (block.fail !== 0) throw new EvidenceError("SUITE_FAILED", `${label} fail=${block.fail}`);
  if (block.pass !== block.total) {
    throw new EvidenceError("TOTALS_MISMATCH", `${label} pass ${block.pass} !== total ${block.total}`);
  }
}

export function sha40(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isGithubEventName(value: unknown): value is GithubEventName {
  return value === "local" || value === "push" || value === "pull_request";
}

export function assertIdentityShape(identity: EvidenceIdentity): void {
  if (!isGithubEventName(identity.githubEventName)) {
    throw new EvidenceError("SCHEMA_INVALID", `githubEventName ${String(identity.githubEventName)}`);
  }
  for (const [key, value] of Object.entries({
    sourceHeadSha: identity.sourceHeadSha,
    sourceHeadTreeSha: identity.sourceHeadTreeSha,
    testedCheckoutSha: identity.testedCheckoutSha,
    testedCheckoutTreeSha: identity.testedCheckoutTreeSha,
    baseSha: identity.baseSha,
  })) {
    if (!sha40(value)) throw new EvidenceError("SCHEMA_INVALID", key);
  }
  for (const [key, value] of Object.entries({
    githubRunId: identity.githubRunId,
    githubRunAttempt: identity.githubRunAttempt,
    githubJobId: identity.githubJobId,
  })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new EvidenceError("SCHEMA_INVALID", key);
    }
  }
  if (identity.githubEventName === "pull_request") {
    if (identity.sourceHeadSha === identity.testedCheckoutSha) {
      throw new EvidenceError(
        "IDENTITY_COLLISION",
        "pull_request sourceHeadSha must not equal testedCheckoutSha (PR head vs merge)",
      );
    }
  }
  if (identity.githubEventName === "push") {
    if (identity.sourceHeadSha !== identity.testedCheckoutSha) {
      throw new EvidenceError(
        "SOURCE_CHECKOUT_MISMATCH",
        "push sourceHeadSha must equal testedCheckoutSha",
      );
    }
  }
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function gitIdentity(root = REPO_ROOT): { commitSha: string; treeSha: string } {
  return {
    commitSha: git(root, ["rev-parse", "HEAD"]),
    treeSha: git(root, ["rev-parse", "HEAD^{tree}"]),
  };
}

function commitExists(root: string, sha: string): boolean {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, encoding: "utf8" });
  return result.status === 0;
}

export function ensureSourceCommit(root: string, sha: string): void {
  if (!sha40(sha)) throw new EvidenceError("INVALID_SOURCE_SHA", String(sha));
  if (commitExists(root, sha)) return;
  const fetch = spawnSync("git", ["fetch", "--no-tags", "origin", sha], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (fetch.status !== 0 || !commitExists(root, sha)) {
    throw new EvidenceError("SOURCE_COMMIT_UNAVAILABLE", sha);
  }
}

function treeOf(root: string, sha: string, code: EvidenceErrorCode): string {
  try {
    const tree = git(root, ["rev-parse", "--verify", `${sha}^{tree}`]);
    if (!sha40(tree)) throw new Error("tree");
    return tree;
  } catch {
    throw new EvidenceError(code, `cannot resolve ${sha}^{tree}`);
  }
}

export function assertSourceInCheckoutAncestry(root: string, sourceSha: string, testedSha: string): void {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", sourceSha, testedSha], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new EvidenceError("SOURCE_NOT_IN_CHECKOUT_ANCESTRY", `${sourceSha} is not an ancestor of ${testedSha}`);
  }
}

function readGithubEvent(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(eventPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function nestedSha(obj: unknown, keys: string[]): string | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function localBaseSha(root: string): string {
  try {
    const sha = git(root, ["merge-base", "HEAD", PR_BASE_REF]);
    return sha40(sha) ? sha : NULL_SHA;
  } catch {
    return NULL_SHA;
  }
}

function trustedSourceHead(env: NodeJS.ProcessEnv, event: Record<string, unknown> | null, eventName: GithubEventName): string {
  const fromEnv = String(env[SOURCE_HEAD_SHA_ENV] || "").trim();
  const fromPayload = eventName === "pull_request"
    ? String(nestedSha(event, ["pull_request", "head", "sha"]) || "").trim()
    : "";
  if (fromEnv && !sha40(fromEnv)) throw new EvidenceError("INVALID_SOURCE_SHA", fromEnv);
  if (fromPayload && !sha40(fromPayload)) throw new EvidenceError("INVALID_SOURCE_SHA", fromPayload);
  if (fromEnv && fromPayload && fromEnv !== fromPayload) {
    throw new EvidenceError("SOURCE_IDENTITY_CONFLICT", `${fromEnv} vs ${fromPayload}`);
  }
  if (eventName === "pull_request") {
    const source = fromEnv || fromPayload;
    if (!sha40(source)) {
      throw new EvidenceError("MISSING_SOURCE_IDENTITY", `${SOURCE_HEAD_SHA_ENV} or pull_request.head.sha required`);
    }
    return source;
  }
  if (eventName === "push") {
    const source = fromEnv || String(env.GITHUB_SHA || "").trim();
    if (!sha40(source)) {
      throw new EvidenceError("MISSING_SOURCE_IDENTITY", `${SOURCE_HEAD_SHA_ENV} or GITHUB_SHA required`);
    }
    return source;
  }
  return "";
}

export function resolveEvidenceIdentity(
  root = REPO_ROOT,
  env: NodeJS.ProcessEnv = process.env,
): EvidenceIdentity {
  const gitState = gitIdentity(root);
  const eventNameRaw = env.GITHUB_EVENT_NAME || "local";
  if (!isGithubEventName(eventNameRaw)) {
    throw new EvidenceError("SCHEMA_INVALID", `githubEventName ${eventNameRaw}`);
  }
  if (env.GITHUB_ACTIONS === "true" && eventNameRaw === "local") {
    throw new EvidenceError("SCHEMA_INVALID", "CI must set GITHUB_EVENT_NAME");
  }
  const eventName = eventNameRaw;
  const githubEvent = readGithubEvent(env);
  const testedCheckoutSha = gitState.commitSha;
  const testedCheckoutTreeSha = gitState.treeSha;
  if (!sha40(testedCheckoutSha) || !sha40(testedCheckoutTreeSha)) {
    throw new EvidenceError("SCHEMA_INVALID", "tested checkout identity");
  }
  if (env.GITHUB_SHA && env.GITHUB_SHA !== testedCheckoutSha) {
    throw new EvidenceError("STALE_TESTED_CHECKOUT_SHA", `HEAD ${testedCheckoutSha} GITHUB_SHA ${env.GITHUB_SHA}`);
  }
  const recomputedTestedTree = treeOf(root, testedCheckoutSha, "TESTED_TREE_MISMATCH");
  if (recomputedTestedTree !== testedCheckoutTreeSha) {
    throw new EvidenceError("TESTED_TREE_MISMATCH", `${testedCheckoutTreeSha} vs ${recomputedTestedTree}`);
  }

  let sourceHeadSha: string;
  let baseSha: string;
  if (eventName === "pull_request") {
    sourceHeadSha = trustedSourceHead(env, githubEvent, eventName);
    if (sourceHeadSha === testedCheckoutSha) {
      throw new EvidenceError(
        "IDENTITY_COLLISION",
        "pull_request source head is the merge/tested checkout SHA",
      );
    }
    if (env.GITHUB_SHA && sourceHeadSha === env.GITHUB_SHA) {
      throw new EvidenceError("IDENTITY_COLLISION", "source head equals GITHUB_SHA merge checkout");
    }
    const baseFromEnv = String(env[BASE_SHA_ENV] || "").trim();
    const baseFromPayload = String(nestedSha(githubEvent, ["pull_request", "base", "sha"]) || "").trim();
    baseSha = baseFromEnv || baseFromPayload;
    if (!sha40(baseSha)) throw new EvidenceError("SCHEMA_INVALID", "pull_request baseSha missing");
  } else if (eventName === "push") {
    sourceHeadSha = trustedSourceHead(env, githubEvent, eventName);
    if (sourceHeadSha !== testedCheckoutSha) {
      throw new EvidenceError("SOURCE_CHECKOUT_MISMATCH", `${sourceHeadSha} vs ${testedCheckoutSha}`);
    }
    const baseFromEnv = String(env[BASE_SHA_ENV] || "").trim();
    const before = typeof githubEvent?.before === "string" ? githubEvent.before : "";
    baseSha = sha40(baseFromEnv) ? baseFromEnv : sha40(before) ? before : NULL_SHA;
  } else {
    sourceHeadSha = testedCheckoutSha;
    baseSha = localBaseSha(root);
  }

  ensureSourceCommit(root, sourceHeadSha);
  const sourceHeadTreeSha = treeOf(root, sourceHeadSha, "SOURCE_TREE_MISMATCH");
  assertSourceInCheckoutAncestry(root, sourceHeadSha, testedCheckoutSha);

  const identity: EvidenceIdentity = {
    sourceHeadSha,
    sourceHeadTreeSha,
    testedCheckoutSha,
    testedCheckoutTreeSha,
    baseSha,
    githubEventName: eventName,
    githubRunId: env.GITHUB_RUN_ID || "local",
    githubRunAttempt: env.GITHUB_RUN_ATTEMPT || "0",
    githubJobId: env.GITHUB_JOB || "local",
  };
  assertIdentityShape(identity);
  return identity;
}

export function assertRecordedTreesMatchGit(root: string, identity: EvidenceIdentity): void {
  ensureSourceCommit(root, identity.sourceHeadSha);
  const sourceTree = treeOf(root, identity.sourceHeadSha, "SOURCE_TREE_MISMATCH");
  if (sourceTree !== identity.sourceHeadTreeSha) {
    throw new EvidenceError("SOURCE_TREE_MISMATCH", `${identity.sourceHeadTreeSha} vs ${sourceTree}`);
  }
  const testedTree = treeOf(root, identity.testedCheckoutSha, "TESTED_TREE_MISMATCH");
  if (testedTree !== identity.testedCheckoutTreeSha) {
    throw new EvidenceError("TESTED_TREE_MISMATCH", `${identity.testedCheckoutTreeSha} vs ${testedTree}`);
  }
}

function deriveCheckpointCases(parsed: ParsedCheckpointFTap): EvidenceCaseRow[] {
  return parsed.cases.map((row) => {
    const caseId = row.caseId as CheckpointFCaseId;
    return {
      caseId,
      category: categoryFor(caseId),
      result: row.outcome,
      title: row.title,
      liveExchangeWrite: false as const,
      productionCredentialUsed: false as const,
    };
  });
}

export function generateEvidenceFromRun(input: {
  checkpointTap: string;
  projectTap: string;
  meta: GenerateMeta;
}): CheckpointFEvidence {
  const { checkpointTap, projectTap, meta } = input;
  assertIdentityShape(meta.identity);
  if (checkpointTap === projectTap) {
    throw new EvidenceError("PROJECT_SUITE_IS_CHECKPOINT", "project TAP is a copy of checkpoint TAP");
  }
  const parsed = parseCheckpointFTap(checkpointTap);
  assertCaseSet(parsed.cases);
  assertCaseOutcomes(parsed.cases);
  assertTapTotals(parsed);
  if (meta.checkpoint.processExitCode !== 0) {
    throw new EvidenceError("PROCESS_NONZERO_EXIT", `checkpointSuite exit ${meta.checkpoint.processExitCode}`);
  }
  if (meta.checkpoint.command !== DEFAULT_EVIDENCE_COMMAND) {
    throw new EvidenceError("SCHEMA_INVALID", `checkpointSuite.command ${meta.checkpoint.command}`);
  }
  if (projectTapLooksLikeCheckpoint(projectTap)) {
    throw new EvidenceError("PROJECT_SUITE_IS_CHECKPOINT", "project TAP is the targeted Checkpoint F suite");
  }
  const projectTotals = parseTapSummary(projectTap);
  const projectCounts = countBlockFromTap(projectTotals);
  if (projectCounts.total < MIN_PROJECT_SUITE_TOTAL) {
    throw new EvidenceError("PROJECT_SUITE_TOO_SMALL", `projectSuite.total=${projectCounts.total}`);
  }
  if (meta.project.preCheck.processExitCode !== 0) {
    throw new EvidenceError("PRECHECK_NONZERO_EXIT", `exit ${meta.project.preCheck.processExitCode}`);
  }
  assertPreCheckCommand(meta.project.preCheck.command);
  assertProjectCommand(meta.project.command);
  assertGreenCounts(projectCounts, meta.project.processExitCode, "projectSuite");
  const testCases = deriveCheckpointCases(parsed);
  const checkpointCounts = countBlockFromOutcomes(testCases.map((row) => row.result));
  assertGreenCounts(checkpointCounts, meta.checkpoint.processExitCode, "checkpointSuite");
  if (meta.identity.githubEventName !== "local") {
    if (meta.toolchain.nodeVersion !== REQUIRED_CI_NODE || meta.toolchain.npmVersion !== REQUIRED_CI_NPM) {
      throw new EvidenceError(
        "SCHEMA_INVALID",
        `toolchain ${meta.toolchain.nodeVersion} / ${meta.toolchain.npmVersion}`,
      );
    }
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    repository: REPOSITORY,
    branch: meta.branch,
    checkpoint: "F",
    identity: meta.identity,
    toolchain: {
      nodeVersion: meta.toolchain.nodeVersion,
      npmVersion: meta.toolchain.npmVersion,
    },
    safety: {
      liveExchangeWrite: false,
      productionCredentialUsed: false,
      mergePerformed: false,
      deployPerformed: false,
    },
    checkpointSuite: {
      command: meta.checkpoint.command,
      processExitCode: meta.checkpoint.processExitCode,
      ...checkpointCounts,
      testCases,
    },
    projectSuite: {
      command: meta.project.command,
      processExitCode: meta.project.processExitCode,
      ...projectCounts,
      preCheck: {
        command: meta.project.preCheck.command,
        processExitCode: meta.project.preCheck.processExitCode,
      },
    },
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    fileHashes: meta.fileHashes,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new EvidenceError("SCHEMA_INVALID", "document is not an object");
  return value as Record<string, unknown>;
}

function readSuiteExecution(value: unknown, label: string): SuiteExecution {
  const row = asRecord(value);
  if (typeof row.command !== "string" || row.command.length === 0) {
    throw new EvidenceError("SCHEMA_INVALID", `${label}.command`);
  }
  if (typeof row.processExitCode !== "number" || !Number.isInteger(row.processExitCode)) {
    throw new EvidenceError("SCHEMA_INVALID", `${label}.processExitCode`);
  }
  return { command: row.command, processExitCode: row.processExitCode };
}

function readCountBlock(value: unknown, label: string): CountBlock {
  const row = asRecord(value);
  const keys: Array<keyof CountBlock> = ["total", "pass", "fail", "skip", "cancelled", "todo"];
  if (keys.some((key) => typeof row[key] !== "number" || !Number.isInteger(row[key]) || (row[key] as number) < 0)) {
    throw new EvidenceError("MALFORMED_TOTALS", `${label} counts are malformed`);
  }
  const block = row as unknown as CountBlock;
  if (block.pass + block.fail + block.skip + block.cancelled + block.todo !== block.total) {
    throw new EvidenceError("MALFORMED_TOTALS", `${label} counts are malformed`);
  }
  return block;
}

function verifyCheckpointSuite(suite: CheckpointSuiteBlock): void {
  if (suite.command !== DEFAULT_EVIDENCE_COMMAND) {
    throw new EvidenceError("SCHEMA_INVALID", `checkpointSuite.command ${suite.command}`);
  }
  assertGreenCounts(suite, suite.processExitCode, "checkpointSuite");
  if (suite.total !== CHECKPOINT_F_CASE_IDS.length || suite.pass !== CHECKPOINT_F_CASE_IDS.length) {
    throw new EvidenceError("TOTALS_MISMATCH", `checkpointSuite totals are not ${CHECKPOINT_F_CASE_IDS.length}/${CHECKPOINT_F_CASE_IDS.length}`);
  }
  if (!Array.isArray(suite.testCases) || suite.testCases.length !== CHECKPOINT_F_CASE_IDS.length) {
    throw new EvidenceError("SCHEMA_INVALID", "checkpointSuite.testCases length");
  }
  const fromRows = countBlockFromOutcomes(suite.testCases.map((row) => row.result));
  if (
    fromRows.total !== suite.total
    || fromRows.pass !== suite.pass
    || fromRows.fail !== suite.fail
    || fromRows.skip !== suite.skip
    || fromRows.cancelled !== suite.cancelled
    || fromRows.todo !== suite.todo
  ) {
    throw new EvidenceError("TOTALS_MISMATCH", "checkpointSuite totals do not equal testCase outcomes");
  }
  const seen = new Set<string>();
  for (let i = 0; i < CHECKPOINT_F_CASE_IDS.length; i++) {
    const row = suite.testCases[i]!;
    const expectedId = CHECKPOINT_F_CASE_IDS[i]!;
    if (row.caseId !== expectedId) throw new EvidenceError("SCHEMA_INVALID", `expected ${expectedId}`);
    if (seen.has(row.caseId)) throw new EvidenceError("DUPLICATE_CASE", row.caseId);
    seen.add(row.caseId);
    if (row.result === "SKIP") throw new EvidenceError("CASE_SKIPPED", row.caseId);
    if (row.result === "TODO") throw new EvidenceError("CASE_TODO", row.caseId);
    if (row.result === "CANCELLED") throw new EvidenceError("CASE_CANCELLED", row.caseId);
    if (row.result !== "PASS") throw new EvidenceError("CASE_FAILED", row.caseId);
    if (row.category !== categoryFor(row.caseId)) throw new EvidenceError("SCHEMA_INVALID", row.caseId);
    if (row.liveExchangeWrite !== false || row.productionCredentialUsed !== false) {
      throw new EvidenceError("LIVE_WRITE_CLAIM", row.caseId);
    }
    if (typeof row.title !== "string" || !row.title.startsWith(row.caseId)) {
      throw new EvidenceError("SCHEMA_INVALID", `title ${row.caseId}`);
    }
  }
}

function verifyProjectSuite(suite: ProjectSuiteBlock, checkpointCommand: string, root = REPO_ROOT): void {
  if (suite.command === checkpointCommand || suite.command === DEFAULT_EVIDENCE_COMMAND) {
    throw new EvidenceError("PROJECT_SUITE_IS_CHECKPOINT", "projectSuite.command copies checkpointSuite.command");
  }
  assertProjectCommand(suite.command, root);
  assertPreCheckCommand(suite.preCheck.command, root);
  if (suite.preCheck.processExitCode !== 0) {
    throw new EvidenceError("PRECHECK_NONZERO_EXIT", `exit ${suite.preCheck.processExitCode}`);
  }
  if (suite.total === CHECKPOINT_F_CASE_IDS.length) {
    throw new EvidenceError("PROJECT_SUITE_IS_CHECKPOINT", "projectSuite.total is the targeted Checkpoint F suite");
  }
  if (suite.total < MIN_PROJECT_SUITE_TOTAL) {
    throw new EvidenceError("PROJECT_SUITE_TOO_SMALL", `projectSuite.total=${suite.total}`);
  }
  assertGreenCounts(suite, suite.processExitCode, "projectSuite");
}

export function verifyEvidence(
  doc: unknown,
  expected: {
    identity: EvidenceIdentity;
    fileHashes: Record<string, string>;
    branch?: string;
    root?: string;
  },
): CheckpointFEvidence {
  const raw = asRecord(doc);
  for (const key of LEGACY_SCHEMA_KEYS) {
    if (key in raw) throw new EvidenceError("SCHEMA_INVALID", `legacy field ${key}`);
  }
  if (raw.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new EvidenceError("SCHEMA_INVALID", `schemaVersion ${String(raw.schemaVersion)}`);
  }
  if (raw.repository !== REPOSITORY) throw new EvidenceError("SCHEMA_INVALID", "repository");
  if (raw.checkpoint !== "F") throw new EvidenceError("SCHEMA_INVALID", "checkpoint");
  if (typeof raw.branch !== "string" || raw.branch.length === 0) {
    throw new EvidenceError("SCHEMA_INVALID", "branch");
  }
  if (expected.branch && raw.branch !== expected.branch) {
    throw new EvidenceError("SCHEMA_INVALID", `branch ${raw.branch}`);
  }
  const identity = raw.identity as EvidenceIdentity;
  if (!identity || typeof identity !== "object") throw new EvidenceError("SCHEMA_INVALID", "identity");
  assertIdentityShape(identity);
  if (expected.root) assertRecordedTreesMatchGit(expected.root, identity);
  if (identity.sourceHeadSha !== expected.identity.sourceHeadSha) {
    throw new EvidenceError("STALE_SOURCE_HEAD_SHA", identity.sourceHeadSha);
  }
  if (identity.sourceHeadTreeSha !== expected.identity.sourceHeadTreeSha) {
    throw new EvidenceError("STALE_SOURCE_HEAD_TREE", identity.sourceHeadTreeSha);
  }
  if (identity.testedCheckoutSha !== expected.identity.testedCheckoutSha) {
    throw new EvidenceError("STALE_TESTED_CHECKOUT_SHA", identity.testedCheckoutSha);
  }
  if (identity.testedCheckoutTreeSha !== expected.identity.testedCheckoutTreeSha) {
    throw new EvidenceError("STALE_TESTED_CHECKOUT_TREE", identity.testedCheckoutTreeSha);
  }
  if (identity.githubEventName !== expected.identity.githubEventName) {
    throw new EvidenceError("SCHEMA_INVALID", `githubEventName ${identity.githubEventName}`);
  }
  const toolchain = asRecord(raw.toolchain);
  if (typeof toolchain.nodeVersion !== "string" || !toolchain.nodeVersion.startsWith("v")) {
    throw new EvidenceError("SCHEMA_INVALID", "nodeVersion");
  }
  if (typeof toolchain.npmVersion !== "string" || toolchain.npmVersion.length === 0) {
    throw new EvidenceError("SCHEMA_INVALID", "npmVersion");
  }
  if (identity.githubEventName !== "local") {
    if (toolchain.nodeVersion !== REQUIRED_CI_NODE || toolchain.npmVersion !== REQUIRED_CI_NPM) {
      throw new EvidenceError("SCHEMA_INVALID", `toolchain ${toolchain.nodeVersion} / ${toolchain.npmVersion}`);
    }
  }
  const safety = asRecord(raw.safety);
  if (
    safety.liveExchangeWrite !== false
    || safety.productionCredentialUsed !== false
    || safety.mergePerformed !== false
    || safety.deployPerformed !== false
  ) {
    throw new EvidenceError("LIVE_WRITE_CLAIM", "live write, credential, merge, or deploy flag is not false");
  }
  const checkpointRaw = asRecord(raw.checkpointSuite);
  const projectRaw = asRecord(raw.projectSuite);
  const checkpointExec = readSuiteExecution(checkpointRaw, "checkpointSuite");
  const projectExec = readSuiteExecution(projectRaw, "projectSuite");
  const checkpointCounts = readCountBlock(checkpointRaw, "checkpointSuite");
  const projectCounts = readCountBlock(projectRaw, "projectSuite");
  if (!Array.isArray(checkpointRaw.testCases)) {
    throw new EvidenceError("SCHEMA_INVALID", "checkpointSuite.testCases");
  }
  const checkpointSuite: CheckpointSuiteBlock = {
    ...checkpointExec,
    ...checkpointCounts,
    testCases: checkpointRaw.testCases as EvidenceCaseRow[],
  };
  const projectSuite: ProjectSuiteBlock = {
    ...projectExec,
    ...projectCounts,
    preCheck: readSuiteExecution(asRecord(projectRaw.preCheck), "projectSuite.preCheck"),
  };
  verifyCheckpointSuite(checkpointSuite);
  verifyProjectSuite(projectSuite, checkpointSuite.command, expected.root);
  if (!raw.fileHashes || typeof raw.fileHashes !== "object") {
    throw new EvidenceError("SCHEMA_INVALID", "fileHashes");
  }
  const fileHashes = raw.fileHashes as Record<string, string>;
  for (const rel of REQUIRED_HASH_PATHS) {
    if (fileHashes[rel] !== expected.fileHashes[rel]) {
      throw new EvidenceError("FILE_HASH_MISMATCH", rel);
    }
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    repository: REPOSITORY,
    branch: raw.branch,
    checkpoint: "F",
    identity,
    toolchain: {
      nodeVersion: toolchain.nodeVersion,
      npmVersion: toolchain.npmVersion,
    },
    safety: {
      liveExchangeWrite: false,
      productionCredentialUsed: false,
      mergePerformed: false,
      deployPerformed: false,
    },
    checkpointSuite,
    projectSuite,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
    fileHashes,
  };
}

export function npmVersion(): string {
  return execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
}

function spawnNodeCommand(command: string, root: string) {
  const tokens = command.split(/\s+/);
  const argv0 = tokens[0] === "node" ? process.execPath : tokens[0]!;
  return spawnSync(argv0, tokens.slice(1), { cwd: root, ...SPAWN_OPTS });
}

export function runCheckpointFSuite(root = REPO_ROOT): { tap: string; exitCode: number; command: string } {
  const command = DEFAULT_EVIDENCE_COMMAND;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", CHECKPOINT_F_TEST_FILE],
    { cwd: root, ...SPAWN_OPTS },
  );
  return {
    tap: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    exitCode: result.status ?? 1,
    command,
  };
}

export function runProjectSuite(root = REPO_ROOT): {
  tap: string;
  exitCode: number;
  command: string;
  preCheck: SuiteExecution;
} {
  const plan = readNpmTestPlan(root);
  const preCheckRun = spawnNodeCommand(plan.preCheckCommand, root);
  const tapRun = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", ...plan.tapFiles],
    { cwd: root, ...SPAWN_OPTS },
  );
  return {
    tap: `${tapRun.stdout ?? ""}${tapRun.stderr ?? ""}`,
    exitCode: tapRun.status ?? 1,
    command: projectTapCommand(plan.tapFiles),
    preCheck: {
      command: plan.preCheckCommand,
      processExitCode: preCheckRun.status ?? 1,
    },
  };
}

function assertCiToolchain(env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_ACTIONS !== "true") return;
  if (process.version !== REQUIRED_CI_NODE) {
    throw new EvidenceError("SCHEMA_INVALID", `CI node ${process.version}`);
  }
  const npm = npmVersion();
  if (npm !== REQUIRED_CI_NPM) {
    throw new EvidenceError("SCHEMA_INVALID", `CI npm ${npm}`);
  }
}

export function writeGeneratedEvidence(outputPath: string, root = REPO_ROOT): CheckpointFEvidence {
  assertCiToolchain();
  const identity = resolveEvidenceIdentity(root);
  assertRecordedTreesMatchGit(root, identity);
  const checkpoint = runCheckpointFSuite(root);
  const project = runProjectSuite(root);
  const evidence = generateEvidenceFromRun({
    checkpointTap: checkpoint.tap,
    projectTap: project.tap,
    meta: {
      branch: BRANCH,
      identity,
      toolchain: {
        nodeVersion: process.version,
        npmVersion: npmVersion(),
      },
      checkpoint: {
        command: checkpoint.command,
        processExitCode: checkpoint.exitCode,
      },
      project: {
        command: project.command,
        processExitCode: project.exitCode,
        preCheck: project.preCheck,
      },
      fileHashes: collectFileHashes(root),
    },
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export function verifyEvidenceFile(inputPath: string, root = REPO_ROOT): CheckpointFEvidence {
  const identity = resolveEvidenceIdentity(root);
  const doc = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  return verifyEvidence(doc, {
    identity,
    fileHashes: collectFileHashes(root),
    branch: BRANCH,
    root,
  });
}

function isMain(): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

function summarize(evidence: CheckpointFEvidence, pathTarget: string) {
  return {
    ok: true,
    path: pathTarget,
    schemaVersion: evidence.schemaVersion,
    identity: evidence.identity,
    checkpointSuite: {
      command: evidence.checkpointSuite.command,
      processExitCode: evidence.checkpointSuite.processExitCode,
      total: evidence.checkpointSuite.total,
      pass: evidence.checkpointSuite.pass,
      fail: evidence.checkpointSuite.fail,
      skip: evidence.checkpointSuite.skip,
      cancelled: evidence.checkpointSuite.cancelled,
      todo: evidence.checkpointSuite.todo,
    },
    projectSuite: {
      command: evidence.projectSuite.command,
      processExitCode: evidence.projectSuite.processExitCode,
      total: evidence.projectSuite.total,
      pass: evidence.projectSuite.pass,
      fail: evidence.projectSuite.fail,
      skip: evidence.projectSuite.skip,
      cancelled: evidence.projectSuite.cancelled,
      todo: evidence.projectSuite.todo,
      preCheck: evidence.projectSuite.preCheck,
    },
  };
}

function cli(argv = process.argv.slice(2)): void {
  const command = argv[0];
  const target = path.resolve(REPO_ROOT, argv[1] || DEFAULT_EVIDENCE_PATH);
  try {
    if (command === "generate") {
      const evidence = writeGeneratedEvidence(target);
      const digest = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
      process.stdout.write(`${JSON.stringify({ ...summarize(evidence, target), sha256: digest }, null, 2)}\n`);
      return;
    }
    if (command === "verify") {
      const evidence = verifyEvidenceFile(target);
      const digest = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
      process.stdout.write(`${JSON.stringify({ ...summarize(evidence, target), sha256: digest }, null, 2)}\n`);
      return;
    }
    process.stderr.write("usage: checkpoint-f-evidence.ts generate|verify [path]\n");
    process.exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (isMain()) cli();
