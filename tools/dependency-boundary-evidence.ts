import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANARY_LOCKFILE_RELATIVE,
  repoRootFromHere,
  sha256File,
  type CanaryVerification,
} from "../scripts/security/extended-canary-boundary.js";
import { defaultProjectTapCommand, REPO_ROOT as F_ROOT } from "./checkpoint-f-evidence.js";

export const EVIDENCE_SCHEMA_VERSION = "classic-v0.2-dependency-boundary-corrective/1";
export const TASK = "CHECKPOINT_F_DEPENDENCY_BOUNDARY_CORRECTIVE_1";
export const DEFAULT_EVIDENCE_PATH = "artifacts/classic-v0.2-dependency-boundary-corrective-1.json";
const BASE_SHA = "514853fd480d915491595fca4a73667087b9e3b9";

export type TapCountBlock = {
  total: number;
  pass: number;
  fail: number;
  skip: number;
};

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function parseTapCounts(tap: string): TapCountBlock {
  const grab = (name: string): number => {
    const match = tap.match(new RegExp(`^# ${name} (\\d+)\\s*$`, "m"));
    if (!match) throw new Error(`TAP_TOTAL_MISSING:${name}`);
    return Number(match[1]);
  };
  return {
    total: grab("tests"),
    pass: grab("pass"),
    fail: grab("fail"),
    skip: grab("skipped"),
  };
}

function runTap(root: string, command: string): { tap: string; counts: TapCountBlock; exitCode: number } {
  const spawned = spawnSync("bash", ["-lc", command], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, DEPENDENCY_BOUNDARY_SKIP_INSTALL_TEST: "1" },
  });
  const tap = `${spawned.stdout || ""}\n${spawned.stderr || ""}`;
  return { tap, counts: parseTapCounts(spawned.stdout || ""), exitCode: spawned.status ?? 1 };
}

export function generateDependencyBoundaryEvidence(root = repoRootFromHere()): Record<string, unknown> {
  const verificationPath = path.join(root, "artifacts/security/extended-canary-verification.json");
  if (!fs.existsSync(verificationPath)) {
    throw new Error("CANARY_VERIFICATION_MISSING");
  }
  const verification = JSON.parse(fs.readFileSync(verificationPath, "utf8")) as CanaryVerification;
  const resultSha = git(root, ["rev-parse", "HEAD"]);
  const resultTreeSha = git(root, ["rev-parse", "HEAD^{tree}"]);
  const baseTreeSha = git(root, ["rev-parse", `${BASE_SHA}^{tree}`]);
  const full = runTap(root, defaultProjectTapCommand(root === F_ROOT ? F_ROOT : root));
  const checkpointE = runTap(root, "node --import tsx --test --test-reporter=tap test/experiment-v02-checkpoint-e.test.ts");
  const checkpointF = runTap(root, "node --import tsx --test --test-reporter=tap test/experiment-v02-checkpoint-f.test.ts");
  const security = runTap(
    root,
    "node --import tsx --test --test-reporter=tap test/security/audit-baseline.test.ts test/security/action-pin.test.ts test/security/action-trust-git.test.ts test/security/extended-canary-boundary.test.ts",
  );
  const rootAuditPath = path.join(root, "artifacts/security/audit.json");
  let rootAuditCritical = -1;
  let rootAuditHigh = -1;
  if (fs.existsSync(rootAuditPath)) {
    const audit = JSON.parse(fs.readFileSync(rootAuditPath, "utf8")) as {
      metadata?: { vulnerabilities?: { critical?: number; high?: number } };
    };
    rootAuditCritical = Number(audit.metadata?.vulnerabilities?.critical ?? -1);
    rootAuditHigh = Number(audit.metadata?.vulnerabilities?.high ?? -1);
  }
  const evidence = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    task: TASK,
    baseSha: BASE_SHA,
    resultSha,
    baseTreeSha,
    resultTreeSha,
    rootLockfileSha256: sha256File(path.join(root, "package-lock.json")),
    canaryLockfileSha256: sha256File(path.join(root, CANARY_LOCKFILE_RELATIVE)),
    canaryArtifactSha256: verification.artifactSha256,
    rootAuditCritical,
    rootAuditHigh,
    canaryAuditCritical: verification.audit.critical,
    canaryAuditHigh: verification.audit.high,
    fullTestTotal: full.counts.total,
    fullTestPass: full.counts.pass,
    fullTestFail: full.counts.fail,
    fullTestSkip: full.counts.skip,
    checkpointETotal: checkpointE.counts.total,
    checkpointEPass: checkpointE.counts.pass,
    checkpointFTotal: checkpointF.counts.total,
    checkpointFPass: checkpointF.counts.pass,
    securityTestTotal: security.counts.total,
    securityTestPass: security.counts.pass,
    loadedModuleInventory: verification.loadedModuleInventory,
    forbiddenCanaryPackagesPresent: verification.forbiddenLoaded,
    liveExchangeWrite: false,
    productionCredentialUsed: false,
    mergeAuthorized: false,
    deploymentAuthorized: false,
    realFundTestingAuthorized: false,
    independentReview: "NOT_PERFORMED",
    gateStatus: "NOT_EMITTED",
    commandExitCodes: {
      fullTest: full.exitCode,
      checkpointE: checkpointE.exitCode,
      checkpointF: checkpointF.exitCode,
      security: security.exitCode,
    },
    evidenceSha256: "",
  };
  const body = { ...evidence };
  delete (body as { evidenceSha256?: string }).evidenceSha256;
  evidence.evidenceSha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return evidence;
}

export function writeDependencyBoundaryEvidence(root = repoRootFromHere()): string {
  const evidence = generateDependencyBoundaryEvidence(root);
  const out = path.join(root, DEFAULT_EVIDENCE_PATH);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  return out;
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  const cmd = process.argv[2] || "generate";
  if (cmd !== "generate") {
    process.stderr.write("usage: dependency-boundary-evidence.ts generate\n");
    process.exit(2);
  }
  const out = writeDependencyBoundaryEvidence();
  process.stdout.write(`${out}\n`);
}
