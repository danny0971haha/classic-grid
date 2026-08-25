import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BASELINE_RELATIVE_PATH,
  LOCKFILE_RELATIVE_PATH,
  evaluateAuditPolicy,
  parseActionPins,
  parseAuditReport,
  readAuditFile,
  sanitizeForArtifact,
  sha256File,
  verificationDocument,
  type AuditBaseline,
  type FixAvailable,
  type HighFinding,
  type HighPackage,
} from "../../scripts/security/audit-policy.js";
import { runAuditBaseline } from "../../scripts/security/audit-baseline.js";

const LOCK_SHA = "a".repeat(64);

function finding(overrides: Partial<HighFinding> = {}): HighFinding {
  return {
    advisoryId: "1001",
    sourceId: "1001",
    ghsaId: "GHSA-test-xxxx",
    package: "axios",
    severity: "high",
    isDirect: false,
    dependencyPaths: ["node_modules/axios"],
    vulnerableRange: ">=1.15.2 <1.18.0",
    fixAvailable: false,
    ...overrides,
  };
}

function highPackage(overrides: Partial<HighPackage> = {}): HighPackage {
  return {
    package: "axios",
    severity: "high",
    isDirect: false,
    dependencyPaths: ["node_modules/axios"],
    vulnerableRange: "1.0.0 - 1.17.0",
    viaHighAdvisoryIds: ["1001"],
    fixAvailable: false,
    ...overrides,
  };
}

function baseline(overrides: Partial<AuditBaseline> = {}): AuditBaseline {
  return {
    schemaVersion: "classic-v0.2-security-audit-baseline/1",
    lockfile: { path: LOCKFILE_RELATIVE_PATH, sha256: LOCK_SHA },
    policy: {
      failOnAnyCritical: true,
      allowResolvedHigh: true,
      existingHighAreNotCleared: true,
    },
    highFindings: [finding()],
    highPackages: [highPackage()],
    ...overrides,
  };
}

function viaObject(source: number, name: string, severity: string, range: string, extra: Record<string, unknown> = {}) {
  return {
    source,
    name,
    dependency: name,
    title: `${name} fixture`,
    url: `https://github.com/advisories/GHSA-test-${source}`,
    severity,
    range,
    cwe: [],
    ...extra,
  };
}

function auditJson(input: {
  high?: number;
  critical?: number;
  total?: number;
  vulnerabilities: Record<string, {
    name?: string;
    severity: string;
    isDirect?: boolean;
    range?: string;
    nodes?: string[];
    via: unknown[];
    fixAvailable?: FixAvailable;
  }>;
}): string {
  const high = input.high ?? Object.values(input.vulnerabilities).filter((row) => row.severity === "high").length;
  const critical = input.critical ?? Object.values(input.vulnerabilities).filter((row) => row.severity === "critical").length;
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(Object.entries(input.vulnerabilities).map(([name, row]) => [name, {
      name: row.name ?? name,
      severity: row.severity,
      isDirect: row.isDirect ?? false,
      range: row.range ?? "*",
      nodes: row.nodes ?? [`node_modules/${name}`],
      via: row.via,
      fixAvailable: row.fixAvailable ?? false,
    }])),
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high,
        critical,
        total: input.total ?? high + critical,
      },
    },
  });
}

function matchingAudit(): string {
  return auditJson({
    vulnerabilities: {
      axios: {
        severity: "high",
        via: [viaObject(1001, "axios", "high", ">=1.15.2 <1.18.0")],
      },
    },
  });
}

describe("security audit baseline policy", () => {
  it("passes when baseline findings are unchanged", () => {
    const result = evaluateAuditPolicy({
      baseline: baseline(),
      lockfileSha256: LOCK_SHA,
      auditRaw: matchingAudit(),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.codes, ["PASS"]);
    assert.equal(result.newHigh.length, 0);
    assert.equal(result.matchingHigh.length, 1);
    assert.equal(result.resolvedHigh.length, 0);
  });

  it("passes and reports when a high advisory is resolved", () => {
    const result = evaluateAuditPolicy({
      baseline: baseline(),
      lockfileSha256: LOCK_SHA,
      auditRaw: auditJson({
        high: 0,
        total: 0,
        vulnerabilities: {},
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.codes, ["PASS"]);
    assert.equal(result.resolvedHigh.length, 1);
    assert.equal(result.resolvedHigh[0]?.advisoryId, "1001");
    const document = verificationDocument(result);
    assert.equal(Array.isArray(document.resolvedHigh), true);
    assert.equal((document.resolvedHigh as unknown[]).length, 1);
  });

  it("rejects a new high advisory", () => {
    const result = evaluateAuditPolicy({
      baseline: baseline(),
      lockfileSha256: LOCK_SHA,
      auditRaw: auditJson({
        high: 2,
        total: 2,
        vulnerabilities: {
          axios: {
            severity: "high",
            via: [viaObject(1001, "axios", "high", ">=1.15.2 <1.18.0")],
          },
          ws: {
            severity: "high",
            via: [viaObject(2002, "ws", "high", ">=8.0.0 <8.21.0")],
          },
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("NEW_HIGH"));
    assert.equal(result.newHigh.some((row) => row.advisoryId === "2002"), true);
  });

  it("rejects any critical vulnerability", () => {
    const result = evaluateAuditPolicy({
      baseline: baseline(),
      lockfileSha256: LOCK_SHA,
      auditRaw: auditJson({
        high: 1,
        critical: 1,
        total: 2,
        vulnerabilities: {
          axios: {
            severity: "high",
            via: [viaObject(1001, "axios", "high", ">=1.15.2 <1.18.0")],
          },
          evil: {
            severity: "critical",
            via: [viaObject(3003, "evil", "critical", "<2.0.0")],
          },
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("CRITICAL_VULNERABILITY"));
    assert.equal(result.critical.length > 0, true);
  });

  it("rejects replacement of a high advisory id", () => {
    const result = evaluateAuditPolicy({
      baseline: baseline(),
      lockfileSha256: LOCK_SHA,
      auditRaw: auditJson({
        vulnerabilities: {
          axios: {
            severity: "high",
            via: [viaObject(1999, "axios", "high", ">=1.15.2 <1.18.0")],
          },
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("ADVISORY_REPLACED"));
    assert.equal(result.advisoryReplaced[0]?.expectedAdvisoryId, "1001");
    assert.equal(result.advisoryReplaced[0]?.actualAdvisoryId, "1999");
  });

  it("rejects a changed high-advisory dependency path", () => {
    const result = evaluateAuditPolicy({
      baseline: baseline(),
      lockfileSha256: LOCK_SHA,
      auditRaw: auditJson({
        vulnerabilities: {
          axios: {
            severity: "high",
            nodes: ["node_modules/parent/node_modules/axios"],
            via: [viaObject(1001, "axios", "high", ">=1.15.2 <1.18.0")],
          },
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("DEPENDENCY_PATH_CHANGED"));
    assert.deepEqual(result.dependencyPathChanged[0]?.actual, ["node_modules/parent/node_modules/axios"]);
  });

  it("rejects malformed audit JSON", () => {
    const parsed = parseAuditReport("{not-json");
    assert.equal(parsed.ok, false);
    if (parsed.ok) throw new Error("expected malformed");
    assert.equal(parsed.code, "AUDIT_JSON_MALFORMED");
    const result = evaluateAuditPolicy({
      baseline: baseline(),
      lockfileSha256: LOCK_SHA,
      auditRaw: "{not-json",
    });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("AUDIT_JSON_MALFORMED"));
  });

  it("rejects a missing audit file", () => {
    const missing = path.join(os.tmpdir(), `classic-grid-missing-audit-${Date.now()}.json`);
    const loaded = readAuditFile(missing);
    assert.equal(loaded.ok, false);
    if (loaded.ok) throw new Error("expected missing");
    assert.equal(loaded.code, "AUDIT_FILE_MISSING");
  });

  it("rejects a lockfile hash that does not match the baseline commitment", () => {
    const result = evaluateAuditPolicy({
      baseline: baseline(),
      lockfileSha256: "b".repeat(64),
      auditRaw: matchingAudit(),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.codes, ["LOCKFILE_HASH_MISMATCH"]);
  });

  it("does not leak environment variables, tokens, or home directory paths", () => {
    const secret = "leaked-credential-value-9f3c";
    process.env.NPM_TOKEN = secret;
    process.env.GITHUB_TOKEN = secret;
    process.env.AUTHORIZATION = `Bearer ${secret}`;
    const result = evaluateAuditPolicy({
      baseline: baseline(),
      lockfileSha256: LOCK_SHA,
      auditRaw: matchingAudit(),
    });
    const dumped = JSON.stringify(verificationDocument(result));
    assert.equal(dumped.includes(secret), false);
    assert.equal(dumped.includes("Bearer "), false);
    assert.equal(dumped.includes(os.homedir()), false);
    assert.equal(dumped.toLowerCase().includes("authorization"), false);
    const sanitized = sanitizeForArtifact(
      `${os.homedir()}/secret Authorization: Bearer ${secret}`,
      process.cwd(),
    );
    assert.equal(sanitized.includes(secret), false);
    assert.equal(sanitized.includes(os.homedir()), false);
    assert.equal(sanitized.includes(`Bearer ${secret}`), false);
    assert.match(sanitized, /authorization: \[redacted\]/i);
  });

  it("rejects audit JSON that omits required advisory fields", () => {
    const parsed = parseAuditReport(JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        axios: {
          name: "axios",
          severity: "high",
          isDirect: false,
          range: "*",
          nodes: ["node_modules/axios"],
          via: [{ name: "axios", severity: "high", range: "*" }],
          fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: { high: 1, critical: 0, total: 1 } },
    }));
    assert.equal(parsed.ok, false);
    if (parsed.ok) throw new Error("expected missing fields");
    assert.equal(parsed.code, "AUDIT_MISSING_FIELDS");
  });

  it("records advisory identity rather than only severity totals", () => {
    const committed = JSON.parse(fs.readFileSync(BASELINE_RELATIVE_PATH, "utf8")) as AuditBaseline;
    assert.equal(committed.schemaVersion, "classic-v0.2-security-audit-baseline/1");
    assert.equal(committed.lockfile.path, LOCKFILE_RELATIVE_PATH);
    assert.match(committed.lockfile.sha256, /^[0-9a-f]{64}$/);
    assert.equal(committed.lockfile.sha256, sha256File(LOCKFILE_RELATIVE_PATH));
    assert.ok(committed.highFindings.length >= 1);
    for (const row of committed.highFindings) {
      assert.match(row.advisoryId, /./);
      assert.match(row.package, /./);
      assert.equal(row.severity, "high");
      assert.equal(Array.isArray(row.dependencyPaths), true);
      assert.ok(row.dependencyPaths.length >= 1);
      assert.match(row.vulnerableRange, /./);
      assert.notEqual(row.fixAvailable, undefined);
    }
    assert.equal("high" in (committed as unknown as Record<string, unknown>), false);
  });

  it("runAuditBaseline fails closed on a missing audit file without writing secrets", () => {
    const outDir = path.join("artifacts", `security-tmp-${process.pid}`);
    const result = runAuditBaseline(process.cwd(), {
      auditJsonPath: path.join(os.tmpdir(), "classic-grid-no-such-audit.json"),
      outDir,
    });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("AUDIT_FILE_MISSING"));
    const verification = fs.readFileSync(path.join(outDir, "audit-baseline-verification.json"), "utf8");
    assert.equal(verification.includes(os.homedir()), false);
    assert.equal(verification.includes("NPM_TOKEN"), false);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("requires workflow action pins to be immutable commit SHAs", () => {
    const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    const inventory = parseActionPins(workflow);
    assert.equal(inventory.persistCredentials, false);
    assert.equal(inventory.fetchDepth, 0);
    const names = inventory.pins.map((pin) => pin.action).sort();
    assert.deepEqual([...new Set(names)], ["actions/checkout", "actions/setup-node", "actions/upload-artifact"].sort());
    for (const pin of inventory.pins) {
      assert.match(pin.commitSha, /^[0-9a-f]{40}$/);
      assert.match(pin.version, /^v4\.\d+\.\d+$/);
    }
    assert.equal(workflow.includes("actions/checkout@v4"), false);
    assert.equal(workflow.includes("actions/setup-node@v4"), false);
    assert.equal(workflow.includes("actions/upload-artifact@v4"), false);
  });
});
