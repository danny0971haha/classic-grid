export const ACTION_PIN_SCHEMA = "classic-v0.2-action-pin-inventory/2";

export const ALLOWED_EXTERNAL_ACTIONS = [
  "actions/checkout",
  "actions/setup-node",
  "actions/upload-artifact",
] as const;

const ALLOWED_EXTERNAL = new Set<string>(ALLOWED_EXTERNAL_ACTIONS);

export type ActionPolicyCode =
  | "PASS"
  | "ACTION_USES_UNPARSABLE"
  | "ACTION_REF_NOT_IMMUTABLE"
  | "ACTION_NOT_ALLOWLISTED"
  | "ACTION_LOCAL_PATH_UNSAFE"
  | "ACTION_DOCKER_DIGEST_MISSING"
  | "CHECKOUT_PERSIST_CREDENTIALS_UNSAFE"
  | "CHECKOUT_FETCH_DEPTH_UNSAFE"
  | "CHECKOUT_OCCURRENCE_INVALID"
  | "SETUP_NODE_OCCURRENCE_INVALID"
  | "UPLOAD_ARTIFACT_OCCURRENCE_INVALID";

export type ActionKind = "external" | "local" | "docker" | "unparsed";

export type ActionUseOccurrence = {
  index: number;
  line: number;
  raw: string;
  kind: ActionKind;
  identity: string;
  ref: string | null;
  immutablePin: boolean;
  allowlisted: boolean;
  checkoutPersistCredentials: boolean | null;
  checkoutFetchDepth: number | null;
  codes: ActionPolicyCode[];
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
  occurrences: ActionUseOccurrence[];
};

const IMMUTABLE_SHA = /^[0-9a-f]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/([^@]+)@sha256:([0-9a-f]{64})$/;
const EXTERNAL_USES = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)((?:\/[A-Za-z0-9._-]+)*)@(.+)$/;
const USES_KEY = /^(\s*)(- )?("uses"|'uses'|uses)\s*:\s*(.*)$/;
const BLOCK_SCALAR = /:\s*[>|][+-]?\s*$/;
const FLOW_USES = /^\s*-?\s*\{[^}]*\buses\s*:/;
const WITH_KEY = /^(\s*)("with"|'with'|with)\s*:\s*(.*)$/;
const MAPPING_ENTRY = /^(\s*)("[\w.-]+"|'[\w.-]+'|[\w.-]+)\s*:\s*(.*)$/;

function uniqueCodes(codes: ActionPolicyCode[]): ActionPolicyCode[] {
  return [...new Set(codes)];
}

function leadingIndent(line: string): number | "tab" {
  let count = 0;
  for (const ch of line) {
    if (ch === " ") count += 1;
    else if (ch === "\t") return "tab";
    else break;
  }
  return count;
}

function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function unquote(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && first === last && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  if (first === '"' || first === "'") return null;
  return trimmed;
}

function parseScalar(value: string): string {
  const unquoted = unquote(value);
  return unquoted ?? value.trim();
}

function isSafeLocalAction(value: string): boolean {
  if (!value.startsWith("./")) return false;
  if (value.includes("\\") || value.includes("\0") || value.includes("//")) return false;
  const parts = value.slice(2).split("/");
  if (parts.length === 0) return false;
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part));
}

function classifyUses(raw: string): {
  kind: ActionKind;
  identity: string;
  ref: string | null;
  immutablePin: boolean;
  allowlisted: boolean;
  codes: ActionPolicyCode[];
} {
  if (raw.startsWith("./") || raw.startsWith("/") || raw.startsWith("~") || raw.startsWith("../")) {
    const safe = isSafeLocalAction(raw);
    return {
      kind: "local",
      identity: raw,
      ref: null,
      immutablePin: safe,
      allowlisted: safe,
      codes: safe ? [] : ["ACTION_LOCAL_PATH_UNSAFE"],
    };
  }

  if (raw.startsWith("docker://")) {
    const match = raw.match(DOCKER_DIGEST);
    if (!match || match[1]!.includes("@")) {
      return {
        kind: "docker",
        identity: raw,
        ref: null,
        immutablePin: false,
        allowlisted: false,
        codes: ["ACTION_DOCKER_DIGEST_MISSING"],
      };
    }
    return {
      kind: "docker",
      identity: match[1]!,
      ref: `sha256:${match[2]}`,
      immutablePin: true,
      allowlisted: true,
      codes: [],
    };
  }

  const external = raw.match(EXTERNAL_USES);
  if (!external) {
    return {
      kind: "unparsed",
      identity: raw,
      ref: null,
      immutablePin: false,
      allowlisted: false,
      codes: ["ACTION_USES_UNPARSABLE"],
    };
  }

  const owner = external[1]!;
  const repo = external[2]!;
  const subpath = external[3] ?? "";
  const ref = external[4]!;
  const identity = `${owner}/${repo}${subpath}`;
  const allowlisted = subpath === "" && ALLOWED_EXTERNAL.has(`${owner}/${repo}`);
  const immutablePin = IMMUTABLE_SHA.test(ref);
  const codes: ActionPolicyCode[] = [];
  if (!immutablePin) codes.push("ACTION_REF_NOT_IMMUTABLE");
  if (!allowlisted) codes.push("ACTION_NOT_ALLOWLISTED");
  return {
    kind: "external",
    identity,
    ref,
    immutablePin,
    allowlisted,
    codes,
  };
}

function parseWithMapping(
  lines: string[],
  start: number,
  usesKeyIndent: number,
): { persistCredentials: boolean | null; fetchDepth: number | null; unparseable: boolean; next: number } {
  let persistCredentials: boolean | null = null;
  let fetchDepth: number | null = null;
  let unparseable = false;
  let i = start;
  let inScalarIndent: number | null = null;
  let withIndent: number | null = null;

  while (i < lines.length) {
    const original = lines[i]!.replace(/\r$/, "");
    const indent = leadingIndent(original);
    if (indent === "tab") {
      return { persistCredentials, fetchDepth, unparseable: true, next: i };
    }
    const stripped = stripInlineComment(original);
    if (stripped.trim().length === 0) {
      i += 1;
      continue;
    }
    if (inScalarIndent !== null) {
      if (indent > inScalarIndent) {
        i += 1;
        continue;
      }
      inScalarIndent = null;
    }
    if (indent < usesKeyIndent) break;
    if (withIndent === null) {
      if (indent !== usesKeyIndent) {
        i += 1;
        continue;
      }
      const withMatch = stripped.match(WITH_KEY);
      if (!withMatch) {
        if (BLOCK_SCALAR.test(stripped)) inScalarIndent = indent;
        i += 1;
        continue;
      }
      if (withMatch[3]!.trim().length > 0 && !BLOCK_SCALAR.test(stripped)) {
        unparseable = true;
        i += 1;
        continue;
      }
      withIndent = indent;
      if (BLOCK_SCALAR.test(stripped)) inScalarIndent = indent;
      i += 1;
      continue;
    }
    if (indent <= withIndent) break;
    const entry = stripped.match(MAPPING_ENTRY);
    if (!entry) {
      unparseable = true;
      i += 1;
      continue;
    }
    if (BLOCK_SCALAR.test(stripped)) {
      inScalarIndent = indent;
      i += 1;
      continue;
    }
    const rawKey = unquote(entry[2]!) ?? entry[2]!;
    const value = parseScalar(entry[3]!);
    if (rawKey === "persist-credentials") {
      if (persistCredentials !== null) unparseable = true;
      if (value === "false") persistCredentials = false;
      else if (value === "true") persistCredentials = true;
      else unparseable = true;
    } else if (rawKey === "fetch-depth") {
      if (fetchDepth !== null) unparseable = true;
      if (value === "0") fetchDepth = 0;
      else if (/^[0-9]+$/.test(value)) fetchDepth = Number(value);
      else unparseable = true;
    }
    i += 1;
  }

  return { persistCredentials, fetchDepth, unparseable, next: i };
}

function isCheckoutIdentity(identity: string): boolean {
  return identity === "actions/checkout" || identity.startsWith("actions/checkout/");
}

export function evaluateWorkflowActions(
  workflowText: string,
  options: { requireCanonicalActionCounts?: boolean } = {},
): ActionPinInventory {
  const requireCanonical = options.requireCanonicalActionCounts === true;
  const lines = workflowText.split("\n");
  const occurrences: ActionUseOccurrence[] = [];
  const fileCodes: ActionPolicyCode[] = [];
  let inScalarIndent: number | null = null;
  let index = 0;
  let i = 0;

  while (i < lines.length) {
    const original = lines[i]!.replace(/\r$/, "");
    const indent = leadingIndent(original);
    if (indent === "tab") {
      fileCodes.push("ACTION_USES_UNPARSABLE");
      break;
    }
    const stripped = stripInlineComment(original);
    if (stripped.trim().length === 0) {
      i += 1;
      continue;
    }
    if (inScalarIndent !== null) {
      if (indent > inScalarIndent) {
        i += 1;
        continue;
      }
      inScalarIndent = null;
    }
    if (FLOW_USES.test(stripped)) {
      fileCodes.push("ACTION_USES_UNPARSABLE");
      i += 1;
      continue;
    }
    const usesMatch = stripped.match(USES_KEY);
    if (usesMatch) {
      const usesKeyIndent = usesMatch[1]!.length + (usesMatch[2] ? usesMatch[2].length : 0);
      const rawValue = usesMatch[4]!.trim();
      if (rawValue.length === 0 || BLOCK_SCALAR.test(stripped) || rawValue === "|" || rawValue === ">") {
        fileCodes.push("ACTION_USES_UNPARSABLE");
        i += 1;
        continue;
      }
      const raw = unquote(rawValue);
      if (raw === null || raw.length === 0) {
        fileCodes.push("ACTION_USES_UNPARSABLE");
        i += 1;
        continue;
      }
      const classified = classifyUses(raw);
      const withBlock = parseWithMapping(lines, i + 1, usesKeyIndent);
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
      occurrences.push({
        index,
        line: i + 1,
        raw,
        kind: classified.kind,
        identity: classified.identity,
        ref: classified.ref,
        immutablePin: classified.immutablePin,
        allowlisted: classified.allowlisted,
        checkoutPersistCredentials,
        checkoutFetchDepth,
        codes: uniqueCodes(codes),
      });
      index += 1;
      i = Math.max(i + 1, withBlock.next);
      continue;
    }
    if (/^\s*(?:-\s+)?(?:"uses"|'uses'|uses)\s*:/.test(stripped)) {
      fileCodes.push("ACTION_USES_UNPARSABLE");
    }
    if (BLOCK_SCALAR.test(stripped)) inScalarIndent = indent;
    i += 1;
  }

  const checkoutOccurrenceCount = occurrences.filter((row) => row.identity === "actions/checkout").length;
  const setupNodeOccurrenceCount = occurrences.filter((row) => row.identity === "actions/setup-node").length;
  const uploadArtifactOccurrenceCount = occurrences.filter((row) => row.identity === "actions/upload-artifact").length;
  if (requireCanonical) {
    if (checkoutOccurrenceCount !== 1) fileCodes.push("CHECKOUT_OCCURRENCE_INVALID");
    if (setupNodeOccurrenceCount !== 1) fileCodes.push("SETUP_NODE_OCCURRENCE_INVALID");
    if (uploadArtifactOccurrenceCount < 1) fileCodes.push("UPLOAD_ARTIFACT_OCCURRENCE_INVALID");
  }

  const codes = uniqueCodes([
    ...fileCodes,
    ...occurrences.flatMap((row) => row.codes),
  ]);
  const overallPolicyOk = codes.length === 0;
  return {
    schemaVersion: ACTION_PIN_SCHEMA,
    overallPolicyOk,
    codes: overallPolicyOk ? ["PASS"] : codes,
    actionUsesTotal: occurrences.length,
    checkoutOccurrenceCount,
    setupNodeOccurrenceCount,
    uploadArtifactOccurrenceCount,
    unpinnedExternalActions: occurrences.filter((row) => row.kind === "external" && !row.immutablePin).length,
    unsafeCheckouts: occurrences.filter((row) => (
      row.identity === "actions/checkout"
      && (row.checkoutPersistCredentials !== false || row.checkoutFetchDepth !== 0)
    )).length,
    occurrences,
  };
}

export function parseActionPins(workflowText: string): ActionPinInventory {
  return evaluateWorkflowActions(workflowText, { requireCanonicalActionCounts: true });
}
