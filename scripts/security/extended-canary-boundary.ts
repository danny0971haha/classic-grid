import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANARY_PACKAGE_DIR = "packages/extended-canary";
export const CANARY_MANIFEST_RELATIVE = `${CANARY_PACKAGE_DIR}/file-manifest.json`;
export const CANARY_PACKAGE_JSON_RELATIVE = `${CANARY_PACKAGE_DIR}/package.json`;
export const CANARY_LOCKFILE_RELATIVE = `${CANARY_PACKAGE_DIR}/package-lock.json`;
export const CANARY_ENTRYPOINT_RELATIVE = "src/cli/run-extended-canary.ts";
export const FORBIDDEN_CANARY_PACKAGES = [
  "@n1xyz/nord-ts",
  "@n1xyz/proton",
  "@solana/web3.js",
  "@solana/buffer-layout-utils",
  "@solana/spl-token",
  "@nadohq/client",
  "@nadohq/shared",
  "@nadohq/engine-client",
  "@nadohq/indexer-client",
  "@nadohq/mobile-client",
  "@nadohq/trigger-client",
  "axios",
  "bigint-buffer",
  "viem",
] as const;
export const FORBIDDEN_NESTED_WS_PATH = "node_modules/viem/node_modules/ws";
export const CANARY_VENUE_UNAVAILABLE = "CANARY_VENUE_UNAVAILABLE";
const FIXED_MTIME = new Date("2026-01-01T00:00:00.000Z");

export type CanaryFileManifest = {
  schemaVersion: string;
  files: string[];
  forbiddenSourcePaths: string[];
};

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function readCanaryManifest(root = repoRootFromHere()): CanaryFileManifest {
  const raw = JSON.parse(fs.readFileSync(path.join(root, CANARY_MANIFEST_RELATIVE), "utf8")) as CanaryFileManifest;
  if (raw.schemaVersion !== "classic-v0.2-extended-canary-file-manifest/1") {
    throw new Error("CANARY_MANIFEST_SCHEMA");
  }
  if (!Array.isArray(raw.files) || raw.files.length < 1) throw new Error("CANARY_MANIFEST_EMPTY");
  return raw;
}

export function forbiddenPackagesPresentInLockfile(lockfileRaw: string): string[] {
  const present: string[] = [];
  for (const name of FORBIDDEN_CANARY_PACKAGES) {
    const key = `"node_modules/${name}"`;
    const nameField = `"name": "${name}"`;
    if (lockfileRaw.includes(key) || lockfileRaw.includes(nameField)) present.push(name);
  }
  if (lockfileRaw.includes("viem/node_modules/ws") || lockfileRaw.includes(FORBIDDEN_NESTED_WS_PATH)) {
    present.push(FORBIDDEN_NESTED_WS_PATH);
  }
  return [...new Set(present)].sort();
}

export function normalizeModuleSpecifier(specifier: string): string {
  let value = specifier.trim();
  if (/^file:/i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      value = value.replace(/^file:\/\//i, "");
      try {
        value = decodeURIComponent(value);
      } catch {
        /* keep undecodable file URL tail */
      }
    }
  } else {
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep original when percent-encoding is malformed */
    }
  }
  value = value.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  return path.posix.normalize(value);
}

function specifierMatchesForbiddenPackage(normalized: string, name: string): boolean {
  return (
    normalized === name ||
    normalized.startsWith(`${name}/`) ||
    normalized === `node_modules/${name}` ||
    normalized.startsWith(`node_modules/${name}/`) ||
    normalized.includes(`/node_modules/${name}/`) ||
    normalized.endsWith(`/node_modules/${name}`)
  );
}

export function isForbiddenModuleSpecifier(specifier: string): boolean {
  const raw = specifier.replaceAll("\\", "/");
  const normalized = normalizeModuleSpecifier(specifier);
  const candidates = new Set([specifier, raw, normalized]);
  for (const candidate of candidates) {
    for (const name of FORBIDDEN_CANARY_PACKAGES) {
      if (specifierMatchesForbiddenPackage(candidate, name) || candidate.startsWith(`${name}/`)) {
        return true;
      }
    }
    if (candidate.includes("viem/node_modules/ws") || candidate.includes("/viem/node_modules/ws")) {
      return true;
    }
  }
  return false;
}

const FORBIDDEN_CANARY_SOURCE_BASENAMES = [
  "n1.ts",
  "n1.js",
  "phoenix.ts",
  "phoenix.js",
  "phoenix2.ts",
  "phoenix2.js",
  "nado.ts",
  "nado.js",
  "popdex.ts",
  "popdex.js",
  "decibel.ts",
  "decibel.js",
  "decibelLive.ts",
  "decibelLive.js",
  "risex.ts",
  "risex.js",
  "officialStats.ts",
  "officialStats.js",
  "venues/index.ts",
  "venues/index.js",
] as const;

function isAllowedLoopFallback(rel: string, specifier: string): boolean {
  return rel.replaceAll("\\", "/") === "src/loop.ts"
    && (specifier === "./venues/index.js" || specifier === "./officialStats.js");
}

function isTypeOnlyImportFrom(source: string, fromIndex: number): boolean {
  const prefix = source.slice(Math.max(0, fromIndex - 240), fromIndex);
  const stmt = prefix.slice(prefix.lastIndexOf(";") + 1);
  return /^\s*import\s+type\b/.test(stmt);
}

function specifierLooksLikeForbiddenSource(specifier: string): boolean {
  const normalized = normalizeModuleSpecifier(specifier);
  for (const base of FORBIDDEN_CANARY_SOURCE_BASENAMES) {
    if (
      normalized === base
      || normalized.endsWith(`/${base}`)
      || normalized.endsWith(`\\${base}`)
    ) {
      return true;
    }
  }
  return false;
}

export function scanCanarySourceText(source: string, rel = ""): string[] {
  const hits: string[] = [];
  if (
    /\beval\s*\(/.test(source)
    || /\(\s*0\s*,\s*eval\s*\)/.test(source)
    || /globalThis\s*(?:\[\s*["']eval["']\s*\]|\.eval\b)/.test(source)
  ) {
    hits.push("eval");
  }
  if (/\bnew\s+Function\s*\(/.test(source) || /\(\s*0\s*,\s*Function\s*\)/.test(source)) {
    hits.push("Function");
  }
  if (/\bmodule\.createRequire\s*\(/.test(source) || /\bcreateRequire\s*\(/.test(source)) {
    hits.push("createRequire");
  }
  const literalRe =
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bfrom\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\brequire\.resolve\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(literalRe)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    if (!specifier || isAllowedLoopFallback(rel, specifier)) continue;
    if (match[2] && isTypeOnlyImportFrom(source, match.index ?? 0)) continue;
    if (isForbiddenModuleSpecifier(specifier) || specifierLooksLikeForbiddenSource(specifier)) {
      hits.push(`specifier:${specifier}`);
    }
  }
  for (const match of source.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    const inner = match[1] ?? "";
    if (/^\s*["'][^"']*["']\s*$/.test(inner)) continue;
    if (isAllowedLoopFallback(rel, inner.trim())) continue;
    for (const base of FORBIDDEN_CANARY_SOURCE_BASENAMES) {
      if (inner.includes(base)) hits.push(`non-literal-import:${base}`);
    }
    for (const name of FORBIDDEN_CANARY_PACKAGES) {
      if (inner.includes(name)) hits.push(`non-literal-import:${name}`);
    }
  }
  return [...new Set(hits)];
}

export function scanCanaryTree(root = repoRootFromHere()): string[] {
  const manifest = readCanaryManifest(root);
  const hits: string[] = [];
  for (const rel of manifest.files) {
    if (!rel.endsWith(".ts") && !rel.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    for (const hit of scanCanarySourceText(text, rel)) hits.push(`${rel}:${hit}`);
  }
  return hits;
}

export function assertCanarySourceBoundary(root: string, rel: string): string {
  assertRelativeSafe(rel);
  const src = path.join(root, rel);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new Error(`CANARY_SOURCE_MISSING:${rel}`);
  }
  if (fs.lstatSync(src).isSymbolicLink()) {
    throw new Error(`CANARY_SYMLINK_SOURCE:${rel}`);
  }
  const realRoot = fs.realpathSync(root);
  const realSrc = fs.realpathSync(src);
  const relReal = path.relative(realRoot, realSrc).replaceAll("\\", "/");
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
    throw new Error(`CANARY_PATH_ESCAPE:${rel}`);
  }
  if (relReal !== rel.replaceAll("\\", "/")) {
    throw new Error(`CANARY_SYMLINK_SOURCE:${rel}->${relReal}`);
  }
  return realSrc;
}

function assertRelativeSafe(rel: string): void {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new Error(`CANARY_PATH_ESCAPE:${rel}`);
  }
}

function copyFileFrozen(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o644);
  fs.utimesSync(dest, FIXED_MTIME, FIXED_MTIME);
}

export function listStagedFiles(dir: string, prefix = ""): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listStagedFiles(full, rel));
    else out.push(rel.replaceAll("\\", "/"));
  }
  return out;
}

export function findSecretLikeFiles(files: string[]): string[] {
  const bad: string[] = [];
  for (const rel of files) {
    const base = path.posix.basename(rel);
    const lower = rel.toLowerCase();
    if (
      base === ".env" ||
      base.startsWith(".env.") ||
      base.endsWith(".map") ||
      base.endsWith(".log") ||
      lower.includes("/fixtures/") ||
      lower.includes("/secrets/") ||
      lower.endsWith(".pem") ||
      lower.endsWith(".key")
    ) {
      bad.push(rel);
    }
  }
  return bad;
}

export type PackedCanary = {
  stagingDir: string;
  tarballPath: string;
  tarballSha256: string;
  lockfileSha256: string;
  stagedFiles: string[];
};

export function stageExtendedCanary(root = repoRootFromHere(), stagingDir?: string): PackedCanary["stagingDir"] {
  const manifest = readCanaryManifest(root);
  const staging = stagingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "classic-extended-canary-stage-"));
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  copyFileFrozen(path.join(root, CANARY_PACKAGE_JSON_RELATIVE), path.join(staging, "package.json"));
  copyFileFrozen(path.join(root, CANARY_LOCKFILE_RELATIVE), path.join(staging, "package-lock.json"));
  const readme = path.join(root, CANARY_PACKAGE_DIR, "README.md");
  if (fs.existsSync(readme)) copyFileFrozen(readme, path.join(staging, "README.md"));

  for (const rel of manifest.files) {
    const src = assertCanarySourceBoundary(root, rel);
    copyFileFrozen(src, path.join(staging, rel));
  }

  const staged = listStagedFiles(staging);
  for (const forbidden of manifest.forbiddenSourcePaths) {
    if (staged.some((rel) => rel === forbidden || rel.startsWith(`${forbidden}/`))) {
      throw new Error(`CANARY_FORBIDDEN_SOURCE:${forbidden}`);
    }
  }
  const secretLike = findSecretLikeFiles(staged);
  if (secretLike.length) throw new Error(`CANARY_SECRET_LIKE:${secretLike.join(",")}`);
  return staging;
}

export function packExtendedCanary(root = repoRootFromHere(), outDir?: string): PackedCanary {
  const stagingDir = stageExtendedCanary(root);
  const destDir = outDir ?? path.join(root, "artifacts", "extended-canary");
  fs.mkdirSync(destDir, { recursive: true });
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", destDir], {
    cwd: stagingDir,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  if (packed.status !== 0) {
    throw new Error(`CANARY_PACK_FAILED:${packed.stderr || packed.stdout}`);
  }
  const rows = JSON.parse(packed.stdout) as Array<{ filename?: string; name?: string }>;
  const filename = rows[0]?.filename;
  if (!filename) throw new Error("CANARY_PACK_FILENAME_MISSING");
  const tarballPath = path.join(destDir, filename);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-canary-packfix-"));
  const extracted = spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(`CANARY_PACK_EXTRACT_FAILED:${extracted.stderr}`);
  const packageDir = path.join(extractDir, "package");
  if (!fs.existsSync(packageDir)) throw new Error("CANARY_PACK_PREFIX_MISSING");
  fs.copyFileSync(path.join(stagingDir, "package-lock.json"), path.join(packageDir, "package-lock.json"));
  fs.utimesSync(path.join(packageDir, "package-lock.json"), FIXED_MTIME, FIXED_MTIME);
  const retar = spawnSync("tar", ["-czf", tarballPath, "-C", extractDir, "package"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (retar.status !== 0) throw new Error(`CANARY_PACK_RETAR_FAILED:${retar.stderr}`);
  const listed = spawnSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
  if (listed.status !== 0 || !(listed.stdout || "").includes("package-lock.json")) {
    throw new Error("CANARY_PACK_LOCKFILE_MISSING");
  }
  fs.rmSync(extractDir, { recursive: true, force: true });
  const lockfileSha256 = sha256File(path.join(stagingDir, "package-lock.json"));
  return {
    stagingDir,
    tarballPath,
    tarballSha256: sha256File(tarballPath),
    lockfileSha256,
    stagedFiles: listStagedFiles(stagingDir),
  };
}

export type CanaryAuditCounts = {
  critical: number;
  high: number;
  moderate: number;
  low: number;
  info: number;
  total: number;
};

export function parseAuditCounts(raw: string): CanaryAuditCounts {
  const parsed = JSON.parse(raw) as {
    metadata?: { vulnerabilities?: Record<string, unknown> };
  };
  const meta = parsed.metadata?.vulnerabilities ?? {};
  const num = (key: string): number => {
    const value = meta[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`CANARY_AUDIT_COUNT_INVALID:${key}`);
    }
    return value;
  };
  return {
    info: num("info"),
    low: num("low"),
    moderate: num("moderate"),
    high: num("high"),
    critical: num("critical"),
    total: num("total"),
  };
}

export function runNpmAuditOmitDev(cwd: string): { exitCode: number; raw: string; counts: CanaryAuditCounts } {
  const spawned = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  const raw = spawned.stdout || "";
  if (!raw.trim()) throw new Error(`CANARY_AUDIT_EMPTY:${spawned.stderr || spawned.status}`);
  return {
    exitCode: spawned.status ?? 1,
    raw,
    counts: parseAuditCounts(raw),
  };
}

export function installCanaryTarball(tarballPath: string, installDir?: string): string {
  const dir = installDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "classic-extended-canary-install-"));
  fs.mkdirSync(dir, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", tarballPath, "-C", dir, "--strip-components=1"], {
    encoding: "utf8",
  });
  if (extracted.status !== 0) {
    throw new Error(`CANARY_EXTRACT_FAILED:${extracted.stderr || extracted.stdout}`);
  }
  if (!fs.existsSync(path.join(dir, "package-lock.json"))) {
    throw new Error("CANARY_TARBALL_LOCKFILE_MISSING");
  }
  fs.writeFileSync(path.join(dir, ".npmrc"), "ignore-scripts=true\nfund=false\nupdate-notifier=false\n");
  const installed = spawnSync("npm", ["ci", "--omit=dev", "--no-fund", "--ignore-scripts"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (installed.status !== 0) {
    throw new Error(`CANARY_INSTALL_FAILED:${installed.stderr || installed.stdout}`);
  }
  return dir;
}

export function canaryPackageRootFromInstall(installDir: string): string {
  if (!fs.existsSync(path.join(installDir, CANARY_ENTRYPOINT_RELATIVE))) {
    throw new Error("CANARY_INSTALL_ENTRY_MISSING");
  }
  return installDir;
}

export function collectInstalledPackageNames(installDir: string): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".bin") continue;
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        walk(full);
        continue;
      }
      const pkgJson = path.join(full, "package.json");
      if (entry.isDirectory() && fs.existsSync(pkgJson)) {
        const name = JSON.parse(fs.readFileSync(pkgJson, "utf8")) as { name?: string };
        if (name.name) names.add(name.name);
        walk(path.join(full, "node_modules"));
      }
    }
  };
  walk(path.join(installDir, "node_modules"));
  return [...names].sort();
}

export type CanaryProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  loadedModules: string[];
  forbiddenLoaded: string[];
  unexpectedNetwork: string[];
  liveExchangeWrite: boolean;
  productionCredentialUsed: boolean;
};

export function copyCanaryLockfileInstall(root = repoRootFromHere(), destDir?: string): string {
  const dir = destDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "classic-canary-lock-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, CANARY_PACKAGE_JSON_RELATIVE), path.join(dir, "package.json"));
  fs.copyFileSync(path.join(root, CANARY_LOCKFILE_RELATIVE), path.join(dir, "package-lock.json"));
  fs.writeFileSync(path.join(dir, ".npmrc"), "ignore-scripts=true\nfund=false\nupdate-notifier=false\n");
  const installed = spawnSync("npm", ["ci", "--omit=dev", "--no-fund", "--ignore-scripts"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (installed.status !== 0) {
    throw new Error(`CANARY_LOCK_CI_FAILED:${installed.stderr || installed.stdout}`);
  }
  return dir;
}

export function runCanaryOfflineProbe(p: {
  canaryRoot: string;
  cwd: string;
  repoRoot?: string;
  extraEnv?: Record<string, string>;
}): CanaryProbeResult {
  const repoRoot = p.repoRoot ?? repoRootFromHere();
  const probePath = path.join(repoRoot, "scripts/security/canary-offline-probe.ts");
  const registerPath = path.join(repoRoot, "scripts/security/register-module-load-hook.mjs");
  const loadLog = path.join(os.tmpdir(), `classic-canary-modules-${process.pid}-${Date.now()}.log`);
  const netLog = path.join(os.tmpdir(), `classic-canary-net-${process.pid}-${Date.now()}.log`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...p.extraEnv,
    CANARY_ROOT: p.canaryRoot,
    MODULE_LOAD_LOG: loadLog,
    NETWORK_LOG: netLog,
    DRY_RUN: "1",
    EXPERIMENT_MODE: "1",
    EXPERIMENT_SPEC_VERSION: "0.2.0",
    EXPERIMENT_ID: "classic-v02-canary-dryrun",
    VENUES: p.extraEnv?.VENUES ?? "extended",
    MARKETS: p.extraEnv?.MARKETS ?? "BTC",
    DASHBOARD_PORT: p.extraEnv?.DASHBOARD_PORT ?? "0",
    TELEGRAM_ENABLED: "0",
    HOME: p.cwd,
    npm_config_update_notifier: "false",
  };
  delete env.LIVE_CONFIRM;
  delete env.EXTENDED_API_KEY;
  delete env.EXTENDED_VAULT;
  delete env.EXTENDED_VAULT_ID;
  delete env.EXTENDED_STARK_PRIVATE_KEY;
  delete env.EXTENDED_STARK_PUBLIC_KEY;
  delete env.NPM_TOKEN;
  delete env.NODE_AUTH_TOKEN;
  const spawned = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(registerPath).href, "--import", "tsx", probePath],
    {
      cwd: p.cwd,
      encoding: "utf8",
      env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
      killSignal: "SIGTERM",
    },
  );
  const loadedModules = fs.existsSync(loadLog)
    ? fs.readFileSync(loadLog, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  const unexpectedNetwork = fs.existsSync(netLog)
    ? fs.readFileSync(netLog, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  const forbiddenLoaded = [...new Set(loadedModules.filter(isForbiddenModuleSpecifier))].sort();
  const combined = `${spawned.stdout || ""}\n${spawned.stderr || ""}`;
  return {
    exitCode: spawned.status ?? 1,
    stdout: spawned.stdout || "",
    stderr: spawned.stderr || "",
    loadedModules,
    forbiddenLoaded,
    unexpectedNetwork,
    liveExchangeWrite: /LIVE_EXCHANGE_WRITE=YES/.test(combined) || /placeLimitOrder|eth_sendRawTransaction/.test(combined),
    productionCredentialUsed: /EXTENDED_API_KEY=|STARK_PRIVATE_KEY=/.test(combined),
  };
}

export type CanaryVerification = {
  ok: boolean;
  codes: string[];
  lockfileSha256: string;
  artifactSha256: string;
  audit: CanaryAuditCounts;
  forbiddenInLockfile: string[];
  forbiddenInstalled: string[];
  forbiddenLoaded: string[];
  loadedModuleInventory: string[];
  unexpectedNetwork: string[];
  secretLikeFiles: string[];
  liveExchangeWrite: boolean;
  productionCredentialUsed: boolean;
  probeExitCode: number;
  unavailableVenueExitCode: number;
  unavailableVenueError: string;
};

export function verifyExtendedCanary(root = repoRootFromHere()): CanaryVerification {
  const lockfileSha256 = sha256File(path.join(root, CANARY_LOCKFILE_RELATIVE));
  const lockRaw = fs.readFileSync(path.join(root, CANARY_LOCKFILE_RELATIVE), "utf8");
  const forbiddenInLockfile = forbiddenPackagesPresentInLockfile(lockRaw);
  const packed = packExtendedCanary(root, path.join(root, "artifacts", "extended-canary"));
  const secretLikeFiles = findSecretLikeFiles(packed.stagedFiles);
  const lockInstallDir = copyCanaryLockfileInstall(root);
  const audit = runNpmAuditOmitDev(lockInstallDir);
  const installDir = installCanaryTarball(packed.tarballPath);
  const canaryRoot = canaryPackageRootFromInstall(installDir);
  const installedNames = collectInstalledPackageNames(installDir);
  const forbiddenInstalled = installedNames.filter((name) =>
    (FORBIDDEN_CANARY_PACKAGES as readonly string[]).includes(name),
  );
  const nestedWs = path.join(installDir, "node_modules", "viem", "node_modules", "ws");
  if (fs.existsSync(nestedWs)) forbiddenInstalled.push(FORBIDDEN_NESTED_WS_PATH);
  const probe = runCanaryOfflineProbe({ canaryRoot, cwd: installDir, repoRoot: root });
  const unavailable = runCanaryOfflineProbe({
    canaryRoot,
    cwd: installDir,
    repoRoot: root,
    extraEnv: { VENUES: "nado" },
  });
  const unavailableText = `${unavailable.stdout}\n${unavailable.stderr}`;
  const codes: string[] = [];
  const sourceHits = scanCanaryTree(root);
  if (forbiddenInLockfile.length) codes.push("FORBIDDEN_IN_LOCKFILE");
  if (forbiddenInstalled.length) codes.push("FORBIDDEN_INSTALLED");
  if (probe.forbiddenLoaded.length) codes.push("FORBIDDEN_LOADED");
  if (sourceHits.length) codes.push("FORBIDDEN_SOURCE_SCAN");
  if (probe.unexpectedNetwork.length) codes.push("UNEXPECTED_NETWORK");
  if (secretLikeFiles.length) codes.push("SECRET_LIKE_FILES");
  if (audit.counts.critical !== 0) codes.push("CANARY_AUDIT_CRITICAL");
  if (audit.counts.high !== 0) codes.push("CANARY_AUDIT_HIGH");
  if (probe.exitCode !== 0) codes.push("CANARY_DRY_RUN_FAILED");
  if (probe.liveExchangeWrite) codes.push("LIVE_EXCHANGE_WRITE");
  if (probe.productionCredentialUsed) codes.push("PRODUCTION_CREDENTIAL_USED");
  if (unavailable.exitCode === 0) codes.push("UNAVAILABLE_VENUE_DID_NOT_FAIL");
  if (!unavailableText.includes(`${CANARY_VENUE_UNAVAILABLE}:nado`)) {
    codes.push("UNAVAILABLE_VENUE_ERROR_UNSTABLE");
  }
  if (/venues=extended/.test(unavailable.stdout) && unavailable.exitCode === 0) {
    codes.push("UNAVAILABLE_VENUE_SILENT_FALLBACK");
  }
  fs.mkdirSync(path.join(root, "artifacts", "security"), { recursive: true });
  fs.writeFileSync(path.join(root, "artifacts", "security", "extended-canary-audit.json"), `${audit.raw}\n`);
  return {
    ok: codes.length === 0,
    codes: codes.length ? codes : ["CHECKS_OK"],
    lockfileSha256,
    artifactSha256: packed.tarballSha256,
    audit: audit.counts,
    forbiddenInLockfile,
    forbiddenInstalled,
    forbiddenLoaded: probe.forbiddenLoaded,
    loadedModuleInventory: [...new Set(probe.loadedModules)].sort(),
    unexpectedNetwork: probe.unexpectedNetwork,
    secretLikeFiles,
    liveExchangeWrite: probe.liveExchangeWrite,
    productionCredentialUsed: probe.productionCredentialUsed,
    probeExitCode: probe.exitCode,
    unavailableVenueExitCode: unavailable.exitCode ?? 1,
    unavailableVenueError: unavailableText.slice(0, 500),
  };
}
