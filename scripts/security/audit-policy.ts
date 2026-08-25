import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BASELINE_SCHEMA = "classic-v0.2-security-audit-baseline/1";
export const VERIFICATION_SCHEMA = "classic-v0.2-security-audit-verification/1";
export const ACTION_PIN_SCHEMA = "classic-v0.2-action-pin-inventory/1";
export const BASELINE_RELATIVE_PATH = "scripts/security/npm-audit-baseline.json";
export const LOCKFILE_RELATIVE_PATH = "package-lock.json";
export const WORKFLOW_RELATIVE_PATH = ".github/workflows/ci.yml";

export type PolicyCode =
  | "PASS"
  | "AUDIT_COMMAND_FAILED"
  | "AUDIT_JSON_MALFORMED"
  | "AUDIT_MISSING_FIELDS"
  | "AUDIT_FILE_MISSING"
  | "LOCKFILE_HASH_MISMATCH"
  | "CRITICAL_VULNERABILITY"
  | "NEW_HIGH"
  | "ADVISORY_REPLACED"
  | "DEPENDENCY_PATH_CHANGED"
  | "PACKAGE_IDENTITY_CHANGED";

export type FixAvailable =
  | boolean
  | { name: string; version: string; isSemVerMajor: boolean };

export type HighFinding = {
  advisoryId: string;
  sourceId: string;
  ghsaId: string | null;
  package: string;
  severity: "high";
  isDirect: boolean;
  dependencyPaths: string[];
  vulnerableRange: string;
  fixAvailable: FixAvailable;
};

export type HighPackage = {
  package: string;
  severity: "high";
  isDirect: boolean;
  dependencyPaths: string[];
  vulnerableRange: string;
  viaHighAdvisoryIds: string[];
  fixAvailable: FixAvailable;
};

export type AuditBaseline = {
  schemaVersion: typeof BASELINE_SCHEMA;
  lockfile: { path: typeof LOCKFILE_RELATIVE_PATH; sha256: string };
  policy: {
    failOnAnyCritical: true;
    allowResolvedHigh: true;
    existingHighAreNotCleared: true;
  };
  highFindings: HighFinding[];
  highPackages: HighPackage[];
};

export type ActionPin = {
  action: string;
  commitSha: string;
  version: string;
};

export type ActionPinInventory = {
  schemaVersion: typeof ACTION_PIN_SCHEMA;
  persistCredentials: false | true;
  fetchDepth: number;
  pins: ActionPin[];
};

export type PolicyResult = {
  ok: boolean;
  codes: PolicyCode[];
  lockfileSha256: string;
  expectedLockfileSha256: string;
  auditReportVersion: number | null;
  highCount: number;
  criticalCount: number;
  totalCount: number;
  matchingHigh: HighFinding[];
  resolvedHigh: HighFinding[];
  newHigh: HighFinding[];
  critical: Array<{ package: string; advisoryId: string | null; severity: "critical" }>;
  advisoryReplaced: Array<{ package: string; expectedAdvisoryId: string; actualAdvisoryId: string }>;
  dependencyPathChanged: Array<{ advisoryId: string; package: string; expected: string[]; actual: string[] }>;
  packageIdentityChanged: Array<{ advisoryId: string; expectedPackage: string; actualPackage: string }>;
};

const SECRET_KEY = /^(env|environment|headers|authorization|token|secret|password|home|npm_token|github_token)$/i;

export function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(filePath: string): string {
  return sha256Bytes(fs.readFileSync(filePath));
}

export function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function pathsEqual(a: string[], b: string[]): boolean {
  const left = sortedUnique(a);
  const right = sortedUnique(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sanitizeForArtifact(text: string, repoRoot?: string): string {
  let out = text;
  if (repoRoot) {
    const resolved = path.resolve(repoRoot);
    out = out.split(resolved).join(".");
  }
  const homes = [os.homedir(), process.env.HOME, process.env.USERPROFILE]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const home of homes) {
    out = out.split(home).join("$HOME");
  }
  out = out.replace(/\bauthorization\s*[:=]\s*[^\n\r]+/gi, "authorization: [redacted]");
  out = out.replace(/\bbearer\s+\S+/gi, "bearer [redacted]");
  return out;
}

export function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeForArtifact(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = sanitizeValue(nested);
    }
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ghsaFromUrl(url: unknown): string | null {
  const text = asString(url);
  if (!text) return null;
  const match = text.match(/GHSA-[0-9a-z-]+/i);
  return match ? match[0] : null;
}

function normalizeFixAvailable(value: unknown): FixAvailable | null {
  if (value === true || value === false) return value;
  if (isRecord(value) && asString(value.name) && asString(value.version)) {
    return {
      name: String(value.name),
      version: String(value.version),
      isSemVerMajor: value.isSemVerMajor === true,
    };
  }
  return null;
}

export type ParseFailure = {
  ok: false;
  code: Extract<PolicyCode, "AUDIT_JSON_MALFORMED" | "AUDIT_MISSING_FIELDS">;
};

export type ParsedAudit = {
  ok: true;
  auditReportVersion: number;
  metadata: { high: number; critical: number; total: number };
  highFindings: HighFinding[];
  highPackages: HighPackage[];
  critical: Array<{ package: string; advisoryId: string | null; severity: "critical" }>;
  raw: Record<string, unknown>;
};

function missing(): ParseFailure {
  return { ok: false, code: "AUDIT_MISSING_FIELDS" };
}

function parseViaAdvisory(
  via: unknown,
  pkg: {
    name: string;
    isDirect: boolean;
    nodes: string[];
    fixAvailable: FixAvailable;
  },
): { severity: string; finding: Omit<HighFinding, "severity"> & { severity: "high" | "critical" } } | ParseFailure | null {
  if (typeof via === "string") return null;
  if (!isRecord(via)) return missing();
  const source = via.source;
  const sourceId = typeof source === "number" || typeof source === "string" ? String(source) : null;
  const name = asString(via.name) ?? asString(via.dependency);
  const severity = asString(via.severity);
  const range = asString(via.range);
  if (!sourceId || !name || !severity || !range) return missing();
  if (severity !== "high" && severity !== "critical") return null;
  return {
    severity,
    finding: {
      advisoryId: sourceId,
      sourceId,
      ghsaId: ghsaFromUrl(via.url),
      package: name,
      severity,
      isDirect: pkg.isDirect,
      dependencyPaths: sortedUnique(pkg.nodes),
      vulnerableRange: range,
      fixAvailable: pkg.fixAvailable,
    },
  };
}

export function parseAuditReport(raw: string): ParsedAudit | ParseFailure {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, code: "AUDIT_JSON_MALFORMED" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "AUDIT_JSON_MALFORMED" };
  }
  if (!isRecord(parsed)) return missing();
  if (parsed.auditReportVersion !== 2) return missing();
  if (!isRecord(parsed.vulnerabilities)) return missing();
  if (!isRecord(parsed.metadata) || !isRecord(parsed.metadata.vulnerabilities)) return missing();
  const meta = parsed.metadata.vulnerabilities;
  const high = asNumber(meta.high);
  const critical = asNumber(meta.critical);
  const total = asNumber(meta.total);
  if (high === null || critical === null || total === null) return missing();

  const highFindings: HighFinding[] = [];
  const highPackages: HighPackage[] = [];
  const criticalRows: ParsedAudit["critical"] = [];

  for (const [key, entry] of Object.entries(parsed.vulnerabilities)) {
    if (!isRecord(entry)) return missing();
    const name = asString(entry.name) ?? key;
    const severity = asString(entry.severity);
    const isDirect = asBoolean(entry.isDirect);
    const range = asString(entry.range);
    const nodes = entry.nodes;
    const via = entry.via;
    const fixAvailable = normalizeFixAvailable(entry.fixAvailable);
    if (!name || !severity || isDirect === null || !range || !Array.isArray(nodes) || !Array.isArray(via) || fixAvailable === null) {
      return missing();
    }
    if (!nodes.every((node) => typeof node === "string")) return missing();
    const pkg = {
      name,
      isDirect,
      nodes: nodes as string[],
      fixAvailable,
    };

    const viaHighAdvisoryIds: string[] = [];
    for (const item of via) {
      const parsedVia = parseViaAdvisory(item, pkg);
      if (parsedVia !== null && "ok" in parsedVia) return parsedVia;
      if (parsedVia === null) continue;
      if (parsedVia.severity === "critical") {
        criticalRows.push({
          package: parsedVia.finding.package,
          advisoryId: parsedVia.finding.advisoryId,
          severity: "critical",
        });
      } else {
        viaHighAdvisoryIds.push(parsedVia.finding.advisoryId);
        highFindings.push(parsedVia.finding as HighFinding);
      }
    }

    if (severity === "critical") {
      criticalRows.push({ package: name, advisoryId: viaHighAdvisoryIds[0] ?? null, severity: "critical" });
    } else if (severity === "high") {
      highPackages.push({
        package: name,
        severity: "high",
        isDirect,
        dependencyPaths: sortedUnique(pkg.nodes),
        vulnerableRange: range,
        viaHighAdvisoryIds: sortedUnique(viaHighAdvisoryIds),
        fixAvailable,
      });
    }
  }

  return {
    ok: true,
    auditReportVersion: 2,
    metadata: { high, critical, total },
    highFindings,
    highPackages,
    critical: criticalRows,
    raw: parsed,
  };
}

export function readAuditFile(filePath: string): { ok: true; raw: string } | { ok: false; code: "AUDIT_FILE_MISSING" } {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { ok: false, code: "AUDIT_FILE_MISSING" };
  }
  return { ok: true, raw: fs.readFileSync(filePath, "utf8") };
}

function emptyResult(partial: Partial<PolicyResult> & Pick<PolicyResult, "ok" | "codes" | "lockfileSha256" | "expectedLockfileSha256">): PolicyResult {
  return {
    highCount: 0,
    criticalCount: 0,
    totalCount: 0,
    auditReportVersion: null,
    matchingHigh: [],
    resolvedHigh: [],
    newHigh: [],
    critical: [],
    advisoryReplaced: [],
    dependencyPathChanged: [],
    packageIdentityChanged: [],
    ...partial,
  };
}

export function failedPolicy(
  code: Extract<PolicyCode, "AUDIT_COMMAND_FAILED" | "AUDIT_FILE_MISSING" | "AUDIT_JSON_MALFORMED" | "AUDIT_MISSING_FIELDS" | "LOCKFILE_HASH_MISMATCH">,
  lockfileSha256: string,
  expectedLockfileSha256: string,
): PolicyResult {
  return emptyResult({
    ok: false,
    codes: [code],
    lockfileSha256,
    expectedLockfileSha256,
  });
}

function uniqueCodes(codes: PolicyCode[]): PolicyCode[] {
  return [...new Set(codes)];
}

export function evaluateAuditPolicy(input: {
  baseline: AuditBaseline;
  lockfileSha256: string;
  auditRaw?: string;
  parsed?: ParsedAudit;
}): PolicyResult {
  const expectedLockfileSha256 = input.baseline.lockfile.sha256;
  if (!/^[0-9a-f]{64}$/.test(expectedLockfileSha256) || input.baseline.lockfile.path !== LOCKFILE_RELATIVE_PATH) {
    return emptyResult({
      ok: false,
      codes: ["AUDIT_MISSING_FIELDS"],
      lockfileSha256: input.lockfileSha256,
      expectedLockfileSha256,
    });
  }
  if (input.lockfileSha256 !== expectedLockfileSha256) {
    return emptyResult({
      ok: false,
      codes: ["LOCKFILE_HASH_MISMATCH"],
      lockfileSha256: input.lockfileSha256,
      expectedLockfileSha256,
    });
  }

  const parsed = input.parsed ?? (typeof input.auditRaw === "string" ? parseAuditReport(input.auditRaw) : { ok: false as const, code: "AUDIT_JSON_MALFORMED" as const });
  if (!parsed.ok) {
    return emptyResult({
      ok: false,
      codes: [parsed.code],
      lockfileSha256: input.lockfileSha256,
      expectedLockfileSha256,
    });
  }

  const codes: PolicyCode[] = [];
  const matchingHigh: HighFinding[] = [];
  const newHigh: HighFinding[] = [];
  const advisoryReplaced: PolicyResult["advisoryReplaced"] = [];
  const dependencyPathChanged: PolicyResult["dependencyPathChanged"] = [];
  const packageIdentityChanged: PolicyResult["packageIdentityChanged"] = [];

  const baselineById = new Map(input.baseline.highFindings.map((finding) => [finding.advisoryId, finding]));
  const baselineByIdPackage = new Map(
    input.baseline.highFindings.map((finding) => [`${finding.advisoryId}\0${finding.package}`, finding]),
  );
  const baselineByPackagePath = new Map(
    input.baseline.highFindings.map((finding) => [`${finding.package}\0${sortedUnique(finding.dependencyPaths).join("\0")}`, finding]),
  );
  const seenCurrentIds = new Set<string>();

  for (const current of parsed.highFindings) {
    seenCurrentIds.add(current.advisoryId);
    const sameIdPackage = baselineByIdPackage.get(`${current.advisoryId}\0${current.package}`);
    if (sameIdPackage) {
      if (!pathsEqual(sameIdPackage.dependencyPaths, current.dependencyPaths)) {
        codes.push("DEPENDENCY_PATH_CHANGED");
        dependencyPathChanged.push({
          advisoryId: current.advisoryId,
          package: current.package,
          expected: sameIdPackage.dependencyPaths,
          actual: current.dependencyPaths,
        });
      } else {
        matchingHigh.push(current);
      }
      continue;
    }
    const samePackagePath = baselineByPackagePath.get(
      `${current.package}\0${sortedUnique(current.dependencyPaths).join("\0")}`,
    );
    if (samePackagePath) {
      codes.push("ADVISORY_REPLACED");
      advisoryReplaced.push({
        package: current.package,
        expectedAdvisoryId: samePackagePath.advisoryId,
        actualAdvisoryId: current.advisoryId,
      });
      continue;
    }
    const sameId = baselineById.get(current.advisoryId);
    if (sameId) {
      codes.push("PACKAGE_IDENTITY_CHANGED");
      packageIdentityChanged.push({
        advisoryId: current.advisoryId,
        expectedPackage: sameId.package,
        actualPackage: current.package,
      });
      continue;
    }
    codes.push("NEW_HIGH");
    newHigh.push(current);
  }

  const resolvedHigh = input.baseline.highFindings.filter((finding) => !seenCurrentIds.has(finding.advisoryId));

  const baselinePackages = new Map(input.baseline.highPackages.map((row) => [row.package, row]));
  for (const current of parsed.highPackages) {
    const expected = baselinePackages.get(current.package);
    if (!expected) {
      codes.push("NEW_HIGH");
      newHigh.push({
        advisoryId: current.viaHighAdvisoryIds[0] ?? `package:${current.package}`,
        sourceId: current.viaHighAdvisoryIds[0] ?? `package:${current.package}`,
        ghsaId: null,
        package: current.package,
        severity: "high",
        isDirect: current.isDirect,
        dependencyPaths: current.dependencyPaths,
        vulnerableRange: current.vulnerableRange,
        fixAvailable: current.fixAvailable,
      });
      continue;
    }
    if (!pathsEqual(expected.dependencyPaths, current.dependencyPaths)) {
      codes.push("DEPENDENCY_PATH_CHANGED");
      dependencyPathChanged.push({
        advisoryId: current.viaHighAdvisoryIds[0] ?? `package:${current.package}`,
        package: current.package,
        expected: expected.dependencyPaths,
        actual: current.dependencyPaths,
      });
    }
    const expectedIds = sortedUnique(expected.viaHighAdvisoryIds);
    const actualIds = sortedUnique(current.viaHighAdvisoryIds);
    if (expectedIds.join("\0") !== actualIds.join("\0")) {
      const added = actualIds.filter((id) => !expectedIds.includes(id));
      const removed = expectedIds.filter((id) => !actualIds.includes(id));
      if (added.length > 0 && removed.length > 0) {
        codes.push("ADVISORY_REPLACED");
        advisoryReplaced.push({
          package: current.package,
          expectedAdvisoryId: removed.join(","),
          actualAdvisoryId: added.join(","),
        });
      } else if (added.length > 0) {
        codes.push("NEW_HIGH");
        for (const id of added) {
          newHigh.push({
            advisoryId: id,
            sourceId: id,
            ghsaId: null,
            package: current.package,
            severity: "high",
            isDirect: current.isDirect,
            dependencyPaths: current.dependencyPaths,
            vulnerableRange: current.vulnerableRange,
            fixAvailable: current.fixAvailable,
          });
        }
      }
    }
  }

  if (parsed.critical.length > 0 || parsed.metadata.critical > 0) {
    codes.push("CRITICAL_VULNERABILITY");
  }

  const unique = uniqueCodes(codes);
  const ok = unique.length === 0;
  return {
    ok,
    codes: ok ? ["PASS"] : unique,
    lockfileSha256: input.lockfileSha256,
    expectedLockfileSha256,
    auditReportVersion: parsed.auditReportVersion,
    highCount: parsed.metadata.high,
    criticalCount: parsed.metadata.critical,
    totalCount: parsed.metadata.total,
    matchingHigh,
    resolvedHigh,
    newHigh,
    critical: parsed.critical,
    advisoryReplaced,
    dependencyPathChanged,
    packageIdentityChanged,
  };
}

export function buildBaseline(lockfileSha256: string, parsed: ParsedAudit): AuditBaseline {
  return {
    schemaVersion: BASELINE_SCHEMA,
    lockfile: { path: LOCKFILE_RELATIVE_PATH, sha256: lockfileSha256 },
    policy: {
      failOnAnyCritical: true,
      allowResolvedHigh: true,
      existingHighAreNotCleared: true,
    },
    highFindings: parsed.highFindings,
    highPackages: parsed.highPackages,
  };
}

export function parseActionPins(workflowText: string): ActionPinInventory {
  const pins: ActionPin[] = [];
  const uses = [...workflowText.matchAll(/uses:\s+(actions\/(?:checkout|setup-node|upload-artifact))@([0-9a-f]{40})\s+#\s+(v\d+\.\d+\.\d+)/g)];
  for (const match of uses) {
    pins.push({ action: match[1]!, commitSha: match[2]!, version: match[3]! });
  }
  const persistCredentials = /persist-credentials:\s*false/.test(workflowText);
  const depthMatch = workflowText.match(/fetch-depth:\s*(\d+)/);
  return {
    schemaVersion: ACTION_PIN_SCHEMA,
    persistCredentials: persistCredentials ? false : true,
    fetchDepth: depthMatch ? Number(depthMatch[1]) : -1,
    pins,
  };
}

export function verificationDocument(result: PolicyResult): Record<string, unknown> {
  return sanitizeValue({
    schemaVersion: VERIFICATION_SCHEMA,
    ok: result.ok,
    codes: result.codes,
    existingHighAreNotCleared: true,
    lockfile: {
      path: LOCKFILE_RELATIVE_PATH,
      sha256: result.lockfileSha256,
      matchesBaseline: result.lockfileSha256 === result.expectedLockfileSha256,
    },
    audit: {
      auditReportVersion: result.auditReportVersion,
      high: result.highCount,
      critical: result.criticalCount,
      total: result.totalCount,
    },
    matchingHigh: result.matchingHigh,
    resolvedHigh: result.resolvedHigh,
    newHigh: result.newHigh,
    critical: result.critical,
    advisoryReplaced: result.advisoryReplaced,
    dependencyPathChanged: result.dependencyPathChanged,
    packageIdentityChanged: result.packageIdentityChanged,
  }) as Record<string, unknown>;
}

export function repoPath(root: string, relative: string): string {
  return path.join(root, relative);
}
