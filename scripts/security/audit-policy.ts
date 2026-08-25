import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACTION_PIN_SCHEMA,
  evaluateWorkflowActions,
  inventoryGitRepository,
  parseActionPins,
  type ActionPinInventory,
} from "./action-pin-policy.js";

export { ACTION_PIN_SCHEMA, evaluateWorkflowActions, inventoryGitRepository, parseActionPins };
export type { ActionPinInventory, ActionPolicyCode, ActionUseOccurrence } from "./action-pin-policy.js";

export const BASELINE_SCHEMA = "classic-v0.2-security-audit-baseline/1";
export const VERIFICATION_SCHEMA = "classic-v0.2-security-audit-verification/2";
export const BASELINE_RELATIVE_PATH = "scripts/security/npm-audit-baseline.json";
export const LOCKFILE_RELATIVE_PATH = "package-lock.json";
export const WORKFLOW_RELATIVE_PATH = ".github/workflows/ci.yml";

export const SEVERITY_LEVELS = ["info", "low", "moderate", "high", "critical"] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export type PolicyCode =
  | "PASS"
  | "AUDIT_COMMAND_FAILED"
  | "AUDIT_JSON_MALFORMED"
  | "AUDIT_MISSING_FIELDS"
  | "AUDIT_COUNT_INVALID"
  | "AUDIT_COUNT_MISMATCH"
  | "AUDIT_SEVERITY_INVALID"
  | "ADVISORY_IDENTITY_MISSING"
  | "AUDIT_FILE_MISSING"
  | "LOCKFILE_HASH_MISMATCH"
  | "CRITICAL_VULNERABILITY"
  | "NEW_HIGH"
  | "ADVISORY_REPLACED"
  | "DEPENDENCY_PATH_CHANGED"
  | "PACKAGE_IDENTITY_CHANGED";

export type SeverityCounts = {
  info: number;
  low: number;
  moderate: number;
  high: number;
  critical: number;
  total: number;
};

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

export type PackageRow = {
  name: string;
  severity: SeverityLevel;
  viaAdvisoryIds: string[];
};

export type AdvisoryIdentityMissing = {
  advisoryId: string;
  package: string;
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

export type PolicyResult = {
  ok: boolean;
  codes: PolicyCode[];
  lockfileSha256: string;
  expectedLockfileSha256: string;
  auditReportVersion: number | null;
  metadata: SeverityCounts;
  observed: SeverityCounts;
  metadataMatchesObserved: boolean;
  highCount: number;
  criticalCount: number;
  totalCount: number;
  matchingHigh: HighFinding[];
  resolvedHigh: HighFinding[];
  newHigh: HighFinding[];
  advisoryIdentityMissing: AdvisoryIdentityMissing[];
  critical: Array<{ package: string; advisoryId: string | null; severity: "critical" }>;
  advisoryReplaced: Array<{ package: string; expectedAdvisoryId: string; actualAdvisoryId: string }>;
  dependencyPathChanged: Array<{ advisoryId: string; package: string; expected: string[]; actual: string[] }>;
  packageIdentityChanged: Array<{ advisoryId: string; expectedPackage: string; actualPackage: string }>;
};

const SECRET_KEY = /^(env|environment|headers|authorization|token|secret|password|home|npm_token|github_token)$/i;

export function zeroCounts(): SeverityCounts {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
}

export function severitySum(counts: Pick<SeverityCounts, SeverityLevel>): number {
  return counts.info + counts.low + counts.moderate + counts.high + counts.critical;
}

export function countsEqual(a: SeverityCounts, b: SeverityCounts): boolean {
  return SEVERITY_LEVELS.every((level) => a[level] === b[level]) && a.total === b.total;
}

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

function parseNonNegativeSafeInt(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function isSeverity(value: string): value is SeverityLevel {
  return (SEVERITY_LEVELS as readonly string[]).includes(value);
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
  code: Extract<
    PolicyCode,
    | "AUDIT_JSON_MALFORMED"
    | "AUDIT_MISSING_FIELDS"
    | "AUDIT_COUNT_INVALID"
    | "AUDIT_COUNT_MISMATCH"
    | "AUDIT_SEVERITY_INVALID"
    | "ADVISORY_IDENTITY_MISSING"
  >;
  metadata: SeverityCounts | null;
  observed: SeverityCounts | null;
  metadataMatchesObserved: false;
};

export type ParsedAudit = {
  ok: true;
  auditReportVersion: number;
  metadata: SeverityCounts;
  observed: SeverityCounts;
  metadataMatchesObserved: true;
  highFindings: HighFinding[];
  highPackages: HighPackage[];
  packageRows: PackageRow[];
  critical: Array<{ package: string; advisoryId: string | null; severity: "critical" }>;
  raw: Record<string, unknown>;
};

function parseFail(
  code: ParseFailure["code"],
  metadata: SeverityCounts | null = null,
  observed: SeverityCounts | null = null,
): ParseFailure {
  return { ok: false, code, metadata, observed, metadataMatchesObserved: false };
}

function parseViaAdvisory(
  via: unknown,
  pkg: {
    name: string;
    isDirect: boolean;
    nodes: string[];
    fixAvailable: FixAvailable;
  },
): { sourceId: string; severity: string; finding: Omit<HighFinding, "severity"> & { severity: "high" | "critical" } } | ParseFailure | { sourceId: string; severity: string; finding: null } | null {
  if (typeof via === "string") return null;
  if (!isRecord(via)) return parseFail("AUDIT_MISSING_FIELDS");
  const source = via.source;
  const sourceId = typeof source === "number" || typeof source === "string" ? String(source) : null;
  const name = asString(via.name) ?? asString(via.dependency);
  const severity = asString(via.severity);
  const range = asString(via.range);
  if (!sourceId || !name || !severity || !range) return parseFail("AUDIT_MISSING_FIELDS");
  if (severity !== "high" && severity !== "critical") {
    return { sourceId, severity, finding: null };
  }
  return {
    sourceId,
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

function parseMetadataCounts(meta: Record<string, unknown>): { ok: true; counts: SeverityCounts } | { ok: false } {
  const counts = zeroCounts();
  for (const level of [...SEVERITY_LEVELS, "total"] as const) {
    if (!Object.prototype.hasOwnProperty.call(meta, level)) return { ok: false };
    const parsed = parseNonNegativeSafeInt(meta[level]);
    if (parsed === null) return { ok: false };
    counts[level] = parsed;
  }
  return { ok: true, counts };
}

export function parseAuditReport(raw: string): ParsedAudit | ParseFailure {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return parseFail("AUDIT_JSON_MALFORMED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return parseFail("AUDIT_JSON_MALFORMED");
  }
  if (!isRecord(parsed)) return parseFail("AUDIT_MISSING_FIELDS");
  if (parsed.auditReportVersion !== 2) return parseFail("AUDIT_MISSING_FIELDS");
  if (!isRecord(parsed.vulnerabilities)) return parseFail("AUDIT_MISSING_FIELDS");
  if (!isRecord(parsed.metadata) || !isRecord(parsed.metadata.vulnerabilities)) {
    return parseFail("AUDIT_MISSING_FIELDS");
  }
  const metadataParsed = parseMetadataCounts(parsed.metadata.vulnerabilities);
  if (!metadataParsed.ok) return parseFail("AUDIT_COUNT_INVALID");
  const metadata = metadataParsed.counts;
  if (metadata.total !== severitySum(metadata)) {
    return parseFail("AUDIT_COUNT_MISMATCH", metadata, null);
  }

  const highFindings: HighFinding[] = [];
  const highPackages: HighPackage[] = [];
  const packageRows: PackageRow[] = [];
  const criticalRows: ParsedAudit["critical"] = [];
  const observed = zeroCounts();

  for (const [key, entry] of Object.entries(parsed.vulnerabilities)) {
    if (!isRecord(entry)) return parseFail("AUDIT_MISSING_FIELDS", metadata, observed);
    const name = asString(entry.name) ?? key;
    const severityRaw = asString(entry.severity);
    const isDirect = asBoolean(entry.isDirect);
    const range = asString(entry.range);
    const nodes = entry.nodes;
    const via = entry.via;
    const fixAvailable = normalizeFixAvailable(entry.fixAvailable);
    if (!name || !severityRaw || isDirect === null || !range || !Array.isArray(nodes) || !Array.isArray(via) || fixAvailable === null) {
      return parseFail("AUDIT_MISSING_FIELDS", metadata, observed);
    }
    if (!isSeverity(severityRaw)) return parseFail("AUDIT_SEVERITY_INVALID", metadata, observed);
    if (!nodes.every((node) => typeof node === "string")) {
      return parseFail("AUDIT_MISSING_FIELDS", metadata, observed);
    }
    const pkg = {
      name,
      isDirect,
      nodes: nodes as string[],
      fixAvailable,
    };

    const viaAdvisoryIds: string[] = [];
    const viaHighAdvisoryIds: string[] = [];
    for (const item of via) {
      const parsedVia = parseViaAdvisory(item, pkg);
      if (parsedVia !== null && "ok" in parsedVia) {
        return parseFail(parsedVia.code, metadata, observed);
      }
      if (parsedVia === null) continue;
      viaAdvisoryIds.push(parsedVia.sourceId);
      if (parsedVia.finding === null) continue;
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

    observed[severityRaw] += 1;
    packageRows.push({
      name,
      severity: severityRaw,
      viaAdvisoryIds: sortedUnique(viaAdvisoryIds),
    });

    if (severityRaw === "critical") {
      criticalRows.push({ package: name, advisoryId: viaHighAdvisoryIds[0] ?? viaAdvisoryIds[0] ?? null, severity: "critical" });
    } else if (severityRaw === "high") {
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

  observed.total = severitySum(observed);
  if (!countsEqual(metadata, observed)) {
    return parseFail("AUDIT_COUNT_MISMATCH", metadata, observed);
  }

  return {
    ok: true,
    auditReportVersion: 2,
    metadata,
    observed,
    metadataMatchesObserved: true,
    highFindings,
    highPackages,
    packageRows,
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
  const metadata = partial.metadata ?? zeroCounts();
  const observed = partial.observed ?? zeroCounts();
  return {
    auditReportVersion: null,
    metadata,
    observed,
    metadataMatchesObserved: false,
    highCount: metadata.high,
    criticalCount: metadata.critical,
    totalCount: metadata.total,
    matchingHigh: [],
    resolvedHigh: [],
    newHigh: [],
    advisoryIdentityMissing: [],
    critical: [],
    advisoryReplaced: [],
    dependencyPathChanged: [],
    packageIdentityChanged: [],
    ...partial,
  };
}

export function failedPolicy(
  code: Extract<
    PolicyCode,
    | "AUDIT_COMMAND_FAILED"
    | "AUDIT_FILE_MISSING"
    | "AUDIT_JSON_MALFORMED"
    | "AUDIT_MISSING_FIELDS"
    | "AUDIT_COUNT_INVALID"
    | "AUDIT_COUNT_MISMATCH"
    | "AUDIT_SEVERITY_INVALID"
    | "ADVISORY_IDENTITY_MISSING"
    | "LOCKFILE_HASH_MISMATCH"
  >,
  lockfileSha256: string,
  expectedLockfileSha256: string,
  extra: Partial<PolicyResult> = {},
): PolicyResult {
  return emptyResult({
    ok: false,
    codes: [code],
    lockfileSha256,
    expectedLockfileSha256,
    ...extra,
  });
}

function uniqueCodes(codes: PolicyCode[]): PolicyCode[] {
  return [...new Set(codes)];
}

function packageStillHigh(severity: SeverityLevel | undefined): boolean {
  return severity === "high" || severity === "critical";
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

  const parsed = input.parsed ?? (typeof input.auditRaw === "string" ? parseAuditReport(input.auditRaw) : parseFail("AUDIT_JSON_MALFORMED"));
  if (!parsed.ok) {
    return emptyResult({
      ok: false,
      codes: [parsed.code],
      lockfileSha256: input.lockfileSha256,
      expectedLockfileSha256,
      metadata: parsed.metadata ?? zeroCounts(),
      observed: parsed.observed ?? zeroCounts(),
      metadataMatchesObserved: false,
    });
  }

  const codes: PolicyCode[] = [];
  const matchingHigh: HighFinding[] = [];
  const newHigh: HighFinding[] = [];
  const advisoryIdentityMissing: AdvisoryIdentityMissing[] = [];
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
  const currentAdvisoryIds = new Set<string>();
  for (const row of parsed.packageRows) {
    for (const id of row.viaAdvisoryIds) currentAdvisoryIds.add(id);
  }
  const currentByName = new Map<string, PackageRow>();
  for (const row of parsed.packageRows) {
    currentByName.set(row.name, row);
  }

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

  const resolvedHigh: HighFinding[] = [];
  for (const finding of input.baseline.highFindings) {
    if (seenCurrentIds.has(finding.advisoryId) || currentAdvisoryIds.has(finding.advisoryId)) {
      continue;
    }
    const pkg = currentByName.get(finding.package);
    if (pkg && packageStillHigh(pkg.severity)) {
      codes.push("ADVISORY_IDENTITY_MISSING");
      advisoryIdentityMissing.push({ advisoryId: finding.advisoryId, package: finding.package });
      continue;
    }
    resolvedHigh.push(finding);
  }

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
      } else if (removed.length > 0 && packageStillHigh(current.severity)) {
        codes.push("ADVISORY_IDENTITY_MISSING");
        for (const id of removed) {
          advisoryIdentityMissing.push({ advisoryId: id, package: current.package });
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
    metadata: parsed.metadata,
    observed: parsed.observed,
    metadataMatchesObserved: parsed.metadataMatchesObserved,
    highCount: parsed.metadata.high,
    criticalCount: parsed.metadata.critical,
    totalCount: parsed.metadata.total,
    matchingHigh,
    resolvedHigh,
    newHigh,
    advisoryIdentityMissing,
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

export function verificationDocument(result: PolicyResult): Record<string, unknown> {
  return sanitizeValue({
    schemaVersion: VERIFICATION_SCHEMA,
    ok: result.ok,
    overallPolicyOk: result.ok,
    codes: result.codes,
    existingHighAreNotCleared: true,
    lockfile: {
      path: LOCKFILE_RELATIVE_PATH,
      sha256: result.lockfileSha256,
      matchesBaseline: result.lockfileSha256 === result.expectedLockfileSha256,
    },
    metadata: result.metadata,
    observed: result.observed,
    metadataMatchesObserved: result.metadataMatchesObserved,
    audit: {
      auditReportVersion: result.auditReportVersion,
      info: result.metadata.info,
      low: result.metadata.low,
      moderate: result.metadata.moderate,
      high: result.metadata.high,
      critical: result.metadata.critical,
      total: result.metadata.total,
    },
    matchingHigh: result.matchingHigh,
    resolvedHigh: result.resolvedHigh,
    newHigh: result.newHigh,
    advisoryIdentityMissing: result.advisoryIdentityMissing,
    critical: result.critical,
    advisoryReplaced: result.advisoryReplaced,
    dependencyPathChanged: result.dependencyPathChanged,
    packageIdentityChanged: result.packageIdentityChanged,
  }) as Record<string, unknown>;
}

export function actionInventoryDocument(inventory: ActionPinInventory): Record<string, unknown> {
  return sanitizeValue({
    schemaVersion: inventory.schemaVersion,
    overallPolicyOk: inventory.overallPolicyOk,
    codes: inventory.codes,
    actionUsesTotal: inventory.actionUsesTotal,
    checkoutOccurrenceCount: inventory.checkoutOccurrenceCount,
    setupNodeOccurrenceCount: inventory.setupNodeOccurrenceCount,
    uploadArtifactOccurrenceCount: inventory.uploadArtifactOccurrenceCount,
    unpinnedExternalActions: inventory.unpinnedExternalActions,
    unsafeCheckouts: inventory.unsafeCheckouts,
    dockerActionCount: inventory.dockerActionCount,
    trackedManifests: inventory.trackedManifests,
    scannedFiles: inventory.scannedFiles,
    allowlist: inventory.allowlist,
    graph: inventory.graph,
    occurrences: inventory.occurrences.map((row) => ({
      index: row.index,
      file: row.file,
      line: row.line,
      raw: row.raw,
      kind: row.kind,
      identity: row.identity,
      ref: row.ref,
      immutablePin: row.immutablePin,
      allowlisted: row.allowlisted,
      checkoutPersistCredentials: row.checkoutPersistCredentials,
      checkoutFetchDepth: row.checkoutFetchDepth,
      source: row.source,
      codes: row.codes,
    })),
  }) as Record<string, unknown>;
}

export function repoPath(root: string, relative: string): string {
  return path.join(root, relative);
}
