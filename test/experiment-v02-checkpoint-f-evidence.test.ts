import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BASE_SHA_ENV,
  BRANCH,
  CHECKPOINT_F_CASE_IDS,
  DEFAULT_EVIDENCE_COMMAND,
  DEFAULT_PRECHECK_COMMAND,
  EvidenceError,
  MIN_PROJECT_SUITE_TOTAL,
  SOURCE_HEAD_SHA_ENV,
  assertRecordedTreesMatchGit,
  collectFileHashes,
  defaultProjectTapCommand,
  generateEvidenceFromRun,
  parseCheckpointFTap,
  renderCheckpointFTap,
  renderProjectTap,
  resolveEvidenceIdentity,
  verifyEvidence,
  type EvidenceIdentity,
  type GenerateMeta,
} from "../tools/checkpoint-f-evidence.js";

const SOURCE_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_TREE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MERGE_SHA = "dddddddddddddddddddddddddddddddddddddddd";
const MERGE_TREE = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const BASE_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const OTHER_SHA = "ffffffffffffffffffffffffffffffffffffffff";

function passingCheckpointTap() {
  return renderCheckpointFTap({
    cases: CHECKPOINT_F_CASE_IDS.map((id) => ({ id, title: `${id} fixture` })),
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initIdentityRepo(): {
  dir: string;
  baseSha: string;
  sourceSha: string;
  sourceTree: string;
  mergeSha: string;
  mergeTree: string;
  unrelatedSha: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-f-id-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "review@example.test"]);
  git(dir, ["config", "user.name", "classic-grid-review"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "advice.detachedHead", "false"]);
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, ["add", "base.txt"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", "-b", "source"]);
  fs.writeFileSync(path.join(dir, "source.txt"), "source\n");
  git(dir, ["add", "source.txt"]);
  git(dir, ["commit", "-q", "-m", "source"]);
  const sourceSha = git(dir, ["rev-parse", "HEAD"]);
  const sourceTree = git(dir, ["rev-parse", "HEAD^{tree}"]);
  git(dir, ["checkout", "-q", "--orphan", "unrelated"]);
  git(dir, ["rm", "-q", "-rf", "."]);
  fs.writeFileSync(path.join(dir, "other.txt"), "other\n");
  git(dir, ["add", "other.txt"]);
  git(dir, ["commit", "-q", "-m", "unrelated"]);
  const unrelatedSha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["merge", "-q", "--no-ff", "source", "-m", "merge source"]);
  const mergeSha = git(dir, ["rev-parse", "HEAD"]);
  const mergeTree = git(dir, ["rev-parse", "HEAD^{tree}"]);
  return { dir, baseSha, sourceSha, sourceTree, mergeSha, mergeTree, unrelatedSha };
}

describe("Checkpoint F evidence generator and verifier", () => {
  it("derives each F-01..F-40 result from TAP and keeps projectSuite distinct", () => {
    const checkpointTap = passingCheckpointTap();
    const parsed = parseCheckpointFTap(checkpointTap);
    assert.equal(parsed.cases.length, 40);
    assert.deepEqual(parsed.cases.map((row) => row.caseId), [...CHECKPOINT_F_CASE_IDS]);
    const evidence = generateEvidenceFromRun({
      checkpointTap,
      projectTap: passingProjectTap(),
      meta: meta(),
    });
    assert.equal(evidence.schemaVersion, "classic-v0.2-checkpoint-f/2");
    assert.equal("requestedVerdict" in evidence, false);
    assert.equal(evidence.checkpointSuite.total, 40);
    assert.equal(evidence.checkpointSuite.pass, 40);
    assert.ok(evidence.projectSuite.total >= MIN_PROJECT_SUITE_TOTAL);
    assert.notEqual(evidence.projectSuite.total, evidence.checkpointSuite.total);
    assert.notEqual(evidence.projectSuite.command, evidence.checkpointSuite.command);
    assert.equal(evidence.safety.liveExchangeWrite, false);
    verifyEvidence(evidence, {
      identity: evidence.identity,
      fileHashes: evidence.fileHashes,
      branch: evidence.branch,
    });
  });

  it("rejects SKIP, TODO, missing, and identity-collision artifacts", () => {
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: renderCheckpointFTap({
        cases: CHECKPOINT_F_CASE_IDS.map((id) => ({ id, skip: id === "F-12" })),
      }),
      projectTap: passingProjectTap(),
      meta: meta(),
    })), "CASE_SKIPPED");
    assert.equal(codeOf(() => generateEvidenceFromRun({
      checkpointTap: renderCheckpointFTap({
        cases: CHECKPOINT_F_CASE_IDS.filter((id) => id !== "F-40").map((id) => ({ id })),
      }),
      projectTap: passingProjectTap(),
      meta: meta(),
    })), "MISSING_CASE");
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

  it("rejects source and tested tree mismatches independently", () => {
    const evidence = generatePassing();
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      identity: { ...evidence.identity, sourceHeadTreeSha: OTHER_SHA },
      fileHashes: evidence.fileHashes,
      branch: evidence.branch,
    })), "STALE_SOURCE_HEAD_TREE");
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      identity: { ...evidence.identity, testedCheckoutTreeSha: OTHER_SHA },
      fileHashes: evidence.fileHashes,
      branch: evidence.branch,
    })), "STALE_TESTED_CHECKOUT_TREE");
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      identity: { ...evidence.identity, sourceHeadSha: OTHER_SHA },
      fileHashes: evidence.fileHashes,
      branch: evidence.branch,
    })), "STALE_SOURCE_HEAD_SHA");
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      identity: { ...evidence.identity, testedCheckoutSha: OTHER_SHA },
      fileHashes: evidence.fileHashes,
      branch: evidence.branch,
    })), "STALE_TESTED_CHECKOUT_SHA");
  });

  it("rejects a legacy self-ACCEPT requestedVerdict field", () => {
    const evidence = generatePassing() as Record<string, unknown>;
    evidence.requestedVerdict = "ACCEPT";
    assert.equal(codeOf(() => verifyEvidence(evidence, {
      identity: evidence.identity as EvidenceIdentity,
      fileHashes: evidence.fileHashes as Record<string, string>,
      branch: String(evidence.branch),
    })), "SCHEMA_INVALID");
  });
});

describe("Checkpoint F evidence identity resolution", () => {
  it("separates pull_request source head from the merge checkout", () => {
    const repo = initIdentityRepo();
    git(repo.dir, ["checkout", "-q", "--detach", repo.mergeSha]);
    const identity = resolveEvidenceIdentity(repo.dir, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: repo.mergeSha,
      [SOURCE_HEAD_SHA_ENV]: repo.sourceSha,
      [BASE_SHA_ENV]: repo.baseSha,
      GITHUB_RUN_ID: "32795629341",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "compiler-and-tests",
    });
    assert.equal(identity.githubEventName, "pull_request");
    assert.equal(identity.sourceHeadSha, repo.sourceSha);
    assert.equal(identity.sourceHeadTreeSha, repo.sourceTree);
    assert.equal(identity.testedCheckoutSha, repo.mergeSha);
    assert.equal(identity.testedCheckoutTreeSha, repo.mergeTree);
    assert.notEqual(identity.sourceHeadSha, identity.testedCheckoutSha);
    assert.equal(identity.baseSha, repo.baseSha);
    assertRecordedTreesMatchGit(repo.dir, identity);
  });

  it("treats a direct push checkout as source and tested identity", () => {
    const repo = initIdentityRepo();
    git(repo.dir, ["checkout", "-q", "--detach", repo.sourceSha]);
    const identity = resolveEvidenceIdentity(repo.dir, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_SHA: repo.sourceSha,
      [SOURCE_HEAD_SHA_ENV]: repo.sourceSha,
      [BASE_SHA_ENV]: repo.baseSha,
      GITHUB_RUN_ID: "2",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "compiler-and-tests",
    });
    assert.equal(identity.githubEventName, "push");
    assert.equal(identity.sourceHeadSha, repo.sourceSha);
    assert.equal(identity.testedCheckoutSha, repo.sourceSha);
    assert.equal(identity.sourceHeadTreeSha, repo.sourceTree);
    assert.equal(identity.testedCheckoutTreeSha, repo.sourceTree);
  });

  it("fails closed when pull_request source identity is missing", () => {
    const repo = initIdentityRepo();
    git(repo.dir, ["checkout", "-q", "--detach", repo.mergeSha]);
    assert.equal(codeOf(() => resolveEvidenceIdentity(repo.dir, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: repo.mergeSha,
      CHECKPOINT_E_SOURCE_HEAD_SHA: repo.sourceSha,
      CHECKPOINT_E_BASE_SHA: repo.baseSha,
      GITHUB_RUN_ID: "3",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "compiler-and-tests",
    })), "MISSING_SOURCE_IDENTITY");
  });

  it("rejects a forged source SHA that is not a commit", () => {
    const repo = initIdentityRepo();
    git(repo.dir, ["checkout", "-q", "--detach", repo.mergeSha]);
    const forged = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(codeOf(() => resolveEvidenceIdentity(repo.dir, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: repo.mergeSha,
      [SOURCE_HEAD_SHA_ENV]: forged,
      [BASE_SHA_ENV]: repo.baseSha,
      GITHUB_RUN_ID: "4",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "compiler-and-tests",
    })), "SOURCE_COMMIT_UNAVAILABLE");
  });

  it("rejects a pull_request source head that is the merge SHA", () => {
    const repo = initIdentityRepo();
    git(repo.dir, ["checkout", "-q", "--detach", repo.mergeSha]);
    assert.equal(codeOf(() => resolveEvidenceIdentity(repo.dir, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: repo.mergeSha,
      [SOURCE_HEAD_SHA_ENV]: repo.mergeSha,
      [BASE_SHA_ENV]: repo.baseSha,
      GITHUB_RUN_ID: "5",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "compiler-and-tests",
    })), "IDENTITY_COLLISION");
  });

  it("rejects a source commit outside the tested checkout ancestry", () => {
    const repo = initIdentityRepo();
    git(repo.dir, ["checkout", "-q", "--detach", repo.mergeSha]);
    assert.equal(codeOf(() => resolveEvidenceIdentity(repo.dir, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: repo.mergeSha,
      [SOURCE_HEAD_SHA_ENV]: repo.unrelatedSha,
      [BASE_SHA_ENV]: repo.baseSha,
      GITHUB_RUN_ID: "6",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "compiler-and-tests",
    })), "SOURCE_NOT_IN_CHECKOUT_ANCESTRY");
  });

  it("rejects recorded source and tested trees that do not match git", () => {
    const repo = initIdentityRepo();
    git(repo.dir, ["checkout", "-q", "--detach", repo.mergeSha]);
    const identity = resolveEvidenceIdentity(repo.dir, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: repo.mergeSha,
      [SOURCE_HEAD_SHA_ENV]: repo.sourceSha,
      [BASE_SHA_ENV]: repo.baseSha,
      GITHUB_RUN_ID: "7",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "compiler-and-tests",
    });
    assert.equal(codeOf(() => assertRecordedTreesMatchGit(repo.dir, {
      ...identity,
      sourceHeadTreeSha: repo.mergeTree === identity.sourceHeadTreeSha ? repo.baseSha : repo.mergeTree,
    })), "SOURCE_TREE_MISMATCH");
    assert.equal(codeOf(() => assertRecordedTreesMatchGit(repo.dir, {
      ...identity,
      testedCheckoutTreeSha: repo.sourceTree === identity.testedCheckoutTreeSha ? repo.baseSha : repo.sourceTree,
    })), "TESTED_TREE_MISMATCH");
  });
});
