import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EVIDENCE_SCHEMA_VERSION = "classic-v0.2-checkpoint-e/2";
export const REPOSITORY = "danny0971haha/classic-grid";
export const BRANCH = "experiment/classic-v0.2-100u-safety";
export const CHECKPOINT_E_TEST_FILE = "test/experiment-v02-checkpoint-e.test.ts";
export const DEFAULT_EVIDENCE_COMMAND =
  `node --import tsx --test --test-reporter=tap ${CHECKPOINT_E_TEST_FILE}`;
export const DEFAULT_EVIDENCE_PATH = "artifacts/classic-v0.2-checkpoint-e-results.json";

export const CHECKPOINT_E_CASE_IDS = [
  "E-01", "E-02", "E-03", "E-04", "E-05", "E-06", "E-07", "E-08", "E-09", "E-10",
  "E-11", "E-12", "E-13", "E-14", "E-15", "E-16", "E-17", "E-18", "E-19", "E-20",
  "E-21", "E-22", "E-23", "E-24", "E-25", "E-26", "E-27", "E-28", "E-29", "E-30",
] as const;

export type CheckpointECaseId = typeof CHECKPOINT_E_CASE_IDS[number];

export const REQUIRED_HASH_PATHS = [
  CHECKPOINT_E_TEST_FILE,
  "test/fixtures/checkpoint-e-worker.ts",
  "tools/checkpoint-e-evidence.ts",
  "docs/classic-v0.2-checkpoint-e.md",
  "docs/classic-v0.2-implementation-contract.md",
  "docs/experiment-spec-v0.2-100u-safety.md",
] as const;

export const OPTIONAL_HASH_PATHS = [
  "docs/classic-v0.2-checkpoint-e-corrective-1.md",
] as const;

export type CaseOutcome = "PASS" | "FAIL" | "SKIP" | "CANCELLED" | "TODO";

export type EvidenceErrorCode =
  | "PROCESS_NONZERO_EXIT"
  | "MISSING_CASE"
  | "DUPLICATE_CASE"
  | "UNEXPECTED_CASE"
  | "CASE_FAILED"
  | "CASE_SKIPPED"
  | "CASE_CANCELLED"
  | "CASE_TODO"
  | "TOTALS_MISMATCH"
  | "TAP_SUMMARY_MISSING"
  | "STALE_TESTED_SHA"
  | "STALE_TESTED_TREE"
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

export type ParsedECase = {
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

export type ParsedCheckpointETap = {
  cases: ParsedECase[];
  totals: TapTotals;
};

export type EvidenceCaseRow = {
  caseId: CheckpointECaseId;
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

export type CheckpointEEvidence = {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  repository: typeof REPOSITORY;
  branch: string;
  testedCommitSha: string;
  testedTreeSha: string;
  nodeVersion: string;
  npmVersion: string;
  command: string;
  processExitCode: number;
  eCases: CountBlock;
  fullSuite: CountBlock;
  testCases: EvidenceCaseRow[];
  liveExchangeWrite: false;
  productionCredentialUsed: false;
  generatedAt: string;
  fileHashes: Record<string, string>;
};

export type GenerateMeta = {
  repository?: string;
  branch: string;
  testedCommitSha: string;
  testedTreeSha: string;
  nodeVersion: string;
  npmVersion: string;
  command: string;
  processExitCode: number;
  generatedAt?: string;
  fileHashes: Record<string, string>;
};

const CASE_LINE = /^(\s*)(ok|not ok)\s+\d+\s+-\s+(E-\d{2})\b(.*)$/;
const TOTAL_LINE = /^#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/;
const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(HERE), "..");

export function categoryFor(caseId: string): string {
  if (["E-01", "E-02", "E-29", "E-30"].includes(caseId)) return "configuration";
  if (["E-03", "E-04", "E-05"].includes(caseId)) return "planner";
  if (["E-06", "E-07", "E-08", "E-09"].includes(caseId)) return "execution-journal";
  if (["E-10", "E-11", "E-12", "E-13", "E-14", "E-15", "E-16", "E-17", "E-18"].includes(caseId)) return "risk";
  if (["E-19", "E-20", "E-21"].includes(caseId)) return "restart";
  if (["E-22", "E-23", "E-27"].includes(caseId)) return "telemetry";
  if (["E-24", "E-25"].includes(caseId)) return "fatal-runtime";
  return "evidence";
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function collectFileHashes(root = REPO_ROOT): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const rel of REQUIRED_HASH_PATHS) {
    hashes[rel] = sha256File(path.join(root, rel));
  }
  for (const rel of OPTIONAL_HASH_PATHS) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) hashes[rel] = sha256File(abs);
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

export function renderCheckpointETap(p: {
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
  const lines = ["TAP version 13", "# Subtest: Checkpoint E integrated dry-run and fault campaign"];
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
  lines.push("ok 1 - Checkpoint E integrated dry-run and fault campaign");
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
  lines.push(`# suites 1`);
  lines.push(`# pass ${totals.pass}`);
  lines.push(`# fail ${totals.fail}`);
  lines.push(`# cancelled ${totals.cancelled}`);
  lines.push(`# skipped ${totals.skipped}`);
  lines.push(`# todo ${totals.todo}`);
  lines.push("# duration_ms 1");
  return `${lines.join("\n")}\n`;
}

export function parseCheckpointETap(tap: string): ParsedCheckpointETap {
  const cases: ParsedECase[] = [];
  const lines = String(tap || "").split(/\r?\n/);
  const totals: Partial<TapTotals> = {};
  for (let i = 0; i < lines.length; i++) {
    const total = TOTAL_LINE.exec(lines[i] ?? "");
    if (total) {
      const key = total[1] === "skipped" ? "skipped" : total[1] as keyof TapTotals;
      (totals as Record<string, number>)[key] = Number(total[2]);
      continue;
    }
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
    cases,
    totals: {
      tests: totals.tests,
      pass: totals.pass,
      fail: totals.fail,
      skipped: totals.skipped,
      cancelled: totals.cancelled,
      todo: totals.todo,
    },
  };
}

export function assertCaseSet(cases: ParsedECase[]): void {
  const seen = new Map<string, number>();
  for (const row of cases) {
    seen.set(row.caseId, (seen.get(row.caseId) ?? 0) + 1);
  }
  for (const [caseId, count] of seen) {
    if (!(CHECKPOINT_E_CASE_IDS as readonly string[]).includes(caseId)) {
      throw new EvidenceError("UNEXPECTED_CASE", `unexpected ${caseId}`);
    }
    if (count > 1) throw new EvidenceError("DUPLICATE_CASE", `duplicate ${caseId}`);
  }
  const missing = CHECKPOINT_E_CASE_IDS.filter((id) => !seen.has(id));
  if (missing.length > 0) throw new EvidenceError("MISSING_CASE", `missing ${missing.join(",")}`);
}

export function assertCaseOutcomes(cases: ParsedECase[]): void {
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

export function assertTapTotals(parsed: ParsedCheckpointETap): void {
  const eBlock = countBlockFromOutcomes(parsed.cases.map((row) => row.outcome));
  if (eBlock.total !== parsed.cases.length) {
    throw new EvidenceError("TOTALS_MISMATCH", "E-case total does not equal parsed case set");
  }
  const tap = parsed.totals;
  if (tap.pass + tap.fail + tap.skipped + tap.cancelled + tap.todo !== tap.tests) {
    throw new EvidenceError("MALFORMED_TOTALS", "TAP summary counts do not sum to tests");
  }
  if (tap.tests !== parsed.cases.length) {
    throw new EvidenceError("TOTALS_MISMATCH", `TAP tests=${tap.tests} parsed=${parsed.cases.length}`);
  }
  if (
    tap.pass !== eBlock.pass
    || tap.fail !== eBlock.fail
    || tap.skipped !== eBlock.skip
    || tap.cancelled !== eBlock.cancelled
    || tap.todo !== eBlock.todo
  ) {
    throw new EvidenceError("TOTALS_MISMATCH", "TAP summary does not match parsed E-case outcomes");
  }
}

export function generateEvidenceFromRun(tap: string, meta: GenerateMeta): CheckpointEEvidence {
  const parsed = parseCheckpointETap(tap);
  assertCaseSet(parsed.cases);
  assertCaseOutcomes(parsed.cases);
  assertTapTotals(parsed);
  if (meta.processExitCode !== 0) {
    throw new EvidenceError("PROCESS_NONZERO_EXIT", `exit ${meta.processExitCode}`);
  }
  const testCases: EvidenceCaseRow[] = parsed.cases.map((row) => {
    const caseId = row.caseId as CheckpointECaseId;
    return {
      caseId,
      category: categoryFor(caseId),
      result: row.outcome,
      title: row.title,
      liveExchangeWrite: false,
      productionCredentialUsed: false,
    };
  });
  const eCases = countBlockFromOutcomes(testCases.map((row) => row.result));
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    repository: REPOSITORY,
    branch: meta.branch,
    testedCommitSha: meta.testedCommitSha,
    testedTreeSha: meta.testedTreeSha,
    nodeVersion: meta.nodeVersion,
    npmVersion: meta.npmVersion,
    command: meta.command,
    processExitCode: meta.processExitCode,
    eCases,
    fullSuite: {
      total: parsed.totals.tests,
      pass: parsed.totals.pass,
      fail: parsed.totals.fail,
      skip: parsed.totals.skipped,
      cancelled: parsed.totals.cancelled,
      todo: parsed.totals.todo,
    },
    testCases,
    liveExchangeWrite: false,
    productionCredentialUsed: false,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    fileHashes: meta.fileHashes,
  };
}

function sha40(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function countBlockValid(value: unknown): value is CountBlock {
  if (!value || typeof value !== "object") return false;
  const row = value as CountBlock;
  const keys: Array<keyof CountBlock> = ["total", "pass", "fail", "skip", "cancelled", "todo"];
  if (keys.some((key) => typeof row[key] !== "number" || !Number.isInteger(row[key]) || row[key] < 0)) {
    return false;
  }
  return row.pass + row.fail + row.skip + row.cancelled + row.todo === row.total;
}

export function verifyEvidence(
  doc: unknown,
  expected: {
    testedCommitSha: string;
    testedTreeSha: string;
    fileHashes: Record<string, string>;
    branch?: string;
  },
): CheckpointEEvidence {
  if (!doc || typeof doc !== "object") throw new EvidenceError("SCHEMA_INVALID", "document is not an object");
  const evidence = doc as CheckpointEEvidence;
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new EvidenceError("SCHEMA_INVALID", `schemaVersion ${String(evidence.schemaVersion)}`);
  }
  if (evidence.repository !== REPOSITORY) throw new EvidenceError("SCHEMA_INVALID", "repository");
  if (typeof evidence.branch !== "string" || evidence.branch.length === 0) {
    throw new EvidenceError("SCHEMA_INVALID", "branch");
  }
  if (expected.branch && evidence.branch !== expected.branch) {
    throw new EvidenceError("SCHEMA_INVALID", `branch ${evidence.branch}`);
  }
  if (!sha40(evidence.testedCommitSha)) throw new EvidenceError("SCHEMA_INVALID", "testedCommitSha");
  if (!sha40(evidence.testedTreeSha)) throw new EvidenceError("SCHEMA_INVALID", "testedTreeSha");
  if (evidence.testedCommitSha !== expected.testedCommitSha) {
    throw new EvidenceError("STALE_TESTED_SHA", evidence.testedCommitSha);
  }
  if (evidence.testedTreeSha !== expected.testedTreeSha) {
    throw new EvidenceError("STALE_TESTED_TREE", evidence.testedTreeSha);
  }
  if (typeof evidence.nodeVersion !== "string" || !evidence.nodeVersion.startsWith("v")) {
    throw new EvidenceError("SCHEMA_INVALID", "nodeVersion");
  }
  if (typeof evidence.npmVersion !== "string" || evidence.npmVersion.length === 0) {
    throw new EvidenceError("SCHEMA_INVALID", "npmVersion");
  }
  if (evidence.command !== DEFAULT_EVIDENCE_COMMAND) {
    throw new EvidenceError("SCHEMA_INVALID", `command ${String(evidence.command)}`);
  }
  if (evidence.processExitCode !== 0) {
    throw new EvidenceError("PROCESS_NONZERO_EXIT", String(evidence.processExitCode));
  }
  if (evidence.liveExchangeWrite !== false || evidence.productionCredentialUsed !== false) {
    throw new EvidenceError("LIVE_WRITE_CLAIM", "live write or credential flag is not false");
  }
  if (!Array.isArray(evidence.testCases) || evidence.testCases.length !== CHECKPOINT_E_CASE_IDS.length) {
    throw new EvidenceError("SCHEMA_INVALID", "testCases length");
  }
  if (!countBlockValid(evidence.eCases) || !countBlockValid(evidence.fullSuite)) {
    throw new EvidenceError("MALFORMED_TOTALS", "eCases or fullSuite counts are malformed");
  }
  if (evidence.eCases.total !== CHECKPOINT_E_CASE_IDS.length || evidence.eCases.pass !== CHECKPOINT_E_CASE_IDS.length) {
    throw new EvidenceError("TOTALS_MISMATCH", "E-case totals are not 30/30");
  }
  if (evidence.fullSuite.total !== evidence.testCases.length || evidence.fullSuite.pass !== evidence.testCases.length) {
    throw new EvidenceError("TOTALS_MISMATCH", "full-suite totals do not equal the parsed case set");
  }
  if (
    evidence.eCases.fail !== 0
    || evidence.eCases.skip !== 0
    || evidence.eCases.cancelled !== 0
    || evidence.eCases.todo !== 0
    || evidence.fullSuite.fail !== 0
    || evidence.fullSuite.skip !== 0
    || evidence.fullSuite.cancelled !== 0
    || evidence.fullSuite.todo !== 0
  ) {
    throw new EvidenceError("TOTALS_MISMATCH", "fail/skip/cancelled/todo must be 0");
  }
  const seen = new Set<string>();
  for (let i = 0; i < CHECKPOINT_E_CASE_IDS.length; i++) {
    const row = evidence.testCases[i]!;
    const expectedId = CHECKPOINT_E_CASE_IDS[i]!;
    if (row.caseId !== expectedId) throw new EvidenceError("SCHEMA_INVALID", `expected ${expectedId}`);
    if (seen.has(row.caseId)) throw new EvidenceError("DUPLICATE_CASE", row.caseId);
    seen.add(row.caseId);
    if (row.result !== "PASS") throw new EvidenceError("CASE_FAILED", row.caseId);
    if (row.category !== categoryFor(row.caseId)) throw new EvidenceError("SCHEMA_INVALID", row.caseId);
    if (row.liveExchangeWrite !== false || row.productionCredentialUsed !== false) {
      throw new EvidenceError("LIVE_WRITE_CLAIM", row.caseId);
    }
    if (typeof row.title !== "string" || !row.title.startsWith(row.caseId)) {
      throw new EvidenceError("SCHEMA_INVALID", `title ${row.caseId}`);
    }
  }
  if (!evidence.fileHashes || typeof evidence.fileHashes !== "object") {
    throw new EvidenceError("SCHEMA_INVALID", "fileHashes");
  }
  for (const rel of REQUIRED_HASH_PATHS) {
    if (evidence.fileHashes[rel] !== expected.fileHashes[rel]) {
      throw new EvidenceError("FILE_HASH_MISMATCH", rel);
    }
  }
  return evidence;
}

export function gitIdentity(root = REPO_ROOT): { commitSha: string; treeSha: string; branch: string } {
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { commitSha, treeSha, branch };
}

export function npmVersion(): string {
  return execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
}

export function runCheckpointESuite(root = REPO_ROOT): { tap: string; exitCode: number; command: string } {
  const command = DEFAULT_EVIDENCE_COMMAND;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", CHECKPOINT_E_TEST_FILE],
    { cwd: root, encoding: "utf8" },
  );
  return {
    tap: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    exitCode: result.status ?? 1,
    command,
  };
}

export function writeGeneratedEvidence(outputPath: string, root = REPO_ROOT): CheckpointEEvidence {
  const identity = gitIdentity(root);
  const run = runCheckpointESuite(root);
  const evidence = generateEvidenceFromRun(run.tap, {
    branch: BRANCH,
    testedCommitSha: identity.commitSha,
    testedTreeSha: identity.treeSha,
    nodeVersion: process.version,
    npmVersion: npmVersion(),
    command: run.command,
    processExitCode: run.exitCode,
    fileHashes: collectFileHashes(root),
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export function verifyEvidenceFile(inputPath: string, root = REPO_ROOT): CheckpointEEvidence {
  const identity = gitIdentity(root);
  const doc = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  return verifyEvidence(doc, {
    testedCommitSha: identity.commitSha,
    testedTreeSha: identity.treeSha,
    fileHashes: collectFileHashes(root),
    branch: BRANCH,
  });
}

function isMain(): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

function cli(argv = process.argv.slice(2)): void {
  const command = argv[0];
  const target = path.resolve(REPO_ROOT, argv[1] || DEFAULT_EVIDENCE_PATH);
  if (command === "generate") {
    const evidence = writeGeneratedEvidence(target);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      path: target,
      testedCommitSha: evidence.testedCommitSha,
      testedTreeSha: evidence.testedTreeSha,
      eCases: evidence.eCases,
      fullSuite: evidence.fullSuite,
      processExitCode: evidence.processExitCode,
    }, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const evidence = verifyEvidenceFile(target);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      path: target,
      testedCommitSha: evidence.testedCommitSha,
      testedTreeSha: evidence.testedTreeSha,
      eCases: evidence.eCases,
    }, null, 2)}\n`);
    return;
  }
  process.stderr.write("usage: checkpoint-e-evidence.ts generate|verify [path]\n");
  process.exitCode = 2;
}

if (isMain()) cli();
