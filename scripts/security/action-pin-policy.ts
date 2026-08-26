import {
  GITLINK_MODE,
  REGULAR_FILE_MODES,
  SYMLINK_MODE,
  caseCollidingPaths,
  gitCatBlob,
  isActionManifestPath,
  isEscapingPath,
  isTrackedManifestPath,
  isWorkflowManifestPath,
  listGitIndex,
  type GitIndexEntry,
} from "./action-git-index.js";
import {
  isYamlMap,
  isYamlScalar,
  isYamlSeq,
  mapGet,
  mapHas,
  parseStrictYaml,
} from "./action-yaml.js";

export const ACTION_PIN_SCHEMA = "classic-v0.2-action-pin-inventory/3";

export const APPROVED_EXTERNAL_ACTIONS = [
  {
    identity: "actions/checkout",
    sha: "11d5960a326750d5838078e36cf38b85af677262",
    release: "v4.4.0",
  },
  {
    identity: "actions/setup-node",
    sha: "49933ea5288caeca8642d1e84afbd3f7d6820020",
    release: "v4.4.0",
  },
  {
    identity: "actions/upload-artifact",
    sha: "ea165f8d65b6e75b540449e92b4886f43607fa02",
    release: "v4.6.2",
  },
] as const;

export const APPROVED_REUSABLE_WORKFLOWS: ReadonlyArray<{
  repository: string;
  path: string;
  sha: string;
}> = [];

export const APPROVED_DOCKER_ACTIONS: ReadonlyArray<{
  image: string;
  digest: string;
}> = [];

const ALLOWED_TUPLE = new Set(
  APPROVED_EXTERNAL_ACTIONS.map((row) => `${row.identity}@${row.sha}`),
);

export type ActionPolicyCode =
  | "PASS"
  | "ACTION_USES_UNPARSABLE"
  | "ACTION_USES_DYNAMIC"
  | "ACTION_REF_NOT_IMMUTABLE"
  | "ACTION_NOT_ALLOWLISTED"
  | "ACTION_IDENTITY_NON_CANONICAL"
  | "ACTION_LOCAL_PATH_UNSAFE"
  | "ACTION_LOCAL_UNTRACKED"
  | "ACTION_LOCAL_NOT_COMPOSITE"
  | "ACTION_LOCAL_MANIFEST_INVALID"
  | "ACTION_LOCAL_DUPLICATE_MANIFEST"
  | "ACTION_LOCAL_CYCLE"
  | "ACTION_DOCKER_FORBIDDEN"
  | "ACTION_DOCKER_DIGEST_MISSING"
  | "ACTION_REUSABLE_REMOTE_FORBIDDEN"
  | "ACTION_SYMLINK_FORBIDDEN"
  | "ACTION_GITLINK_FORBIDDEN"
  | "ACTION_NON_REGULAR_BLOB"
  | "ACTION_PATH_CASE_COLLISION"
  | "ACTION_PATH_ESCAPE"
  | "ACTION_GIT_INDEX_UNREADABLE"
  | "ACTION_YAML_MALFORMED"
  | "ACTION_YAML_DUPLICATE_KEY"
  | "ACTION_YAML_ALIAS"
  | "ACTION_YAML_UNSUPPORTED_TAG"
  | "CHECKOUT_PERSIST_CREDENTIALS_UNSAFE"
  | "CHECKOUT_FETCH_DEPTH_UNSAFE"
  | "CHECKOUT_OCCURRENCE_INVALID"
  | "SETUP_NODE_OCCURRENCE_INVALID"
  | "UPLOAD_ARTIFACT_OCCURRENCE_INVALID"
  | "WORKFLOW_PULL_REQUEST_TARGET"
  | "WORKFLOW_PERMISSIONS_UNSAFE"
  | "WORKFLOW_SECRETS_FORBIDDEN";

export type ActionKind =
  | "external"
  | "local"
  | "docker"
  | "reusable-local"
  | "reusable-remote"
  | "unparsed";

export type ActionUseOccurrence = {
  index: number;
  file: string;
  line: number | null;
  raw: string;
  kind: ActionKind;
  identity: string;
  ref: string | null;
  immutablePin: boolean;
  allowlisted: boolean;
  checkoutPersistCredentials: boolean | null;
  checkoutFetchDepth: number | null;
  source: "step" | "job";
  codes: ActionPolicyCode[];
};

export type ActionGraphEdge = {
  from: string;
  to: string;
  kind: "local-action" | "reusable-workflow";
};

export type ActionPinInventory = {
  schemaVersion: typeof ACTION_PIN_SCHEMA;
  overallPolicyOk: boolean;
  codes: ActionPolicyCode[];
  actionUsesTotal: number;
  checkoutOccurrenceCount: number;
  setupNodeOccurrenceCount: number;
  uploadArtifactOccurrenceCount: number;
  unpinnedExternalActions: number;
  unsafeCheckouts: number;
  dockerActionCount: number;
  trackedManifests: string[];
  scannedFiles: string[];
  allowlist: typeof APPROVED_EXTERNAL_ACTIONS;
  graph: {
    nodes: string[];
    edges: ActionGraphEdge[];
    cycles: string[][];
  };
  occurrences: ActionUseOccurrence[];
};

const IMMUTABLE_SHA = /^[0-9a-f]{40}$/;
const EXTERNAL_USES = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)((?:\/[A-Za-z0-9._-]+)*)@(.+)$/;
const REMOTE_REUSABLE = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/(\.github\/workflows\/.+\.(?:yml|yaml))@(.+)$/;
const LOCAL_PART = /^[A-Za-z0-9._-]+$/;
const SECRET_EXPR = /\$\{\{\s*secrets\./i;
const DYNAMIC_EXPR = /\$\{\{/;

function uniqueCodes(codes: ActionPolicyCode[]): ActionPolicyCode[] {
  return [...new Set(codes)];
}

function isCheckoutIdentity(identity: string): boolean {
  return identity === "actions/checkout" || identity.startsWith("actions/checkout/");
}

function approvedTuple(identity: string, sha: string): boolean {
  return ALLOWED_TUPLE.has(`${identity}@${sha}`);
}

export function resolveLocalUsesPath(raw: string): { ok: true; posix: string } | { ok: false } {
  if (!raw.startsWith("./")) return { ok: false };
  if (raw.includes("\\") || raw.includes("\0") || raw.includes("//")) return { ok: false };
  const parts = raw.slice(2).split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return { ok: false };
  if (parts.some((part) => part === "." || part === ".." || !LOCAL_PART.test(part))) return { ok: false };
  return { ok: true, posix: parts.join("/") };
}

function classifyUses(raw: string, source: "step" | "job"): {
  kind: ActionKind;
  identity: string;
  ref: string | null;
  immutablePin: boolean;
  allowlisted: boolean;
  localPosix: string | null;
  codes: ActionPolicyCode[];
} {
  if (DYNAMIC_EXPR.test(raw)) {
    return {
      kind: "unparsed",
      identity: raw,
      ref: null,
      immutablePin: false,
      allowlisted: false,
      localPosix: null,
      codes: ["ACTION_USES_DYNAMIC"],
    };
  }

  if (raw.startsWith("docker://")) {
    return {
      kind: "docker",
      identity: raw,
      ref: null,
      immutablePin: false,
      allowlisted: false,
      localPosix: null,
      codes: ["ACTION_DOCKER_FORBIDDEN"],
    };
  }

  if (raw.startsWith("./") || raw.startsWith("/") || raw.startsWith("~") || raw.startsWith("../")) {
    const resolved = resolveLocalUsesPath(raw);
    if (!resolved.ok) {
      return {
        kind: source === "job" ? "reusable-local" : "local",
        identity: raw,
        ref: null,
        immutablePin: false,
        allowlisted: false,
        localPosix: null,
        codes: ["ACTION_LOCAL_PATH_UNSAFE"],
      };
    }
    const kind = source === "job" ? "reusable-local" : "local";
    return {
      kind,
      identity: raw,
      ref: null,
      immutablePin: false,
      allowlisted: false,
      localPosix: resolved.posix,
      codes: [],
    };
  }

  if (source === "job") {
    const reusable = raw.match(REMOTE_REUSABLE);
    if (reusable) {
      const repository = reusable[1]!;
      const workflowPath = reusable[2]!;
      const ref = reusable[3]!;
      const allowlisted = APPROVED_REUSABLE_WORKFLOWS.some((row) => (
        row.repository === repository && row.path === workflowPath && row.sha === ref
      ));
      return {
        kind: "reusable-remote",
        identity: `${repository}/${workflowPath}`,
        ref,
        immutablePin: IMMUTABLE_SHA.test(ref),
        allowlisted,
        localPosix: null,
        codes: allowlisted ? [] : ["ACTION_REUSABLE_REMOTE_FORBIDDEN"],
      };
    }
  }

  const external = raw.match(EXTERNAL_USES);
  if (!external) {
    return {
      kind: "unparsed",
      identity: raw,
      ref: null,
      immutablePin: false,
      allowlisted: false,
      localPosix: null,
      codes: ["ACTION_USES_UNPARSABLE"],
    };
  }

  const owner = external[1]!;
  const repo = external[2]!;
  const subpath = external[3] ?? "";
  const ref = external[4]!;
  const identity = `${owner}/${repo}${subpath}`;
  const codes: ActionPolicyCode[] = [];
  if (identity !== identity.toLowerCase() || identity !== identity.normalize("NFC") || /[^\x00-\x7F]/.test(identity)) {
    codes.push("ACTION_IDENTITY_NON_CANONICAL");
  }
  const immutablePin = IMMUTABLE_SHA.test(ref);
  if (!immutablePin) codes.push("ACTION_REF_NOT_IMMUTABLE");
  const allowlisted = subpath === "" && approvedTuple(`${owner}/${repo}`, ref);
  if (!allowlisted) codes.push("ACTION_NOT_ALLOWLISTED");
  return {
    kind: "external",
    identity,
    ref,
    immutablePin,
    allowlisted,
    localPosix: null,
    codes,
  };
}

function scalarLine(
  node: { range?: [number, number, number] | null },
  lineOf: (node: { range?: [number, number, number] | null }) => number | null,
): number | null {
  return lineOf(node);
}

function usesScalar(node: unknown): { ok: true; value: string; type?: string; node: { range?: [number, number, number] | null } } | { ok: false } {
  if (!isYamlScalar(node) || typeof node.value !== "string" || node.value.length === 0) return { ok: false };
  if (node.type === "BLOCK_FOLDED" || node.type === "BLOCK_LITERAL") return { ok: false };
  return { ok: true, value: node.value, type: node.type, node };
}

function readCheckoutWith(withNode: unknown): {
  persistCredentials: boolean | null;
  fetchDepth: number | null;
  unparseable: boolean;
} {
  if (withNode === undefined || withNode === null) {
    return { persistCredentials: null, fetchDepth: null, unparseable: false };
  }
  if (!isYamlMap(withNode)) {
    return { persistCredentials: null, fetchDepth: null, unparseable: true };
  }
  let persistCredentials: boolean | null = null;
  let fetchDepth: number | null = null;
  let unparseable = false;
  if (mapHas(withNode, "persist-credentials")) {
    const value = mapGet(withNode, "persist-credentials");
    if (!isYamlScalar(value) || DYNAMIC_EXPR.test(String(value.value ?? ""))) unparseable = true;
    else if (value.value === false) persistCredentials = false;
    else if (value.value === true) persistCredentials = true;
    else unparseable = true;
  }
  if (mapHas(withNode, "fetch-depth")) {
    const value = mapGet(withNode, "fetch-depth");
    if (!isYamlScalar(value) || DYNAMIC_EXPR.test(String(value.value ?? ""))) unparseable = true;
    else if (value.value === 0 || value.value === "0") fetchDepth = 0;
    else if (typeof value.value === "number" && Number.isInteger(value.value)) fetchDepth = value.value;
    else if (typeof value.value === "string" && /^[0-9]+$/.test(value.value)) fetchDepth = Number(value.value);
    else unparseable = true;
  }
  return { persistCredentials, fetchDepth, unparseable };
}

function containsPullRequestTarget(node: unknown): boolean {
  if (isYamlScalar(node)) return node.value === "pull_request_target";
  if (isYamlSeq(node)) return node.items.some((item) => containsPullRequestTarget(item));
  if (isYamlMap(node)) {
    return node.items.some((pair) => {
      if (!isYamlScalar(pair.key)) return true;
      return pair.key.value === "pull_request_target";
    });
  }
  return node != null;
}

function permissionsUnsafe(node: unknown, requiredContentsRead: boolean): boolean {
  if (node === undefined || node === null) return requiredContentsRead;
  if (isYamlScalar(node)) return node.value !== "read-all";
  if (!isYamlMap(node)) return true;
  let sawContentsRead = false;
  for (const pair of node.items) {
    if (!isYamlScalar(pair.key) || typeof pair.key.value !== "string") return true;
    if (!isYamlScalar(pair.value)) return true;
    const value = pair.value.value;
    if (value === "write" || value === "write-all") return true;
    if (pair.key.value === "contents") {
      if (value !== "read") return true;
      sawContentsRead = true;
    }
  }
  return requiredContentsRead && !sawContentsRead;
}

function walkSecrets(node: unknown, onHit: () => void): void {
  if (isYamlScalar(node)) {
    if (typeof node.value === "string" && SECRET_EXPR.test(node.value)) onHit();
    return;
  }
  if (isYamlSeq(node)) {
    for (const item of node.items) walkSecrets(item, onHit);
    return;
  }
  if (isYamlMap(node)) {
    for (const pair of node.items) {
      walkSecrets(pair.key, onHit);
      walkSecrets(pair.value, onHit);
    }
  }
}

type ScanCtx = {
  root: string | null;
  index: Map<string, GitIndexEntry> | null;
  blobCache: Map<string, string>;
  stack: string[];
  occurrences: ActionUseOccurrence[];
  fileCodes: ActionPolicyCode[];
  edges: ActionGraphEdge[];
  cycles: string[][];
  scanned: Set<string>;
};

function blobText(ctx: ScanCtx, entry: GitIndexEntry): string | null {
  const cached = ctx.blobCache.get(entry.object);
  if (cached !== undefined) return cached;
  if (!ctx.root) return null;
  const loaded = gitCatBlob(ctx.root, entry.object);
  if (!loaded.ok) return null;
  ctx.blobCache.set(entry.object, loaded.text);
  return loaded.text;
}

function entryModeCodes(entry: GitIndexEntry): ActionPolicyCode[] {
  if (entry.mode === SYMLINK_MODE) return ["ACTION_SYMLINK_FORBIDDEN"];
  if (entry.mode === GITLINK_MODE) return ["ACTION_GITLINK_FORBIDDEN"];
  if (!REGULAR_FILE_MODES.has(entry.mode)) return ["ACTION_NON_REGULAR_BLOB"];
  return [];
}

function pushOccurrence(ctx: ScanCtx, row: Omit<ActionUseOccurrence, "index">): ActionUseOccurrence {
  const occurrence: ActionUseOccurrence = { ...row, index: ctx.occurrences.length, codes: uniqueCodes(row.codes) };
  ctx.occurrences.push(occurrence);
  return occurrence;
}

function scanUsesNode(
  ctx: ScanCtx,
  file: string,
  source: "step" | "job",
  usesNode: unknown,
  withNode: unknown,
  lineOf: (node: { range?: [number, number, number] | null }) => number | null,
): void {
  const scalar = usesScalar(usesNode);
  if (!scalar.ok) {
    pushOccurrence(ctx, {
      file,
      line: usesNode && typeof usesNode === "object" ? scalarLine(usesNode as { range?: [number, number, number] | null }, lineOf) : null,
      raw: "",
      kind: "unparsed",
      identity: "",
      ref: null,
      immutablePin: false,
      allowlisted: false,
      checkoutPersistCredentials: null,
      checkoutFetchDepth: null,
      source,
      codes: ["ACTION_USES_UNPARSABLE"],
    });
    return;
  }
  const classified = classifyUses(scalar.value, source);
  const withBlock = readCheckoutWith(withNode);
  const codes = [...classified.codes];
  let checkoutPersistCredentials: boolean | null = null;
  let checkoutFetchDepth: number | null = null;
  if (withBlock.unparseable) codes.push("ACTION_USES_UNPARSABLE");
  if (classified.kind === "external" && isCheckoutIdentity(classified.identity)) {
    checkoutPersistCredentials = withBlock.persistCredentials === false ? false : true;
    checkoutFetchDepth = withBlock.fetchDepth;
    if (withBlock.persistCredentials !== false) codes.push("CHECKOUT_PERSIST_CREDENTIALS_UNSAFE");
    if (withBlock.fetchDepth !== 0) codes.push("CHECKOUT_FETCH_DEPTH_UNSAFE");
  }
  pushOccurrence(ctx, {
    file,
    line: scalarLine(scalar.node, lineOf),
    raw: scalar.value,
    kind: classified.kind,
    identity: classified.identity,
    ref: classified.ref,
    immutablePin: classified.immutablePin,
    allowlisted: classified.allowlisted,
    checkoutPersistCredentials,
    checkoutFetchDepth,
    source,
    codes,
  });

  if (classified.localPosix && codes.every((code) => code !== "ACTION_LOCAL_PATH_UNSAFE" && code !== "ACTION_USES_DYNAMIC")) {
    if (classified.kind === "local") {
      ctx.edges.push({ from: file, to: classified.localPosix, kind: "local-action" });
      expandLocalAction(ctx, file, classified.localPosix);
    } else if (classified.kind === "reusable-local") {
      ctx.edges.push({ from: file, to: classified.localPosix, kind: "reusable-workflow" });
      expandLocalWorkflow(ctx, file, classified.localPosix);
    }
  }
}

function walkSteps(
  ctx: ScanCtx,
  file: string,
  stepsNode: unknown,
  lineOf: (node: { range?: [number, number, number] | null }) => number | null,
): void {
  if (!isYamlSeq(stepsNode)) {
    ctx.fileCodes.push("ACTION_USES_UNPARSABLE");
    return;
  }
  for (const item of stepsNode.items) {
    if (!isYamlMap(item)) {
      ctx.fileCodes.push("ACTION_USES_UNPARSABLE");
      continue;
    }
    if (mapHas(item, "uses")) {
      scanUsesNode(ctx, file, "step", mapGet(item, "uses"), mapGet(item, "with"), lineOf);
    }
  }
}

function scanWorkflowDocument(
  ctx: ScanCtx,
  file: string,
  source: string,
): void {
  ctx.scanned.add(file);
  const parsed = parseStrictYaml(source);
  if (!parsed.ok) {
    ctx.fileCodes.push(...parsed.codes);
    return;
  }
  const root = parsed.doc.contents;
  if (!isYamlMap(root)) {
    ctx.fileCodes.push("ACTION_YAML_MALFORMED");
    return;
  }
  if (mapHas(root, "on") && containsPullRequestTarget(mapGet(root, "on"))) {
    ctx.fileCodes.push("WORKFLOW_PULL_REQUEST_TARGET");
  }
  if (permissionsUnsafe(mapHas(root, "permissions") ? mapGet(root, "permissions") : undefined, true)) {
    ctx.fileCodes.push("WORKFLOW_PERMISSIONS_UNSAFE");
  }
  walkSecrets(root, () => ctx.fileCodes.push("WORKFLOW_SECRETS_FORBIDDEN"));
  if (!mapHas(root, "jobs")) {
    ctx.fileCodes.push("ACTION_USES_UNPARSABLE");
    return;
  }
  const jobs = mapGet(root, "jobs");
  if (!isYamlMap(jobs)) {
    ctx.fileCodes.push("ACTION_USES_UNPARSABLE");
    return;
  }
  for (const pair of jobs.items) {
    const job = pair.value;
    if (!isYamlMap(job)) {
      ctx.fileCodes.push("ACTION_USES_UNPARSABLE");
      continue;
    }
    if (mapHas(job, "permissions") && permissionsUnsafe(mapGet(job, "permissions"), false)) {
      ctx.fileCodes.push("WORKFLOW_PERMISSIONS_UNSAFE");
    }
    const hasUses = mapHas(job, "uses");
    const hasSteps = mapHas(job, "steps");
    if (hasUses && hasSteps) ctx.fileCodes.push("ACTION_USES_UNPARSABLE");
    if (hasUses) scanUsesNode(ctx, file, "job", mapGet(job, "uses"), mapGet(job, "with"), parsed.lineOf);
    if (hasSteps) walkSteps(ctx, file, mapGet(job, "steps"), parsed.lineOf);
  }
}

function scanCompositeDocument(
  ctx: ScanCtx,
  file: string,
  source: string,
): void {
  ctx.scanned.add(file);
  const parsed = parseStrictYaml(source);
  if (!parsed.ok) {
    ctx.fileCodes.push(...parsed.codes);
    return;
  }
  const root = parsed.doc.contents;
  if (!isYamlMap(root)) {
    ctx.fileCodes.push("ACTION_LOCAL_MANIFEST_INVALID");
    return;
  }
  walkSecrets(root, () => ctx.fileCodes.push("WORKFLOW_SECRETS_FORBIDDEN"));
  const runs = mapHas(root, "runs") ? mapGet(root, "runs") : undefined;
  if (!isYamlMap(runs)) {
    ctx.fileCodes.push("ACTION_LOCAL_NOT_COMPOSITE");
    return;
  }
  const using = mapGet(runs, "using");
  if (!isYamlScalar(using) || using.value !== "composite") {
    ctx.fileCodes.push("ACTION_LOCAL_NOT_COMPOSITE");
    return;
  }
  if (!mapHas(runs, "steps")) {
    ctx.fileCodes.push("ACTION_LOCAL_MANIFEST_INVALID");
    return;
  }
  walkSteps(ctx, file, mapGet(runs, "steps"), parsed.lineOf);
}

function cycleCodes(ctx: ScanCtx, posix: string): boolean {
  const idx = ctx.stack.indexOf(posix);
  if (idx < 0) return false;
  ctx.cycles.push([...ctx.stack.slice(idx), posix]);
  ctx.fileCodes.push("ACTION_LOCAL_CYCLE");
  return true;
}

function expandLocalAction(ctx: ScanCtx, _fromFile: string, posix: string): void {
  if (!ctx.index) {
    ctx.fileCodes.push("ACTION_LOCAL_UNTRACKED");
    return;
  }
  if (cycleCodes(ctx, posix)) return;
  const yml = `${posix}/action.yml`;
  const yaml = `${posix}/action.yaml`;
  const ymlEntry = ctx.index.get(yml);
  const yamlEntry = ctx.index.get(yaml);
  if (ymlEntry && yamlEntry) {
    ctx.fileCodes.push("ACTION_LOCAL_DUPLICATE_MANIFEST");
    return;
  }
  const entry = ymlEntry ?? yamlEntry;
  if (!entry) {
    ctx.fileCodes.push("ACTION_LOCAL_UNTRACKED");
    return;
  }
  const modeCodes = entryModeCodes(entry);
  if (modeCodes.length > 0) {
    ctx.fileCodes.push(...modeCodes);
    ctx.scanned.add(entry.path);
    return;
  }
  const text = blobText(ctx, entry);
  if (text === null) {
    ctx.fileCodes.push("ACTION_LOCAL_UNTRACKED");
    return;
  }
  ctx.stack.push(posix);
  scanCompositeDocument(ctx, entry.path, text);
  ctx.stack.pop();
}

function expandLocalWorkflow(ctx: ScanCtx, _fromFile: string, posix: string): void {
  if (!ctx.index) {
    ctx.fileCodes.push("ACTION_LOCAL_UNTRACKED");
    return;
  }
  if (!isWorkflowManifestPath(posix)) {
    ctx.fileCodes.push("ACTION_LOCAL_PATH_UNSAFE");
    return;
  }
  if (cycleCodes(ctx, posix)) return;
  const entry = ctx.index.get(posix);
  if (!entry) {
    ctx.fileCodes.push("ACTION_LOCAL_UNTRACKED");
    return;
  }
  const modeCodes = entryModeCodes(entry);
  if (modeCodes.length > 0) {
    ctx.fileCodes.push(...modeCodes);
    ctx.scanned.add(entry.path);
    return;
  }
  const text = blobText(ctx, entry);
  if (text === null) {
    ctx.fileCodes.push("ACTION_LOCAL_UNTRACKED");
    return;
  }
  ctx.stack.push(posix);
  scanWorkflowDocument(ctx, posix, text);
  ctx.stack.pop();
}

function finishInventory(ctx: ScanCtx, extra: {
  trackedManifests: string[];
  requireCanonicalActionCounts: boolean;
  requireProductionPins: boolean;
}): ActionPinInventory {
  const checkoutOccurrenceCount = ctx.occurrences.filter((row) => row.identity === "actions/checkout").length;
  const setupNodeOccurrenceCount = ctx.occurrences.filter((row) => row.identity === "actions/setup-node").length;
  const uploadArtifactOccurrenceCount = ctx.occurrences.filter((row) => row.identity === "actions/upload-artifact").length;
  if (extra.requireCanonicalActionCounts || extra.requireProductionPins) {
    if (checkoutOccurrenceCount !== 1) ctx.fileCodes.push("CHECKOUT_OCCURRENCE_INVALID");
    if (setupNodeOccurrenceCount !== 1) ctx.fileCodes.push("SETUP_NODE_OCCURRENCE_INVALID");
    if (uploadArtifactOccurrenceCount < 1) ctx.fileCodes.push("UPLOAD_ARTIFACT_OCCURRENCE_INVALID");
  }
  const codes = uniqueCodes([
    ...ctx.fileCodes,
    ...ctx.occurrences.flatMap((row) => row.codes),
  ]);
  const overallPolicyOk = codes.length === 0;
  const graphNodes = [...new Set([
    ...extra.trackedManifests,
    ...ctx.scanned,
    ...ctx.edges.flatMap((edge) => [edge.from, edge.to]),
  ])].sort();
  return {
    schemaVersion: ACTION_PIN_SCHEMA,
    overallPolicyOk,
    codes: overallPolicyOk ? ["PASS"] : codes,
    actionUsesTotal: ctx.occurrences.length,
    checkoutOccurrenceCount,
    setupNodeOccurrenceCount,
    uploadArtifactOccurrenceCount,
    unpinnedExternalActions: ctx.occurrences.filter((row) => row.kind === "external" && !row.immutablePin).length,
    unsafeCheckouts: ctx.occurrences.filter((row) => (
      row.identity === "actions/checkout"
      && (row.checkoutPersistCredentials !== false || row.checkoutFetchDepth !== 0)
    )).length,
    dockerActionCount: ctx.occurrences.filter((row) => row.kind === "docker").length,
    trackedManifests: [...extra.trackedManifests].sort(),
    scannedFiles: [...ctx.scanned].sort(),
    allowlist: APPROVED_EXTERNAL_ACTIONS,
    graph: {
      nodes: graphNodes,
      edges: ctx.edges,
      cycles: ctx.cycles,
    },
    occurrences: ctx.occurrences,
  };
}

function emptyCtx(): ScanCtx {
  return {
    root: null,
    index: null,
    blobCache: new Map(),
    stack: [],
    occurrences: [],
    fileCodes: [],
    edges: [],
    cycles: [],
    scanned: new Set(),
  };
}

export function evaluateWorkflowActions(
  workflowText: string,
  options: { requireCanonicalActionCounts?: boolean; file?: string } = {},
): ActionPinInventory {
  const file = options.file ?? ".github/workflows/memory.yml";
  const ctx = emptyCtx();
  scanWorkflowDocument(ctx, file, workflowText);
  return finishInventory(ctx, {
    trackedManifests: [file],
    requireCanonicalActionCounts: options.requireCanonicalActionCounts === true,
    requireProductionPins: false,
  });
}

export function parseActionPins(workflowText: string): ActionPinInventory {
  return evaluateWorkflowActions(workflowText, { requireCanonicalActionCounts: true });
}

function inspectTrackedManifest(ctx: ScanCtx, entry: GitIndexEntry): void {
  ctx.scanned.add(entry.path);
  if (isEscapingPath(entry.path)) {
    ctx.fileCodes.push("ACTION_PATH_ESCAPE");
    return;
  }
  const modeCodes = entryModeCodes(entry);
  if (modeCodes.length > 0) {
    ctx.fileCodes.push(...modeCodes);
    return;
  }
  const text = blobText(ctx, entry);
  if (text === null) {
    ctx.fileCodes.push("ACTION_GIT_INDEX_UNREADABLE");
    return;
  }
  if (isWorkflowManifestPath(entry.path)) scanWorkflowDocument(ctx, entry.path, text);
  else scanCompositeDocument(ctx, entry.path, text);
}

export function inventoryGitRepository(root: string, options: {
  requireProductionPins?: boolean;
} = {}): ActionPinInventory {
  const ctx = emptyCtx();
  ctx.root = root;
  const listed = listGitIndex(root);
  if (!listed.ok) {
    ctx.fileCodes.push(listed.code);
    return finishInventory(ctx, {
      trackedManifests: [],
      requireCanonicalActionCounts: false,
      requireProductionPins: options.requireProductionPins === true,
    });
  }
  ctx.index = listed.byPath;
  const tracked = listed.entries
    .filter((entry) => isTrackedManifestPath(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const trackedPaths = tracked.map((entry) => entry.path);
  for (const posixPath of listed.entries.map((entry) => entry.path)) {
    if (isEscapingPath(posixPath) && isTrackedManifestPath(posixPath)) {
      ctx.fileCodes.push("ACTION_PATH_ESCAPE");
    }
  }
  const collisions = caseCollidingPaths(listed.entries.map((entry) => entry.path));
  if (collisions.some((group) => group.some((posixPath) => isTrackedManifestPath(posixPath)))) {
    ctx.fileCodes.push("ACTION_PATH_CASE_COLLISION");
  }
  for (const entry of tracked) inspectTrackedManifest(ctx, entry);
  return finishInventory(ctx, {
    trackedManifests: trackedPaths,
    requireCanonicalActionCounts: false,
    requireProductionPins: options.requireProductionPins === true,
  });
}
