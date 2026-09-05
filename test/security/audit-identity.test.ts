import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  BASELINE_RELATIVE_PATH,
  evaluateAuditPolicy,
  parseAuditReport,
  type AuditBaseline,
  type HighFinding,
} from "../../scripts/security/audit-policy.js";

// Synthetic minimal reports preserve the observed GHSA/source renumbering pair;
// they are fixtures, not replacement live evidence or historical audit captures.
const AXIOS_GHSA = "GHSA-gcfj-64vw-6mp9";
const OTHER_GHSA = "GHSA-aaaa-bbbb-cccc";
const TOML_GHSAS = ["GHSA-82x6-q7mm-w9cf", "GHSA-v5mp-jgw5-2x6j"];
const committed = JSON.parse(fs.readFileSync(BASELINE_RELATIVE_PATH, "utf8")) as AuditBaseline;
const axiosFinding = committed.highFindings.find((row) => row.package === "axios")!;
const axiosPackage = committed.highPackages.find((row) => row.package === "axios")!;

function baseline(): AuditBaseline {
  return structuredClone({ ...committed, highFindings: [axiosFinding], highPackages: [axiosPackage] });
}

function leaf(ghsaId: string | null = AXIOS_GHSA, source = 1123967, name = "axios", range = axiosFinding.vulnerableRange) {
  return { source, name, dependency: name, severity: "high", range, url: ghsaId ? `https://github.com/advisories/${ghsaId}` : "https://example.invalid/no-stable-identity" };
}

function pkg(name = "axios", via: unknown[] = [leaf()], nodes = [`node_modules/${name}`]) {
  return { name, severity: "high", isDirect: false, range: name === "axios" ? axiosPackage.vulnerableRange : "*", nodes, via, fixAvailable: false };
}

function report(vulnerabilities: Record<string, ReturnType<typeof pkg>>) {
  const high = Object.keys(vulnerabilities).length;
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical: 0, total: high } } });
}

function evaluate(vulnerabilities: Record<string, ReturnType<typeof pkg>>, accepted = baseline()) {
  return evaluateAuditPolicy({ baseline: accepted, lockfileSha256: accepted.lockfile.sha256, auditRaw: report(vulnerabilities) });
}

describe("stable audit advisory identity fixtures", () => {
  it("the current Axios source renumbering is non-blocking and reported exactly once", () => {
    const result = evaluate({ axios: pkg("axios", [leaf(AXIOS_GHSA, 1153178)]) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.codes, ["ADVISORY_SOURCE_RENUMBERED"]);
    assert.equal(result.newHigh.length, 0);
    assert.equal(result.advisoryReplaced.length, 0);
    assert.equal(result.matchingHigh.length, 1);
    assert.equal(result.resolvedHigh.length, 0);
    assert.deepEqual(result.advisorySourceRenumbered, [{ package: "axios", ghsaId: AXIOS_GHSA, expectedSourceId: "1123967", actualSourceId: "1153178" }]);
  });

  it("changed GHSA with an unchanged numeric source is blocking NEW_HIGH and one replacement", () => {
    const changed = leaf(OTHER_GHSA);
    const result = evaluate({ axios: pkg("axios", [changed, { ...changed }]) });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("NEW_HIGH"));
    assert.ok(result.codes.includes("ADVISORY_REPLACED"));
    assert.equal(result.newHigh.length, 1);
    assert.equal(result.advisoryReplaced.length, 1);
    assert.equal(result.advisoryReplaced[0]?.actualGhsaId, OTHER_GHSA);
    assert.equal(result.advisorySourceRenumbered.length, 0);
  });

  it("an additional high GHSA in an existing package is NEW_HIGH without a replacement", () => {
    const result = evaluate({ axios: pkg("axios", [leaf(), leaf(OTHER_GHSA, 9999)]) });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("NEW_HIGH"));
    assert.deepEqual(result.newHigh.map((row) => row.ghsaId), [OTHER_GHSA]);
    assert.equal(result.advisoryReplaced.length, 0);
    assert.equal(result.matchingHigh.length, 1);
  });

  it("missing GHSA fails explicitly even when the numeric source still matches", () => {
    const result = evaluate({ axios: pkg("axios", [leaf(null)]) });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("ADVISORY_IDENTITY_MISSING"));
    assert.ok(result.advisoryIdentityMissing.some((row) => row.reason === "GHSA_MISSING_OR_INVALID"));
    assert.equal(result.matchingHigh.length, 0);
    assert.equal(result.resolvedHigh.length, 0);
  });

  it("malformed GHSA cannot be accepted as a stable identity", () => {
    const result = evaluate({ axios: pkg("axios", [leaf("GHSA-test-partial")]) });
    assert.equal(result.ok, false);
    assert.ok(result.advisoryIdentityMissing.some((row) => row.reason === "GHSA_MISSING_OR_INVALID"));
  });

  it("a baseline missing GHSA fails closed without falling back to numeric matching", () => {
    const accepted = baseline();
    accepted.highFindings[0]!.ghsaId = null;
    const result = evaluate({ axios: pkg() }, accepted);
    assert.equal(result.ok, false);
    assert.ok(result.advisoryIdentityMissing.some((row) => row.reason === "BASELINE_GHSA_MISSING_OR_INVALID"));
  });

  it("changed dependency path remains blocking under source renumbering", () => {
    const result = evaluate({ axios: pkg("axios", [leaf(AXIOS_GHSA, 1153178)], ["node_modules/parent/node_modules/axios"]) });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("DEPENDENCY_PATH_CHANGED"));
    assert.equal(result.dependencyPathChanged.length, 1);
    assert.equal(result.newHigh.length, 0);
    assert.equal(result.matchingHigh.length, 0);
  });

  it("package identity changes remain blocking even when GHSA and source match", () => {
    const result = evaluate({ renamed: pkg("renamed", [leaf(AXIOS_GHSA, 1123967, "renamed")]) });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("PACKAGE_IDENTITY_CHANGED"));
    assert.equal(result.packageIdentityChanged.length, 1);
  });

  it("a leaf object cannot borrow the enclosing aggregate package's paths", () => {
    const result = evaluate({ parent: pkg("parent", [leaf()]) });
    assert.equal(result.ok, false);
    assert.deepEqual(result.codes, ["PACKAGE_IDENTITY_CHANGED"]);
  });

  it("changed leaf vulnerable range is reported explicitly and remains blocking", () => {
    const result = evaluate({ axios: pkg("axios", [leaf(AXIOS_GHSA, 1123967, "axios", "<99.0.0")]) });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("VULNERABLE_RANGE_CHANGED"));
    assert.deepEqual(result.vulnerableRangeChanged, [{ advisoryId: AXIOS_GHSA, package: "axios", expected: axiosFinding.vulnerableRange, actual: "<99.0.0" }]);
    assert.equal(result.newHigh.length, 0);
  });

  it("changed affected-package range remains independently blocking", () => {
    const changed = pkg();
    changed.range = "<99.0.0";
    const result = evaluate({ axios: changed });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("VULNERABLE_RANGE_CHANGED"));
  });

  it("identical leaf rows produce one unique parsed finding and one source-renumbering diagnostic", () => {
    const same = leaf(AXIOS_GHSA, 1153178);
    const raw = report({ axios: pkg("axios", [same, { ...same }]) });
    const parsed = parseAuditReport(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("fixture parsing failed");
    assert.equal(parsed.highFindings.length, 1);
    const result = evaluate({ axios: pkg("axios", [same, { ...same }]) });
    assert.equal(result.ok, true);
    assert.equal(result.matchingHigh.length, 1);
    assert.equal(result.advisorySourceRenumbered.length, 1);
  });

  it("affected-package aggregates do not create additional advisory findings", () => {
    const result = evaluate({ axios: pkg(), parent: pkg("parent", ["axios", "axios"]) });
    assert.equal(result.ok, false); // A newly affected package is independently fail-closed.
    assert.ok(result.codes.includes("AFFECTED_PACKAGE_ADDED"));
    assert.equal(result.newHigh.length, 0);
    assert.equal(result.matchingHigh.length, 1);
    assert.equal(result.affectedPackageAdded.length, 1);
  });

  it("an aggregate-only cycle without any reachable GHSA fails closed", () => {
    const result = evaluate({ a: pkg("a", ["b"]), b: pkg("b", ["a"]) });
    assert.equal(result.ok, false);
    assert.ok(result.advisoryIdentityMissing.some((row) => row.reason === "NO_REACHABLE_HIGH_GHSA"));
    assert.equal(result.newHigh.length, 0);
  });

  it("both new toml GHSAs remain exactly two blocking NEW_HIGH leaves despite duplicates and propagation", () => {
    const tomlLeaves = TOML_GHSAS.map((ghsa, i) => leaf(ghsa, 1164824 + i, "toml", i === 0 ? "<4.2.0" : "<4.1.2"));
    const result = evaluate({
      axios: pkg("axios", [leaf(AXIOS_GHSA, 1153178)]),
      toml: pkg("toml", [...tomlLeaves, ...tomlLeaves]),
      "@coral-xyz/anchor": pkg("@coral-xyz/anchor", ["toml"]),
    });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes("NEW_HIGH"));
    assert.deepEqual(result.newHigh.map((row) => row.ghsaId).sort(), [...TOML_GHSAS].sort());
    assert.equal(result.newHigh.length, 2);
    assert.equal(result.advisoryReplaced.length, 0);
    assert.equal(result.advisorySourceRenumbered.length, 1);
    assert.equal(result.advisoryIdentityMissing.length, 0);
  });

  it("the committed accepted set still contains only its original three leaves and fourteen affected packages", () => {
    const identities = committed.highFindings.map((row: HighFinding) => [row.package, row.ghsaId]);
    assert.deepEqual(identities, [["axios", AXIOS_GHSA], ["bigint-buffer", "GHSA-3gc7-fjrx-p6mg"], ["ws", "GHSA-96hv-2xvq-fx4p"]]);
    assert.equal(committed.highPackages.length, 14);
    assert.equal(committed.highFindings.some((row) => TOML_GHSAS.includes(row.ghsaId ?? "")), false);
  });
});
