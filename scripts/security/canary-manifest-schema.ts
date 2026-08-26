import fs from "node:fs";
import path from "node:path";
import {
  GITLINK_MODE,
  REGULAR_FILE_MODES,
  SYMLINK_MODE,
  caseCollidingPaths,
  isEscapingPath,
  listGitIndex,
  type GitIndexEntry,
} from "./action-git-index.js";

export const CANARY_MANIFEST_SCHEMA = "classic-v0.2-extended-canary-file-manifest/2" as const;
export const CONTENT_MANIFEST_SCHEMA = "classic-v0.2-extended-canary-content-manifest/1" as const;
export const SOURCE_POLICY_SCHEMA = "classic-v0.2-extended-canary-source-policy/1" as const;
export const MODULE_GRAPH_SCHEMA = "classic-v0.2-extended-canary-module-graph/1" as const;

export const SCANNED_EXECUTABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"] as const;
export const UNSCANNED_EXECUTABLE_EXTENSIONS = [".jsx"] as const;
const EXECUTABLE_EXTENSIONS = new Set<string>([
  ...SCANNED_EXECUTABLE_EXTENSIONS,
  ...UNSCANNED_EXECUTABLE_EXTENSIONS,
]);

export const REQUIRED_ENTRYPOINT_BINDINGS = [
  "createExecutor",
  "refreshOfficialStats",
  "getOfficialCache",
] as const;

const MANIFEST_KEYS = [
  "schemaVersion",
  "description",
  "entrypoints",
  "runtimeFiles",
  "assets",
  "approvedDynamicImports",
  "approvedInjectedFallbacks",
  "approvedStaticImports",
  "forbiddenSourcePaths",
] as const;

const APPROVED_DYNAMIC_KEYS = [
  "file",
  "purpose",
  "kind",
  "resolvedTarget",
  "relativePathLiteral",
] as const;

const APPROVED_FALLBACK_KEYS = [
  "file",
  "enclosingFunction",
  "specifier",
  "skippedWhenBindingsPresent",
  "excludedFromArtifact",
] as const;

const APPROVED_STATIC_KEYS = ["file", "kind", "specifier", "names"] as const;

export type ApprovedDynamicImport = {
  file: string;
  purpose: "EXTENDED_VENDOR_EXCHANGE";
  kind: "import()";
  resolvedTarget: string;
  relativePathLiteral: string;
};

export type ApprovedInjectedFallback = {
  file: string;
  enclosingFunction: string;
  specifier: string;
  skippedWhenBindingsPresent: string[];
  excludedFromArtifact: true;
};

export type ApprovedStaticImport = {
  file: string;
  kind: "named-import";
  specifier: string;
  names: string[];
};

export type CanaryFileManifest = {
  schemaVersion: typeof CANARY_MANIFEST_SCHEMA;
  description: string;
  entrypoints: string[];
  runtimeFiles: string[];
  assets: string[];
  approvedDynamicImports: ApprovedDynamicImport[];
  approvedInjectedFallbacks: ApprovedInjectedFallback[];
  approvedStaticImports: ApprovedStaticImport[];
  forbiddenSourcePaths: string[];
  files: string[];
};

export type ContentManifestFile = {
  relativePath: string;
  fileType: "file";
  mode: string;
  sha256: string;
};

export type ContentManifest = {
  schemaVersion: typeof CONTENT_MANIFEST_SCHEMA;
  selfRelativePath: "content-manifest.json";
  files: ContentManifestFile[];
};

export function isScannedExecutable(rel: string): boolean {
  return SCANNED_EXECUTABLE_EXTENSIONS.some((ext) => rel.endsWith(ext));
}

export function isExecutablePath(rel: string): boolean {
  return [...EXECUTABLE_EXTENSIONS].some((ext) => rel.endsWith(ext));
}

export function assertCanonicalRelPath(rel: string, label: string): string {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new Error(`CANARY_PATH_INVALID:${label}:empty`);
  }
  if (rel.includes("\0") || rel.includes("\\") || rel.includes("\r") || rel.includes("\n")) {
    throw new Error(`CANARY_PATH_INVALID:${label}:${rel}`);
  }
  if (path.isAbsolute(rel) || rel.startsWith("/") || rel.startsWith("~") || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`CANARY_PATH_ABSOLUTE:${label}:${rel}`);
  }
  if (isEscapingPath(rel) || rel.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`CANARY_PATH_ESCAPE:${label}:${rel}`);
  }
  if (rel !== rel.split("/").join("/")) {
    throw new Error(`CANARY_PATH_INVALID:${label}:${rel}`);
  }
  return rel;
}

function assertExactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    const unknown = actual.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !actual.includes(key));
    if (unknown.length) throw new Error(`CANARY_MANIFEST_UNKNOWN_FIELD:${label}:${unknown.join(",")}`);
    throw new Error(`CANARY_MANIFEST_MISSING_FIELD:${label}:${missing.join(",")}`);
  }
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`CANARY_MANIFEST_FIELD_TYPE:${label}`);
  }
  return value;
}

function assertSortedUnique(paths: string[], label: string): void {
  const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paths.some((item, i) => item !== sorted[i])) {
    throw new Error(`CANARY_MANIFEST_UNSORTED:${label}`);
  }
  const seen = new Set<string>();
  for (const item of paths) {
    if (seen.has(item)) throw new Error(`CANARY_MANIFEST_DUPLICATE:${label}:${item}`);
    seen.add(item);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`CANARY_MANIFEST_FIELD_TYPE:${label}`);
  }
  return value as Record<string, unknown>;
}

function parseApprovedDynamic(raw: unknown, index: number): ApprovedDynamicImport {
  const row = asRecord(raw, `approvedDynamicImports[${index}]`);
  assertExactKeys(row, APPROVED_DYNAMIC_KEYS, `approvedDynamicImports[${index}]`);
  if (row.purpose !== "EXTENDED_VENDOR_EXCHANGE") {
    throw new Error(`CANARY_MANIFEST_FIELD_TYPE:approvedDynamicImports[${index}].purpose`);
  }
  if (row.kind !== "import()") {
    throw new Error(`CANARY_MANIFEST_FIELD_TYPE:approvedDynamicImports[${index}].kind`);
  }
  return {
    file: assertCanonicalRelPath(String(row.file), `approvedDynamicImports[${index}].file`),
    purpose: "EXTENDED_VENDOR_EXCHANGE",
    kind: "import()",
    resolvedTarget: assertCanonicalRelPath(
      String(row.resolvedTarget),
      `approvedDynamicImports[${index}].resolvedTarget`,
    ),
    relativePathLiteral: String(row.relativePathLiteral),
  };
}

function parseApprovedFallback(raw: unknown, index: number): ApprovedInjectedFallback {
  const row = asRecord(raw, `approvedInjectedFallbacks[${index}]`);
  assertExactKeys(row, APPROVED_FALLBACK_KEYS, `approvedInjectedFallbacks[${index}]`);
  if (row.excludedFromArtifact !== true) {
    throw new Error(`CANARY_MANIFEST_FIELD_TYPE:approvedInjectedFallbacks[${index}].excludedFromArtifact`);
  }
  const skipped = assertStringArray(
    row.skippedWhenBindingsPresent,
    `approvedInjectedFallbacks[${index}].skippedWhenBindingsPresent`,
  );
  if (skipped.length < 1 || skipped.some((name) => !/^[A-Za-z_][\w]*$/.test(name))) {
    throw new Error(`CANARY_MANIFEST_FIELD_TYPE:approvedInjectedFallbacks[${index}].skippedWhenBindingsPresent`);
  }
  return {
    file: assertCanonicalRelPath(String(row.file), `approvedInjectedFallbacks[${index}].file`),
    enclosingFunction: String(row.enclosingFunction),
    specifier: String(row.specifier),
    skippedWhenBindingsPresent: skipped,
    excludedFromArtifact: true,
  };
}

function parseApprovedStatic(raw: unknown, index: number): ApprovedStaticImport {
  const row = asRecord(raw, `approvedStaticImports[${index}]`);
  assertExactKeys(row, APPROVED_STATIC_KEYS, `approvedStaticImports[${index}]`);
  if (row.kind !== "named-import") {
    throw new Error(`CANARY_MANIFEST_FIELD_TYPE:approvedStaticImports[${index}].kind`);
  }
  const names = assertStringArray(row.names, `approvedStaticImports[${index}].names`);
  if (names.length < 1) throw new Error(`CANARY_MANIFEST_FIELD_TYPE:approvedStaticImports[${index}].names`);
  return {
    file: assertCanonicalRelPath(String(row.file), `approvedStaticImports[${index}].file`),
    kind: "named-import",
    specifier: String(row.specifier),
    names,
  };
}

export function parseCanaryManifestJson(raw: unknown): CanaryFileManifest {
  const obj = asRecord(raw, "root");
  assertExactKeys(obj, MANIFEST_KEYS, "root");
  if (obj.schemaVersion !== CANARY_MANIFEST_SCHEMA) {
    throw new Error("CANARY_MANIFEST_SCHEMA");
  }
  if (typeof obj.description !== "string" || obj.description.length < 1) {
    throw new Error("CANARY_MANIFEST_FIELD_TYPE:description");
  }
  const entrypoints = assertStringArray(obj.entrypoints, "entrypoints").map((rel) =>
    assertCanonicalRelPath(rel, "entrypoints"),
  );
  const runtimeFiles = assertStringArray(obj.runtimeFiles, "runtimeFiles").map((rel) =>
    assertCanonicalRelPath(rel, "runtimeFiles"),
  );
  const assets = assertStringArray(obj.assets, "assets").map((rel) => assertCanonicalRelPath(rel, "assets"));
  const forbiddenSourcePaths = assertStringArray(obj.forbiddenSourcePaths, "forbiddenSourcePaths").map((rel) =>
    assertCanonicalRelPath(rel, "forbiddenSourcePaths"),
  );
  assertSortedUnique(entrypoints, "entrypoints");
  assertSortedUnique(runtimeFiles, "runtimeFiles");
  assertSortedUnique(assets, "assets");
  assertSortedUnique(forbiddenSourcePaths, "forbiddenSourcePaths");
  if (!Array.isArray(obj.approvedDynamicImports)) throw new Error("CANARY_MANIFEST_FIELD_TYPE:approvedDynamicImports");
  if (!Array.isArray(obj.approvedInjectedFallbacks)) {
    throw new Error("CANARY_MANIFEST_FIELD_TYPE:approvedInjectedFallbacks");
  }
  if (!Array.isArray(obj.approvedStaticImports)) throw new Error("CANARY_MANIFEST_FIELD_TYPE:approvedStaticImports");
  const approvedDynamicImports = obj.approvedDynamicImports.map(parseApprovedDynamic);
  const approvedInjectedFallbacks = obj.approvedInjectedFallbacks.map(parseApprovedFallback);
  const approvedStaticImports = obj.approvedStaticImports.map(parseApprovedStatic);
  if (entrypoints.length !== 1 || entrypoints[0] !== "src/cli/run-extended-canary.ts") {
    throw new Error(`CANARY_MANIFEST_ENTRYPOINT:${entrypoints.join(",")}`);
  }
  if (!runtimeFiles.includes(entrypoints[0]!)) {
    throw new Error("CANARY_MANIFEST_ENTRYPOINT_UNLISTED");
  }
  const allListed = [...entrypoints, ...runtimeFiles, ...assets, ...forbiddenSourcePaths];
  const collisions = caseCollidingPaths(allListed);
  if (collisions.length) {
    throw new Error(`CANARY_MANIFEST_CASE_COLLISION:${collisions.map((g) => g.join("|")).join(";")}`);
  }
  const runtimeSet = new Set(runtimeFiles);
  const assetSet = new Set(assets);
  const forbiddenSet = new Set(forbiddenSourcePaths);
  for (const rel of runtimeFiles) {
    if (assetSet.has(rel) || forbiddenSet.has(rel)) throw new Error(`CANARY_MANIFEST_OVERLAP:${rel}`);
    if (isExecutablePath(rel) && !isScannedExecutable(rel)) {
      throw new Error(`CANARY_UNSCANNED_EXTENSION:${rel}`);
    }
  }
  for (const rel of assets) {
    if (runtimeSet.has(rel) || forbiddenSet.has(rel)) throw new Error(`CANARY_MANIFEST_OVERLAP:${rel}`);
    if (isExecutablePath(rel)) throw new Error(`CANARY_ASSET_EXECUTABLE:${rel}`);
  }
  for (const row of approvedDynamicImports) {
    if (!runtimeSet.has(row.file)) throw new Error(`CANARY_APPROVED_IMPORT_FILE:${row.file}`);
    if (!runtimeSet.has(row.resolvedTarget)) throw new Error(`CANARY_APPROVED_IMPORT_TARGET:${row.resolvedTarget}`);
    if (row.relativePathLiteral.includes("\\") || row.relativePathLiteral.includes("\0")) {
      throw new Error(`CANARY_APPROVED_IMPORT_LITERAL:${row.relativePathLiteral}`);
    }
  }
  for (const row of approvedInjectedFallbacks) {
    if (!runtimeSet.has(row.file)) throw new Error(`CANARY_APPROVED_FALLBACK_FILE:${row.file}`);
    if (row.enclosingFunction !== "bindLoopRuntime") {
      throw new Error(`CANARY_APPROVED_FALLBACK_FN:${row.enclosingFunction}`);
    }
  }
  const supplied = new Set(approvedInjectedFallbacks.flatMap((row) => row.skippedWhenBindingsPresent));
  for (const name of REQUIRED_ENTRYPOINT_BINDINGS) {
    if (!supplied.has(name)) throw new Error(`CANARY_MANIFEST_BINDING_MISSING:${name}`);
  }
  return {
    schemaVersion: CANARY_MANIFEST_SCHEMA,
    description: obj.description,
    entrypoints,
    runtimeFiles,
    assets,
    approvedDynamicImports,
    approvedInjectedFallbacks,
    approvedStaticImports,
    forbiddenSourcePaths,
    files: [...runtimeFiles, ...assets],
  };
}

export function gitIndexForRoot(root: string): Map<string, GitIndexEntry> | undefined {
  if (!fs.existsSync(path.join(root, ".git"))) return undefined;
  const listed = listGitIndex(root);
  if (!listed.ok) throw new Error(`CANARY_GIT_INDEX_UNREADABLE:${listed.detail}`);
  return listed.byPath;
}

export function assertExactCasePath(root: string, rel: string): void {
  const parts = rel.split("/");
  let dir = root;
  for (const part of parts) {
    if (!fs.existsSync(dir)) throw new Error(`CANARY_SOURCE_MISSING:${rel}`);
    const names = fs.readdirSync(dir);
    if (!names.includes(part)) throw new Error(`CANARY_PATH_CASE:${rel}`);
    dir = path.join(dir, part);
  }
}

export function assertTrackedRegularFile(
  root: string,
  rel: string,
  gitIndex: Map<string, GitIndexEntry> | undefined,
): string {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) throw new Error(`CANARY_SOURCE_MISSING:${rel}`);
  const lst = fs.lstatSync(full);
  if (lst.isSymbolicLink()) throw new Error(`CANARY_SYMLINK_SOURCE:${rel}`);
  if (!lst.isFile()) throw new Error(`CANARY_NON_REGULAR_SOURCE:${rel}`);
  const realRoot = fs.realpathSync(root);
  const realSrc = fs.realpathSync(full);
  const relReal = path.relative(realRoot, realSrc).replaceAll("\\", "/");
  if (relReal.startsWith("..") || path.isAbsolute(relReal) || relReal !== rel) {
    throw new Error(`CANARY_PATH_ESCAPE:${rel}`);
  }
  assertExactCasePath(root, rel);
  if (gitIndex) {
    const entry = gitIndex.get(rel);
    if (!entry) throw new Error(`CANARY_UNTRACKED_SOURCE:${rel}`);
    if (entry.mode === SYMLINK_MODE) throw new Error(`CANARY_SYMLINK_SOURCE:${rel}`);
    if (entry.mode === GITLINK_MODE) throw new Error(`CANARY_GITLINK_SOURCE:${rel}`);
    if (!REGULAR_FILE_MODES.has(entry.mode)) throw new Error(`CANARY_NON_REGULAR_SOURCE:${rel}:${entry.mode}`);
  }
  return realSrc;
}

export function assertManifestSourcesOnDisk(
  root: string,
  manifest: CanaryFileManifest,
  gitIndex = gitIndexForRoot(root),
): void {
  for (const rel of [...manifest.runtimeFiles, ...manifest.assets]) {
    assertTrackedRegularFile(root, rel, gitIndex);
  }
  for (const row of manifest.approvedDynamicImports) {
    assertTrackedRegularFile(root, row.resolvedTarget, gitIndex);
  }
}

export function parseCanaryManifestFile(root: string, relative = "packages/extended-canary/file-manifest.json"): CanaryFileManifest {
  const full = path.join(root, relative);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (err) {
    throw new Error(`CANARY_MANIFEST_MALFORMED:${String(err)}`);
  }
  const manifest = parseCanaryManifestJson(parsed);
  assertManifestSourcesOnDisk(root, manifest);
  return manifest;
}
