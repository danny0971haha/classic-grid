import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BASELINE_RELATIVE_PATH,
  LOCKFILE_RELATIVE_PATH,
  actionInventoryDocument,
  evaluateAuditPolicy,
  failedPolicy,
  inventoryGitRepository,
  parseAuditReport,
  readAuditFile,
  repoPath,
  sanitizeForArtifact,
  sha256File,
  verificationDocument,
  type AuditBaseline,
  type PolicyResult,
} from "./audit-policy.js";

export const SECURITY_ARTIFACT_DIR = "artifacts/security";

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function writeRelative(root: string, relative: string, contents: string): void {
  const full = repoPath(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, sanitizeForArtifact(contents, root));
}

export function runNpmAudit(root: string): { ok: true; raw: string } | { ok: false; code: "AUDIT_COMMAND_FAILED"; stderr: string } {
  const spawned = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  if (spawned.error || spawned.status === null) {
    return { ok: false, code: "AUDIT_COMMAND_FAILED", stderr: spawned.stderr || String(spawned.error || "spawn failed") };
  }
  if (spawned.status !== 0 && spawned.status !== 1) {
    return { ok: false, code: "AUDIT_COMMAND_FAILED", stderr: spawned.stderr || `exit ${spawned.status}` };
  }
  if (typeof spawned.stdout !== "string" || spawned.stdout.trim().length === 0) {
    return { ok: false, code: "AUDIT_COMMAND_FAILED", stderr: spawned.stderr || "empty stdout" };
  }
  return { ok: true, raw: spawned.stdout };
}

function commandFailedResult(baseline: AuditBaseline, lockfileSha256: string, code: "AUDIT_FILE_MISSING" | "AUDIT_COMMAND_FAILED"): PolicyResult {
  return failedPolicy(code, lockfileSha256, baseline.lockfile.sha256);
}

function writeActionInventory(root: string, outDir: string): ReturnType<typeof inventoryGitRepository> {
  const actionInventory = inventoryGitRepository(root, { requireProductionPins: true });
  writeRelative(
    root,
    path.join(outDir, "action-pin-inventory.json"),
    `${JSON.stringify(actionInventoryDocument(actionInventory), null, 2)}\n`,
  );
  return actionInventory;
}

export function runAuditBaseline(root = repoRootFromHere(), options: {
  auditJsonPath?: string;
  outDir?: string;
} = {}): PolicyResult {
  const outDir = options.outDir ?? SECURITY_ARTIFACT_DIR;
  const baseline = JSON.parse(fs.readFileSync(repoPath(root, BASELINE_RELATIVE_PATH), "utf8")) as AuditBaseline;
  const lockfileSha256 = sha256File(repoPath(root, LOCKFILE_RELATIVE_PATH));

  let auditRaw: string;
  if (options.auditJsonPath) {
    const loaded = readAuditFile(options.auditJsonPath);
    if (!loaded.ok) {
      const result = commandFailedResult(baseline, lockfileSha256, "AUDIT_FILE_MISSING");
      writeRelative(root, path.join(outDir, "audit-baseline-verification.json"), `${JSON.stringify(verificationDocument(result), null, 2)}\n`);
      writeActionInventory(root, outDir);
      return result;
    }
    auditRaw = loaded.raw;
  } else {
    const audited = runNpmAudit(root);
    if (!audited.ok) {
      const result = commandFailedResult(baseline, lockfileSha256, "AUDIT_COMMAND_FAILED");
      writeRelative(root, path.join(outDir, "audit-baseline-verification.json"), `${JSON.stringify(verificationDocument(result), null, 2)}\n`);
      writeActionInventory(root, outDir);
      return result;
    }
    auditRaw = audited.raw;
  }

  const parsed = parseAuditReport(auditRaw);
  const result = parsed.ok
    ? evaluateAuditPolicy({ baseline, lockfileSha256, parsed })
    : evaluateAuditPolicy({ baseline, lockfileSha256, auditRaw });

  writeRelative(root, path.join(outDir, "audit.json"), `${JSON.stringify(parsed.ok ? parsed.raw : { malformed: true }, null, 2)}\n`);
  writeRelative(root, path.join(outDir, "audit-baseline-verification.json"), `${JSON.stringify(verificationDocument(result), null, 2)}\n`);
  writeRelative(root, path.join(outDir, "package-lock.sha256"), `${lockfileSha256}  ${LOCKFILE_RELATIVE_PATH}\n`);
  writeActionInventory(root, outDir);
  return result;
}

function isMain(argv1: string | undefined): boolean {
  return typeof argv1 === "string" && pathToFileURL(path.resolve(argv1)).href === import.meta.url;
}

function main(argv: string[]): void {
  const root = repoRootFromHere();
  if (argv[0] === "sanitize-log") {
    const input = fs.readFileSync(0, "utf8");
    process.stdout.write(sanitizeForArtifact(input, root));
    return;
  }
  const auditJsonIndex = argv.indexOf("--audit-json");
  const auditJsonPath = auditJsonIndex >= 0 ? argv[auditJsonIndex + 1] : undefined;
  const result = runAuditBaseline(root, { auditJsonPath });
  const actions = inventoryGitRepository(root, { requireProductionPins: true });
  if (!result.ok || !actions.overallPolicyOk) {
    console.error(JSON.stringify({
      ok: false,
      codes: result.codes,
      actionCodes: actions.codes,
      metadataMatchesObserved: result.metadataMatchesObserved,
      overallPolicyOk: false,
    }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    codes: result.codes,
    metadata: result.metadata,
    observed: result.observed,
    metadataMatchesObserved: result.metadataMatchesObserved,
    high: result.highCount,
    critical: result.criticalCount,
    total: result.totalCount,
    resolvedHigh: result.resolvedHigh.map((row) => row.advisoryId),
    actionUsesTotal: actions.actionUsesTotal,
    unpinnedExternalActions: actions.unpinnedExternalActions,
    unsafeCheckouts: actions.unsafeCheckouts,
    existingHighAreNotCleared: true,
  }, null, 2));
}

if (isMain(process.argv[1])) {
  main(process.argv.slice(2));
}
