import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANARY_ENTRYPOINT_RELATIVE,
  CANARY_LOCKFILE_RELATIVE,
  collectInstalledPackageNames,
  copyCanaryLockfileInstall,
  forbiddenPackagesPresentInLockfile,
  installCanaryTarball,
  packExtendedCanary,
  runNpmAuditOmitDev,
  sha256File,
} from "../../../scripts/security/extended-canary-boundary.js";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const targetRoot = path.resolve(arg("--target-root"));
const outDir = path.resolve(arg("--out-dir"));
fs.mkdirSync(outDir, { recursive: true });

const started = new Date().toISOString();
const packed = packExtendedCanary(targetRoot, path.join(outDir, "packed"));
const tarList = spawnSync("tar", ["-tzf", packed.tarballPath], { encoding: "utf8" });
if (tarList.status !== 0) throw new Error(`CANARY_TAR_LIST_FAILED:${tarList.stderr}`);
fs.writeFileSync(path.join(outDir, "tarball-list.txt"), tarList.stdout || "");
fs.copyFileSync(path.join(targetRoot, CANARY_LOCKFILE_RELATIVE), path.join(outDir, "canary-package-lock.json"));
fs.copyFileSync(packed.tarballPath, path.join(outDir, path.basename(packed.tarballPath)));
const stagingManifest = path.join(packed.stagingDir, "content-manifest.json");
if (fs.existsSync(stagingManifest)) {
  fs.copyFileSync(stagingManifest, path.join(outDir, "content-manifest.json"));
}

const lockRaw = fs.readFileSync(path.join(targetRoot, CANARY_LOCKFILE_RELATIVE), "utf8");
const lockInstallStarted = new Date().toISOString();
const lockInstallDir = copyCanaryLockfileInstall(targetRoot);
const lockInstallEnded = new Date().toISOString();
const auditStarted = new Date().toISOString();
const audit = runNpmAuditOmitDev(lockInstallDir);
const auditEnded = new Date().toISOString();
fs.writeFileSync(path.join(outDir, "canary-audit.json"), `${audit.raw}\n`);
fs.writeFileSync(
  path.join(outDir, "canary-audit-meta.json"),
  `${JSON.stringify({
    queried_at_utc_start: auditStarted,
    queried_at_utc_end: auditEnded,
    cwd: lockInstallDir,
    command: ["npm", "audit", "--omit=dev", "--json"],
    exitCode: audit.exitCode,
    counts: audit.counts,
    is_historical_zero_high_reuse: false,
    is_this_round_query: true,
  }, null, 2)}\n`,
);

const tarballInstallStarted = new Date().toISOString();
const installDir = installCanaryTarball(packed.tarballPath);
const tarballInstallEnded = new Date().toISOString();
const installedNames = collectInstalledPackageNames(installDir);
fs.writeFileSync(path.join(outDir, "installed-package-names.json"), `${JSON.stringify(installedNames, null, 2)}\n`);
fs.writeFileSync(
  path.join(outDir, "install-dirs.json"),
  `${JSON.stringify({ lockInstallDir, tarballInstallDir: installDir }, null, 2)}\n`,
);

const entrypoint = path.join(targetRoot, CANARY_ENTRYPOINT_RELATIVE);
const entrySha = sha256File(entrypoint);
const payload = {
  schema: "classic-canary-registry-phase/20260908",
  phase: "registry",
  started_at_utc: started,
  ended_at_utc: new Date().toISOString(),
  target_root: targetRoot,
  tool_file: fileURLToPath(import.meta.url),
  identities: {
    packed_lockfile_sha256: packed.lockfileSha256,
    artifact_sha256: packed.tarballSha256,
    artifact_sha256_second: packed.tarballSha256Second,
    content_manifest_sha256: packed.contentManifestSha256,
    entrypoint_relative: CANARY_ENTRYPOINT_RELATIVE,
    entrypoint_sha256: entrySha,
    lockfile_relative: CANARY_LOCKFILE_RELATIVE,
  },
  staged_files: packed.stagedFiles,
  forbidden_in_lockfile_existing_tool: forbiddenPackagesPresentInLockfile(lockRaw),
  lockfile_install: {
    started_at_utc: lockInstallStarted,
    ended_at_utc: lockInstallEnded,
    dir: lockInstallDir,
  },
  tarball_install: {
    started_at_utc: tarballInstallStarted,
    ended_at_utc: tarballInstallEnded,
    dir: installDir,
    installed_names: installedNames,
  },
  audit: {
    queried_at_utc_start: auditStarted,
    queried_at_utc_end: auditEnded,
    exitCode: audit.exitCode,
    counts: audit.counts,
  },
};
fs.writeFileSync(path.join(outDir, "registry-phase.json"), `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
