import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHECKPOINT_E_CASE_IDS,
  DEFAULT_EVIDENCE_COMMAND,
  EvidenceError,
  collectFileHashes,
  generateEvidenceFromRun,
  parseCheckpointETap,
  renderCheckpointETap,
  verifyEvidence,
  type GenerateMeta,
} from "../tools/checkpoint-e-evidence.js";

const TESTED_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TESTED_TREE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function passingTap() {
  return renderCheckpointETap({
    cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id, title: `${id} fixture` })),
  });
}

function meta(overrides: Partial<GenerateMeta> = {}): GenerateMeta {
  return {
    branch: "experiment/classic-v0.2-100u-safety",
    testedCommitSha: TESTED_COMMIT,
    testedTreeSha: TESTED_TREE,
    nodeVersion: "v22.23.2",
    npmVersion: "10.9.8",
    command: DEFAULT_EVIDENCE_COMMAND,
    processExitCode: 0,
    generatedAt: "2026-08-24T00:00:00.000Z",
    fileHashes: collectFileHashes(),
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EvidenceError) return error.code;
    throw error;
  }
  throw new Error("expected EvidenceError");
}

describe("Checkpoint E evidence generator and verifier", () => {
  it("derives each E-01..E-30 result from TAP outcome lines", () => {
    const tap = passingTap();
    const parsed = parseCheckpointETap(tap);
    assert.equal(parsed.cases.length, 30);
    assert.deepEqual(parsed.cases.map((row) => row.caseId), [...CHECKPOINT_E_CASE_IDS]);
    assert.deepEqual(parsed.cases.map((row) => row.outcome), CHECKPOINT_E_CASE_IDS.map(() => "PASS"));
    const evidence = generateEvidenceFromRun(tap, meta());
    assert.equal(evidence.testCases[8]!.caseId, "E-09");
    assert.equal(evidence.testCases[8]!.result, parsed.cases[8]!.outcome);
    assert.equal(evidence.testCases[8]!.result, "PASS");
    assert.equal(evidence.eCases.total, 30);
    assert.equal(evidence.eCases.pass, 30);
    assert.equal(evidence.eCases.fail, 0);
    assert.equal(evidence.fullSuite.total, 30);
    assert.equal(evidence.processExitCode, 0);
    assert.equal(evidence.liveExchangeWrite, false);
    assert.equal(evidence.productionCredentialUsed, false);
    const verified = verifyEvidence(evidence, {
      testedCommitSha: TESTED_COMMIT,
      testedTreeSha: TESTED_TREE,
      fileHashes: evidence.fileHashes,
      branch: evidence.branch,
    });
    assert.equal(verified.testedCommitSha, TESTED_COMMIT);
    assert.equal(verified.testedTreeSha, TESTED_TREE);
  });

  it("rejects a missing E-case", () => {
    const tap = renderCheckpointETap({
      cases: CHECKPOINT_E_CASE_IDS.filter((id) => id !== "E-26").map((id) => ({ id })),
    });
    assert.equal(codeOf(() => generateEvidenceFromRun(tap, meta())), "MISSING_CASE");
  });

  it("rejects a duplicate E-case", () => {
    const tap = renderCheckpointETap({
      cases: [...CHECKPOINT_E_CASE_IDS, "E-01"].map((id) => ({ id })),
      totals: { tests: 31, pass: 31, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
    });
    assert.equal(codeOf(() => generateEvidenceFromRun(tap, meta())), "DUPLICATE_CASE");
  });

  it("rejects a failed E-case instead of synthesizing PASS", () => {
    const tap = renderCheckpointETap({
      cases: CHECKPOINT_E_CASE_IDS.map((id) => ({
        id,
        ok: id !== "E-09",
        title: `${id} fixture`,
      })),
    });
    const parsed = parseCheckpointETap(tap);
    assert.equal(parsed.cases[8]!.caseId, "E-09");
    assert.equal(parsed.cases[8]!.outcome, "FAIL");
    assert.equal(codeOf(() => generateEvidenceFromRun(tap, meta())), "CASE_FAILED");
  });

  it("rejects a skipped E-case", () => {
    const tap = renderCheckpointETap({
      cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id, skip: id === "E-12" })),
    });
    assert.equal(codeOf(() => generateEvidenceFromRun(tap, meta())), "CASE_SKIPPED");
  });

  it("rejects stale tested commit SHA and tree SHA", () => {
    const evidence = generateEvidenceFromRun(passingTap(), meta());
    const hashes = evidence.fileHashes;
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      testedCommitSha: "cccccccccccccccccccccccccccccccccccccccc",
      testedTreeSha: TESTED_TREE,
      fileHashes: hashes,
      branch: evidence.branch,
    })), "STALE_TESTED_SHA");
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      testedCommitSha: TESTED_COMMIT,
      testedTreeSha: "dddddddddddddddddddddddddddddddddddddddd",
      fileHashes: hashes,
      branch: evidence.branch,
    })), "STALE_TESTED_TREE");
  });

  it("rejects malformed totals", () => {
    const evidence = generateEvidenceFromRun(passingTap(), meta());
    const broken = {
      ...evidence,
      eCases: { ...evidence.eCases, pass: 29, fail: 0, skip: 0, cancelled: 0, todo: 0, total: 30 },
    };
    assert.equal(codeOf(() => verifyEvidence(broken, {
      testedCommitSha: TESTED_COMMIT,
      testedTreeSha: TESTED_TREE,
      fileHashes: evidence.fileHashes,
      branch: evidence.branch,
    })), "MALFORMED_TOTALS");
    const tap = renderCheckpointETap({
      cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id })),
      totals: { tests: 30, pass: 29, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
    });
    assert.equal(codeOf(() => generateEvidenceFromRun(tap, meta())), "MALFORMED_TOTALS");
  });

  it("rejects unexpected, cancelled, todo, and nonzero-exit runs", () => {
    assert.equal(codeOf(() => generateEvidenceFromRun(
      renderCheckpointETap({
        cases: [...CHECKPOINT_E_CASE_IDS, "E-31"].map((id) => ({ id })),
        totals: { tests: 31, pass: 31, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
      }),
      meta(),
    )), "UNEXPECTED_CASE");
    assert.equal(codeOf(() => generateEvidenceFromRun(
      renderCheckpointETap({
        cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id, cancelled: id === "E-04" })),
      }),
      meta(),
    )), "CASE_CANCELLED");
    assert.equal(codeOf(() => generateEvidenceFromRun(
      renderCheckpointETap({
        cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id, todo: id === "E-07" })),
      }),
      meta(),
    )), "CASE_TODO");
    assert.equal(codeOf(() => generateEvidenceFromRun(passingTap(), meta({ processExitCode: 1 }))), "PROCESS_NONZERO_EXIT");
  });
});
