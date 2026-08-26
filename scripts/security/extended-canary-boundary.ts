import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type CanaryFileManifest,
  parseCanaryManifestFile,
} from "./canary-manifest-schema.js";
import { writeContentManifest, verifyExtractedTree, verifyTarballContent } from "./content-manifest.js";
import {
  FORBIDDEN_CANARY_PACKAGES,
  FORBIDDEN_NESTED_WS_PATH,
  isForbiddenModuleSpecifier,
  normalizeModuleSpecifier,
} from "./forbidden-specifiers.js";
import { assertCanaryModuleGraph, parseModuleGraphLog, type ModuleGraphRecord } from "./module-graph.js";
import { analyzeCanarySourcePolicy, sourcePolicyHits } from "./source-policy.js";

export {
  FORBIDDEN_CANARY_PACKAGES,
  FORBIDDEN_NESTED_WS_PATH,
  isForbiddenModuleSpecifier,
  normalizeModuleSpecifier,
};
export type { CanaryFileManifest };

export const CANARY_PACKAGE_DIR = "packages/extended-canary";
export const CANARY_MANIFEST_RELATIVE = `${CANARY_PACKAGE_DIR}/file-manifest.json`;
export const CANARY_PACKAGE_JSON_RELATIVE = `${CANARY_PACKAGE_DIR}/package.json`;
export const CANARY_LOCKFILE_RELATIVE = `${CANARY_PACKAGE_DIR}/package-lock.json`;
export const CANARY_ENTRYPOINT_RELATIVE = "src/cli/run-extended-canary.ts";
export const CANARY_VENUE_UNAVAILABLE = "CANARY_VENUE_UNAVAILABLE";
const FIXED_MTIME = new Date("2026-01-01T00:00:00.000Z");

export function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function readCanaryManifest(root = repoRootFromHere()): CanaryFileManifest {
  return parseCanaryManifestFile(root, CANARY_MANIFEST_RELATIVE);
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

function stripJsComments(inner: string): string {
  return inner.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ").trim();
}

function joinStringLiteralConcat(expr: string): string | undefined {
  const parts = expr.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const out: string[] = [];
  for (const part of parts) {
    const matched = /^["']([^"']*)["']$/.exec(part) ?? /^`([^`$]*)`$/.exec(part);
    if (!matched) return undefined;
    out.push(matched[1] ?? "");
  }
  return out.join("");
}

function literalSpecifierFromExpr(expr: string): string | undefined {
  const stripped = stripJsComments(expr);
  const simple = /^["']([^"']*)["']$/.exec(stripped) ?? /^`([^`$]*)`$/.exec(stripped);
  if (simple) return simple[1];
  return joinStringLiteralConcat(stripped);
}

function specifierLooksLikeBlockedNetwork(specifier: string): boolean {
  const normalized = normalizeModuleSpecifier(specifier);
  for (const candidate of [specifier, normalized]) {
    if (
      candidate === "node:tls"
      || candidate === "tls"
      || candidate === "node:dgram"
      || candidate === "dgram"
      || candidate === "node:https"
      || candidate === "https"
    ) {
      return true;
    }
  }
  return false;
}

function hitsForLoadedSpecifier(specifier: string): string[] {
  const out: string[] = [];
  if (!specifier) return out;
  if (isForbiddenModuleSpecifier(specifier) || specifierLooksLikeForbiddenSource(specifier)) {
    out.push(`specifier:${specifier}`);
  }
  if (specifierLooksLikeBlockedNetwork(specifier)) {
    out.push(`network:${specifier}`);
  }
  return out;
}

function scanLoaderArgument(inner: string, rel: string, nonLiteralTag: string): string[] {
  const specifier = literalSpecifierFromExpr(inner);
  if (specifier) {
    if (isAllowedLoopFallback(rel, specifier)) return [];
    return hitsForLoadedSpecifier(specifier);
  }
  if (isAllowedLoopFallback(rel, inner.trim())) return [];
  const stripped = stripJsComments(inner);
  const out: string[] = [];
  for (const base of FORBIDDEN_CANARY_SOURCE_BASENAMES) {
    if (stripped.includes(base)) out.push(`${nonLiteralTag}:${base}`);
  }
  for (const name of FORBIDDEN_CANARY_PACKAGES) {
    if (stripped.includes(name)) out.push(`${nonLiteralTag}:${name}`);
  }
  for (const name of ["node:tls", "node:dgram", "node:https"] as const) {
    if (stripped.includes(name)) out.push(`${nonLiteralTag}:${name}`);
  }
  return out;
}

export function scanCanarySourceText(source: string, rel = ""): string[] {
  const hits: string[] = [];
  if (
    /\beval\s*\(/.test(source)
    || /\(\s*0\s*,\s*eval\s*\)/.test(source)
    || /globalThis\s*(?:\[\s*["']eval["']\s*\]|\.eval\b)/.test(source)
    || /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*eval\b/.test(source)
    || /\beval\s*\.\s*(?:call|apply|bind)\b/.test(source)
  ) {
    hits.push("eval");
  }
  if (
    /\bFunction\s*\(/.test(source)
    || /\(\s*0\s*,\s*Function\s*\)/.test(source)
    || /globalThis\s*(?:\[\s*["']Function["']\s*\]|\.Function\b)/.test(source)
    || /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*Function\b/.test(source)
    || /\bFunction\s*\.\s*(?:call|apply|bind)\b/.test(source)
    || /\bFunction\s*`/.test(source)
    || /\.constructor\s*\.\s*(?:call|apply|bind)\b/.test(source)
  ) {
    hits.push("Function");
  }
  if (/\bcreateRequire\b/.test(source)) {
    hits.push("createRequire");
  }
  if (/\bprocess\s*(?:\[\s*["']getBuiltinModule["']\s*\]|\.\s*getBuiltinModule\b)/.test(source)) {
    hits.push("getBuiltin");
  }
  if (/\bModule\s*(?:\[\s*["']_load["']\s*\]|\.\s*_load\b)/.test(source)) {
    hits.push("module-load");
  }
  if (/\bmodule\s*(?:\[\s*["']require["']\s*\]|\.\s*require\b)/.test(source)) {
    hits.push("module-require");
  }
  if (/\bimport\s*\.\s*meta\s*\.\s*resolve\b/.test(source)) {
    hits.push("import-meta-resolve");
  }
  if (/\bReflect\s*\.\s*construct\b/.test(source)) {
    hits.push("reflect-construct");
  }
  if (/\{\s*(?:require|eval)\s*(?::|\})/.test(source)) {
    hits.push("destructure-loader");
  }
  if (/(?:globalThis|global|process|module|Module|Reflect)\s*\[[^\]]+\]\s*\(/.test(source)) {
    hits.push("computed-dispatch");
  }
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    const specifier = match[1] ?? "";
    if (!specifier || isAllowedLoopFallback(rel, specifier)) continue;
    if (isTypeOnlyImportFrom(source, match.index ?? 0)) continue;
    hits.push(...hitsForLoadedSpecifier(specifier));
  }
  for (const match of source.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    const specifier = match[1] ?? "";
    if (!specifier || isAllowedLoopFallback(rel, specifier)) continue;
    hits.push(...hitsForLoadedSpecifier(specifier));
  }
  for (const match of source.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    hits.push(...scanLoaderArgument(match[1] ?? "", rel, "non-literal-import"));
  }
  for (const match of source.matchAll(/\brequire(?:\.resolve)?\s*\(([^)]*)\)/g)) {
    hits.push(...scanLoaderArgument(match[1] ?? "", rel, "non-literal-require"));
  }
  return [...new Set(hits)];
}

export function scanCanaryTree(root = repoRootFromHere()): string[] {
  const manifest = readCanaryManifest(root);
  const hits = sourcePolicyHits(analyzeCanarySourcePolicy(root, manifest));
  for (const rel of manifest.runtimeFiles) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    for (const hit of scanCanarySourceText(text, rel)) hits.push(`${rel}:${hit}`);
  }
  return [...new Set(hits)];
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
  tarballSha256Second: string;
  lockfileSha256: string;
  contentManifestSha256: string;
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
  copyFileFrozen(path.join(root, CANARY_MANIFEST_RELATIVE), path.join(staging, "file-manifest.json"));

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

function tarStagingAsNpmPackage(stagingDir: string, tarballPath: string): void {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-canary-tarwrap-"));
  const packageDir = path.join(extractDir, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  for (const rel of listStagedFiles(stagingDir)) {
    copyFileFrozen(path.join(stagingDir, rel), path.join(packageDir, rel));
  }
  const retar = spawnSync("tar", ["-czf", tarballPath, "-C", extractDir, "package"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  fs.rmSync(extractDir, { recursive: true, force: true });
  if (retar.status !== 0) throw new Error(`CANARY_PACK_RETAR_FAILED:${retar.stderr}`);
}

function packExtendedCanaryOnce(root: string, destDir: string): PackedCanary {
  const stagingDir = stageExtendedCanary(root);
  const written = writeContentManifest(stagingDir);
  fs.mkdirSync(destDir, { recursive: true });
  const tarballPath = path.join(destDir, "classic-grid-extended-canary-0.2.0.tgz");
  tarStagingAsNpmPackage(stagingDir, tarballPath);
  const listed = spawnSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
  if (listed.status !== 0 || !(listed.stdout || "").includes("package-lock.json")) {
    throw new Error("CANARY_PACK_LOCKFILE_MISSING");
  }
  if (!(listed.stdout || "").includes("file-manifest.json")) throw new Error("CANARY_PACK_POLICY_MANIFEST_MISSING");
  if (!(listed.stdout || "").includes("content-manifest.json")) throw new Error("CANARY_PACK_CONTENT_MANIFEST_MISSING");
  const tgz = fs.readFileSync(tarballPath);
  const verified = verifyTarballContent(tgz, written.manifest);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-canary-extract-verify-"));
  const extracted = spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(`CANARY_PACK_EXTRACT_FAILED:${extracted.stderr}`);
  verifyExtractedTree(extractDir, verified.manifest);
  fs.rmSync(extractDir, { recursive: true, force: true });
  return {
    stagingDir,
    tarballPath,
    tarballSha256: sha256File(tarballPath),
    tarballSha256Second: "",
    lockfileSha256: sha256File(path.join(stagingDir, "package-lock.json")),
    contentManifestSha256: verified.manifestSha256,
    stagedFiles: listStagedFiles(stagingDir),
  };
}

export function packExtendedCanary(root = repoRootFromHere(), outDir?: string): PackedCanary {
  const destDir = outDir ?? path.join(root, "artifacts", "extended-canary");
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(destDir)) {
    if (name.endsWith(".tgz")) fs.rmSync(path.join(destDir, name));
  }
  const first = packExtendedCanaryOnce(root, destDir);
  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-canary-pack-b-"));
  const second = packExtendedCanaryOnce(root, secondDir);
  if (first.contentManifestSha256 !== second.contentManifestSha256) {
    throw new Error(
      `CONTENT_MANIFEST_NOT_DETERMINISTIC:${first.contentManifestSha256}:${second.contentManifestSha256}`,
    );
  }
  fs.rmSync(secondDir, { recursive: true, force: true });
  first.tarballSha256Second = second.tarballSha256;
  return first;
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
  moduleGraph: ModuleGraphRecord[];
  moduleGraphError?: string;
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
  let moduleGraph: ModuleGraphRecord[] = [];
  let moduleGraphError: string | undefined;
  const loadedModules: string[] = [];
  if (fs.existsSync(loadLog)) {
    const raw = fs.readFileSync(loadLog, "utf8");
    try {
      moduleGraph = parseModuleGraphLog(raw);
      loadedModules.push(...moduleGraph.map((row) => row.specifier));
    } catch (err) {
      moduleGraphError = String(err);
      loadedModules.push(...raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    }
  }
  const unexpectedNetwork = fs.existsSync(netLog)
    ? fs.readFileSync(netLog, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  const forbiddenLoaded = [...new Set([
    ...loadedModules.filter(isForbiddenModuleSpecifier),
    ...moduleGraph.filter((row) => isForbiddenModuleSpecifier(row.resolvedURL) || isForbiddenModuleSpecifier(row.specifier)).map((row) => row.specifier),
  ])].sort();
  const combined = `${spawned.stdout || ""}\n${spawned.stderr || ""}`;
  return {
    exitCode: spawned.status ?? 1,
    stdout: spawned.stdout || "",
    stderr: spawned.stderr || "",
    loadedModules,
    moduleGraph,
    moduleGraphError,
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
  contentManifestSha256: string;
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
  moduleGraphHits: string[];
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
  let moduleGraphHits: string[] = [];
  if (probe.moduleGraphError) {
    codes.push("MODULE_GRAPH_MALFORMED");
  } else {
    moduleGraphHits = assertCanaryModuleGraph({
      records: probe.moduleGraph,
      canaryRoot,
      repoRoot: root,
    });
  }
  if (forbiddenInLockfile.length) codes.push("FORBIDDEN_IN_LOCKFILE");
  if (forbiddenInstalled.length) codes.push("FORBIDDEN_INSTALLED");
  if (probe.forbiddenLoaded.length) codes.push("FORBIDDEN_LOADED");
  if (sourceHits.length) codes.push("FORBIDDEN_SOURCE_SCAN");
  if (probe.unexpectedNetwork.length) codes.push("UNEXPECTED_NETWORK");
  if (secretLikeFiles.length) codes.push("SECRET_LIKE_FILES");
  if (moduleGraphHits.length) codes.push("ROOT_REPOSITORY_RESOLUTION");
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
    contentManifestSha256: packed.contentManifestSha256,
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
    moduleGraphHits,
  };
}
