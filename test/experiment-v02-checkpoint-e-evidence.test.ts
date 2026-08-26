import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRANCH,
  CHECKPOINT_E_CASE_IDS,
  DEFAULT_EVIDENCE_COMMAND,
  DEFAULT_PRECHECK_COMMAND,
  EvidenceError,
  MIN_PROJECT_SUITE_TOTAL,
  collectFileHashes,
  defaultProjectTapCommand,
  generateEvidenceFromRun,
  parseCheckpointETap,
  renderCheckpointETap,
  renderProjectTap,
  verifyEvidence,
  type EvidenceIdentity,
  type GenerateMeta,
} from "../tools/checkpoint-e-evidence.js";

const SOURCE_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_TREE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MERGE_SHA = "dddddddddddddddddddddddddddddddddddddddd";
const MERGE_TREE = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const BASE_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const OTHER_SHA = "ffffffffffffffffffffffffffffffffffffffff";

function passingCheckpointTap() {
  return renderCheckpointETap({
    cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id, title: `${id} fixture` })),
  });
}

function passingProjectTap(total = MIN_PROJECT_SUITE_TOTAL) {
  return renderProjectTap({ tests: total, pass: total });
}

function pushIdentity(overrides: Partial<EvidenceIdentity> = {}): EvidenceIdentity {
  return {
    sourceHeadSha: SOURCE_HEAD,
    sourceHeadTreeSha: SOURCE_TREE,
    testedCheckoutSha: SOURCE_HEAD,
    testedCheckoutTreeSha: SOURCE_TREE,
    baseSha: BASE_SHA,
    githubEventName: "push",
    githubRunId: "1",
    githubRunAttempt: "1",
    githubJobId: "compiler-and-tests",
    ...overrides,
  };
}

function meta(overrides: Partial<GenerateMeta> = {}): GenerateMeta {
  return {
    branch: BRANCH,
    identity: pushIdentity(),
    toolchain: { nodeVersion: "v22.23.2", npmVersion: "10.9.8" },
    checkpoint: { command: DEFAULT_EVIDENCE_COMMAND, processExitCode: 0 },
    project: {
      command: defaultProjectTapCommand(),
      processExitCode: 0,
      preCheck: { command: DEFAULT_PRECHECK_COMMAND, processExitCode: 0 },
    },
    generatedAt: "2026-08-25T00:00:00.000Z",
    fileHashes: collectFileHashes(),
    ...overrides,
  };
}

function generatePassing(overrides: Partial<GenerateMeta> = {}) {
  return generateEvidenceFromRun({
    checkpointTap: passingCheckpointTap(),
    projectTap: passingProjectTap(),
    meta: meta(overrides),
  });
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
  it("derives each E-01..E-30 result from TAP and keeps projectSuite distinct", () => {
    const checkpointTap = passingCheckpointTap();
    const parsed = parseCheckpointETap(checkpointTap);
    assert.equal(parsed.cases.length, 30);
    assert.deepEqual(parsed.cases.map((row) => row.caseId), [...CHECKPOINT_E_CASE_IDS]);
    assert.deepEqual(parsed.cases.map((row) => row.outcome), CHECKPOINT_E_CASE_IDS.map(() => "PASS"));
    const evidence = generateEvidenceFromRun({
      checkpointTap,
      projectTap: passingProjectTap(),
      meta: meta(),
    });
    assert.equal(evidence.schemaVersion, "classic-v0.2-checkpoint-e/3");
    assert.equal(evidence.checkpointSuite.testCases[8]!.caseId, "E-09");
    assert.equal(evidence.checkpointSuite.testCases[8]!.result, parsed.cases[8]!.outcome);
    assert.equal(evidence.checkpointSuite.testCases[8]!.result, "PASS");
    assert.equal(evidence.checkpointSuite.total, 30);
    assert.equal(evidence.checkpointSuite.pass, 30);
    assert.equal(evidence.checkpointSuite.fail, 0);
    assert.equal(evidence.checkpointSuite.processExitCode, 0);
    assert.ok(evidence.projectSuite.total >= MIN_PROJECT_SUITE_TOTAL);
    assert.equal(evidence.projectSuite.pass, evidence.projectSuite.total);
    assert.notEqual(evidence.projectSuite.total, evidence.checkpointSuite.total);
    assert.notEqual(evidence.projectSuite.command, evidence.checkpointSuite.command);
    assert.equal(evidence.safety.liveExchangeWrite, false);
    assert.equal(evidence.safety.productionCredentialUsed, false);
    const verified = verifyEvidence(evidence, {
      identity: evidence.identity,
      fileHashes: evidence.fileHashes,
      branch: evidence.branch,
    });
    assert.equal(verified.identity.sourceHeadSha, SOURCE_HEAD);
    assert.equal(verified.identity.testedCheckoutSha, SOURCE_HEAD);
    assert.equal(verified.projectSuite.preCheck.processExitCode, 0);
  });

  it("rejects projectSuite FAIL when checkpointSuite is 30/30 PASS", () => {
    const checkpointTap = passingCheckpointTap();
    const parsed = parseCheckpointETap(checkpointTap);
    assert.equal(parsed.totals.pass, 30);
    assert.equal(parsed.totals.fail, 0);
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap,
      projectTap: renderProjectTap({
        tests: MIN_PROJECT_SUITE_TOTAL,
        pass: MIN_PROJECT_SUITE_TOTAL - 1,
        fail: 1,
      }),
      meta: meta(),
    })), "SUITE_FAILED");
    const broken = generatePassing();
    broken.projectSuite.fail = 1;
    broken.projectSuite.pass = broken.projectSuite.total - 1;
    assert.equal(codeOf(() => verifyEvidence(broken, {
      identity: broken.identity,
      fileHashes: broken.fileHashes,
      branch: broken.branch,
    })), "SUITE_FAILED");
  });

  it("rejects nonzero projectSuite processExitCode", () => {
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: passingCheckpointTap(),
      projectTap: passingProjectTap(),
      meta: meta({ project: { ...meta().project, processExitCode: 1 } }),
    })), "PROCESS_NONZERO_EXIT");
    const broken = generatePassing();
    broken.projectSuite.processExitCode = 2;
    assert.equal(codeOf(() => verifyEvidence(broken, {
      identity: broken.identity,
      fileHashes: broken.fileHashes,
      branch: broken.branch,
    })), "PROCESS_NONZERO_EXIT");
  });

  it("rejects SKIP in either suite", () => {
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: renderCheckpointETap({
        cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id, skip: id === "E-12" })),
      }),
      projectTap: passingProjectTap(),
      meta: meta(),
    })), "CASE_SKIPPED");
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: passingCheckpointTap(),
      projectTap: renderProjectTap({
        tests: MIN_PROJECT_SUITE_TOTAL,
        pass: MIN_PROJECT_SUITE_TOTAL - 1,
        skipped: 1,
      }),
      meta: meta(),
    })), "SUITE_SKIPPED");
  });

  it("rejects TODO in either suite", () => {
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: renderCheckpointETap({
        cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id, todo: id === "E-07" })),
      }),
      projectTap: passingProjectTap(),
      meta: meta(),
    })), "CASE_TODO");
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: passingCheckpointTap(),
      projectTap: renderProjectTap({
        tests: MIN_PROJECT_SUITE_TOTAL,
        pass: MIN_PROJECT_SUITE_TOTAL - 1,
        todo: 1,
      }),
      meta: meta(),
    })), "SUITE_TODO");
  });

  it("rejects CANCELLED in either suite", () => {
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: renderCheckpointETap({
        cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id, cancelled: id === "E-04" })),
      }),
      projectTap: passingProjectTap(),
      meta: meta(),
    })), "CASE_CANCELLED");
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: passingCheckpointTap(),
      projectTap: renderProjectTap({
        tests: MIN_PROJECT_SUITE_TOTAL,
        pass: MIN_PROJECT_SUITE_TOTAL - 1,
        cancelled: 1,
      }),
      meta: meta(),
    })), "SUITE_CANCELLED");
  });

  it("rejects a missing E-case", () => {
    const tap = renderCheckpointETap({
      cases: CHECKPOINT_E_CASE_IDS.filter((id) => id !== "E-26").map((id) => ({ id })),
    });
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: tap,
      projectTap: passingProjectTap(),
      meta: meta(),
    })), "MISSING_CASE");
  });

  it("rejects a duplicate E-case", () => {
    const tap = renderCheckpointETap({
      cases: [...CHECKPOINT_E_CASE_IDS, "E-01"].map((id) => ({ id })),
      totals: { tests: 31, pass: 31, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
    });
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: tap,
      projectTap: passingProjectTap(),
      meta: meta(),
    })), "DUPLICATE_CASE");
  });

  it("rejects an unexpected E-case", () => {
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: renderCheckpointETap({
        cases: [...CHECKPOINT_E_CASE_IDS, "E-31"].map((id) => ({ id })),
        totals: { tests: 31, pass: 31, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
      }),
      projectTap: passingProjectTap(),
      meta: meta(),
    })), "UNEXPECTED_CASE");
  });

  it("rejects sourceHeadSha mismatch", () => {
    const evidence = generatePassing();
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      identity: { ...evidence.identity, sourceHeadSha: OTHER_SHA },
      fileHashes: evidence.fileHashes,
      branch: evidence.branch,
    })), "STALE_SOURCE_HEAD_SHA");
  });

  it("rejects sourceHeadTreeSha mismatch", () => {
    const evidence = generatePassing();
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      identity: { ...evidence.identity, sourceHeadTreeSha: OTHER_SHA },
      fileHashes: evidence.fileHashes,
      branch: evidence.branch,
    })), "STALE_SOURCE_HEAD_TREE");
  });

  it("rejects testedCheckoutSha and tree mismatch", () => {
    const evidence = generatePassing();
    const hashes = evidence.fileHashes;
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      identity: { ...evidence.identity, testedCheckoutSha: OTHER_SHA },
      fileHashes: hashes,
      branch: evidence.branch,
    })), "STALE_TESTED_CHECKOUT_SHA");
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      identity: { ...evidence.identity, testedCheckoutTreeSha: OTHER_SHA },
      fileHashes: hashes,
      branch: evidence.branch,
    })), "STALE_TESTED_CHECKOUT_TREE");
  });

  it("rejects targeted 30-case TAP copied into projectSuite", () => {
    const checkpointTap = passingCheckpointTap();
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap,
      projectTap: checkpointTap,
      meta: meta(),
    })), "PROJECT_SUITE_IS_CHECKPOINT");
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap,
      projectTap: passingProjectTap(),
      meta: meta({
        project: {
          command: DEFAULT_EVIDENCE_COMMAND,
          processExitCode: 0,
          preCheck: { command: DEFAULT_PRECHECK_COMMAND, processExitCode: 0 },
        },
      }),
    })), "PROJECT_SUITE_IS_CHECKPOINT");
    const broken = generatePassing();
    broken.projectSuite.total = 30;
    broken.projectSuite.pass = 30;
    broken.projectSuite.fail = 0;
    broken.projectSuite.skip = 0;
    broken.projectSuite.cancelled = 0;
    broken.projectSuite.todo = 0;
    assert.equal(codeOf(() => verifyEvidence(broken, {
      identity: broken.identity,
      fileHashes: broken.fileHashes,
      branch: broken.branch,
    })), "PROJECT_SUITE_IS_CHECKPOINT");
  });

  it("rejects totals that do not equal outcome sums", () => {
    const tap = renderCheckpointETap({
      cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id })),
      totals: { tests: 30, pass: 29, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
    });
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: tap,
      projectTap: passingProjectTap(),
      meta: meta(),
    })), "MALFORMED_TOTALS");
    const broken = generatePassing();
    broken.checkpointSuite.pass = 29;
    broken.checkpointSuite.fail = 0;
    broken.checkpointSuite.skip = 0;
    broken.checkpointSuite.cancelled = 0;
    broken.checkpointSuite.todo = 0;
    broken.checkpointSuite.total = 30;
    assert.equal(codeOf(() => verifyEvidence(broken, {
      identity: broken.identity,
      fileHashes: broken.fileHashes,
      branch: broken.branch,
    })), "MALFORMED_TOTALS");
    const mismatch = generatePassing();
    mismatch.checkpointSuite.testCases[0] = {
      ...mismatch.checkpointSuite.testCases[0]!,
      result: "FAIL",
    };
    assert.equal(codeOf(() => verifyEvidence(mismatch, {
      identity: mismatch.identity,
      fileHashes: mismatch.fileHashes,
      branch: mismatch.branch,
    })), "TOTALS_MISMATCH");
  });

  it("rejects pull_request identity that confuses source head with merge SHA", () => {
    assert.equal(codeOf(() => generatePassing({
      identity: pushIdentity({ githubEventName: "pull_request" }),
    })), "IDENTITY_COLLISION");
    const distinct = generatePassing({
      identity: pushIdentity({
        githubEventName: "pull_request",
        testedCheckoutSha: MERGE_SHA,
        testedCheckoutTreeSha: MERGE_TREE,
      }),
    });
    assert.notEqual(distinct.identity.sourceHeadSha, distinct.identity.testedCheckoutSha);
    verifyEvidence(distinct, {
      identity: distinct.identity,
      fileHashes: distinct.fileHashes,
      branch: distinct.branch,
    });
    const confused = generatePassing();
    confused.identity = {
      ...confused.identity,
      githubEventName: "pull_request",
      testedCheckoutSha: confused.identity.sourceHeadSha,
      testedCheckoutTreeSha: confused.identity.sourceHeadTreeSha,
    };
    assert.equal(codeOf(() => verifyEvidence(confused, {
      identity: confused.identity,
      fileHashes: confused.fileHashes,
      branch: confused.branch,
    })), "IDENTITY_COLLISION");
  });
});
