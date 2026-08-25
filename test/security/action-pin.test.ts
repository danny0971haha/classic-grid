import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  evaluateWorkflowActions,
  inventoryGitRepository,
  parseActionPins,
} from "../../scripts/security/action-pin-policy.js";

const CHECKOUT = "11d5960a326750d5838078e36cf38b85af677262";
const SETUP_NODE = "49933ea5288caeca8642d1e84afbd3f7d6820020";
const UPLOAD = "ea165f8d65b6e75b540449e92b4886f43607fa02";
const OTHER_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function workflow(steps: string): string {
  return `name: ci
on: push
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
${steps}`;
}

function checkoutStep(options: {
  persist?: boolean;
  fetchDepth?: number;
  quoted?: boolean;
} = {}): string {
  const persist = options.persist !== false;
  const fetchDepth = options.fetchDepth ?? 0;
  const uses = options.quoted
    ? `"actions/checkout@${CHECKOUT}"`
    : `actions/checkout@${CHECKOUT}`;
  const lines = [
    `      - uses: ${uses}`,
    "        with:",
  ];
  if (persist) lines.push("          persist-credentials: false");
  lines.push(`          fetch-depth: ${fetchDepth}`);
  return `${lines.join("\n")}\n`;
}

describe("GitHub Action uses pin policy", () => {
  it("G-01 rejects actions/cache@v4", () => {
    const inventory = evaluateWorkflowActions(workflow("      - uses: actions/cache@v4\n"));
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_REF_NOT_IMMUTABLE"));
    assert.ok(inventory.codes.includes("ACTION_NOT_ALLOWLISTED"));
    assert.equal(inventory.occurrences[0]?.immutablePin, false);
    assert.equal(inventory.occurrences[0]?.allowlisted, false);
  });

  it("G-02 rejects owner/action@main", () => {
    const inventory = evaluateWorkflowActions(workflow("      - uses: owner/action@main\n"));
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_REF_NOT_IMMUTABLE"));
    assert.equal(inventory.occurrences[0]?.ref, "main");
    assert.equal(inventory.occurrences[0]?.immutablePin, false);
  });

  it("G-03 rejects owner/action@shortsha", () => {
    const inventory = evaluateWorkflowActions(workflow("      - uses: owner/action@abc1234\n"));
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_REF_NOT_IMMUTABLE"));
    assert.equal(inventory.occurrences[0]?.ref, "abc1234");
    assert.equal(inventory.occurrences[0]?.immutablePin, false);
  });

  it("G-04 parses quoted uses values with immutable SHAs", () => {
    const inventory = evaluateWorkflowActions(workflow(
      `      - uses: "actions/checkout@${CHECKOUT}"\n` +
      "        with:\n" +
      "          persist-credentials: false\n" +
      "          fetch-depth: 0\n" +
      `      - uses: 'actions/setup-node@${SETUP_NODE}'\n` +
      `      - uses: "actions/upload-artifact@${UPLOAD}"\n`,
    ));
    assert.equal(inventory.actionUsesTotal, 3);
    assert.equal(inventory.occurrences[0]?.identity, "actions/checkout");
    assert.equal(inventory.occurrences[0]?.ref, CHECKOUT);
    assert.equal(inventory.occurrences[0]?.immutablePin, true);
    assert.equal(inventory.occurrences[0]?.allowlisted, true);
    assert.equal(inventory.occurrences[0]?.raw, `actions/checkout@${CHECKOUT}`);
    assert.equal(inventory.occurrences[1]?.identity, "actions/setup-node");
    assert.equal(inventory.occurrences[1]?.ref, SETUP_NODE);
    assert.equal(inventory.occurrences[1]?.immutablePin, true);
    assert.equal(inventory.occurrences[2]?.identity, "actions/upload-artifact");
    assert.equal(inventory.occurrences[2]?.ref, UPLOAD);
    assert.equal(inventory.occurrences[2]?.immutablePin, true);
    assert.equal(inventory.occurrences.every((row) => row.kind === "external"), true);
  });

  it("G-05 rejects a second checkout missing persist-credentials: false", () => {
    const inventory = evaluateWorkflowActions(workflow(
      checkoutStep() +
      checkoutStep({ persist: false, fetchDepth: 0 }),
    ));
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("CHECKOUT_PERSIST_CREDENTIALS_UNSAFE"));
    assert.equal(inventory.occurrences.length, 2);
    assert.equal(inventory.occurrences[0]?.checkoutPersistCredentials, false);
    assert.equal(inventory.occurrences[1]?.checkoutPersistCredentials, true);
    assert.ok(inventory.occurrences[1]?.codes.includes("CHECKOUT_PERSIST_CREDENTIALS_UNSAFE"));
    assert.equal(inventory.unsafeCheckouts, 1);
  });

  it("G-06 rejects a second checkout using fetch-depth: 1", () => {
    const inventory = evaluateWorkflowActions(workflow(
      checkoutStep() +
      checkoutStep({ persist: true, fetchDepth: 1 }),
    ));
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("CHECKOUT_FETCH_DEPTH_UNSAFE"));
    assert.equal(inventory.occurrences[0]?.checkoutFetchDepth, 0);
    assert.equal(inventory.occurrences[1]?.checkoutFetchDepth, 1);
    assert.ok(inventory.occurrences[1]?.codes.includes("CHECKOUT_FETCH_DEPTH_UNSAFE"));
    assert.equal(inventory.unsafeCheckouts, 1);
  });

  it("G-07 rejects an unknown external action even when SHA-pinned", () => {
    const inventory = evaluateWorkflowActions(workflow(`      - uses: evil/unknown@${OTHER_SHA}\n`));
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_NOT_ALLOWLISTED"));
    assert.equal(inventory.codes.includes("ACTION_REF_NOT_IMMUTABLE"), false);
    assert.equal(inventory.occurrences[0]?.immutablePin, true);
    assert.equal(inventory.occurrences[0]?.allowlisted, false);
    assert.equal(inventory.occurrences[0]?.identity, "evil/unknown");
  });

  it("G-08 rejects local actions unless a Git index can verify them", () => {
    const safe = evaluateWorkflowActions(workflow("      - uses: ./.github/actions/safe-action\n"));
    assert.equal(safe.occurrences[0]?.kind, "local");
    assert.equal(safe.occurrences[0]?.allowlisted, false);
    assert.equal(safe.occurrences[0]?.immutablePin, false);
    assert.equal(safe.overallPolicyOk, false);
    assert.ok(safe.codes.includes("ACTION_LOCAL_UNTRACKED"));

    const parent = evaluateWorkflowActions(workflow("      - uses: ../escape\n"));
    assert.equal(parent.overallPolicyOk, false);
    assert.ok(parent.codes.includes("ACTION_LOCAL_PATH_UNSAFE"));

    const dotted = evaluateWorkflowActions(workflow("      - uses: ./foo/../../etc\n"));
    assert.equal(dotted.overallPolicyOk, false);
    assert.ok(dotted.codes.includes("ACTION_LOCAL_PATH_UNSAFE"));

    const absolute = evaluateWorkflowActions(workflow("      - uses: /tmp/action\n"));
    assert.equal(absolute.overallPolicyOk, false);
    assert.ok(absolute.codes.includes("ACTION_LOCAL_PATH_UNSAFE"));
  });

  it("G-09 rejects every docker action, including digest-pinned images", () => {
    const tagged = evaluateWorkflowActions(workflow("      - uses: docker://alpine:3.20\n"));
    assert.equal(tagged.overallPolicyOk, false);
    assert.ok(tagged.codes.includes("ACTION_DOCKER_FORBIDDEN"));
    assert.equal(tagged.occurrences[0]?.kind, "docker");
    assert.equal(tagged.occurrences[0]?.immutablePin, false);
    assert.equal(tagged.occurrences[0]?.allowlisted, false);

    const digested = evaluateWorkflowActions(workflow("      - uses: docker://evil/image@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n"));
    assert.equal(digested.overallPolicyOk, false);
    assert.ok(digested.codes.includes("ACTION_DOCKER_FORBIDDEN"));
    assert.equal(digested.occurrences[0]?.kind, "docker");
    assert.equal(digested.occurrences[0]?.allowlisted, false);
  });

  it("G-10 accepts the current workflow and inventories every uses occurrence", () => {
    const workflowText = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    const inventory = parseActionPins(workflowText);
    assert.equal(inventory.overallPolicyOk, true);
    assert.deepEqual(inventory.codes, ["PASS"]);
    assert.equal(inventory.schemaVersion, "classic-v0.2-action-pin-inventory/3");
    assert.equal(inventory.checkoutOccurrenceCount, 1);
    assert.equal(inventory.setupNodeOccurrenceCount, 1);
    assert.ok(inventory.uploadArtifactOccurrenceCount >= 1);
    assert.equal(inventory.actionUsesTotal, inventory.occurrences.length);
    assert.ok(inventory.actionUsesTotal >= 3);
    assert.equal(inventory.unpinnedExternalActions, 0);
    assert.equal(inventory.unsafeCheckouts, 0);
    const usesLines = workflowText.split("\n").filter((line) => /^\s*-?\s*uses\s*:/.test(line));
    assert.equal(inventory.occurrences.length, usesLines.length);
    for (const row of inventory.occurrences) {
      assert.equal(row.kind, "external");
      assert.equal(row.immutablePin, true);
      assert.equal(row.allowlisted, true);
      assert.match(row.ref ?? "", /^[0-9a-f]{40}$/);
      if (row.identity === "actions/checkout") {
        assert.equal(row.checkoutPersistCredentials, false);
        assert.equal(row.checkoutFetchDepth, 0);
      }
    }
  });

  it("G-13 parses quoted uses through the YAML parser", () => {
    const inventory = evaluateWorkflowActions(workflow(
      `      - uses: "actions/checkout@${CHECKOUT}"\n` +
      "        with:\n" +
      "          persist-credentials: false\n" +
      "          fetch-depth: 0\n",
    ));
    assert.equal(inventory.occurrences[0]?.raw, `actions/checkout@${CHECKOUT}`);
    assert.equal(inventory.occurrences[0]?.allowlisted, true);
  });

  it("G-14 parses flow-mapping uses or fails closed", () => {
    const inventory = evaluateWorkflowActions(`name: ci
on: push
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - { uses: actions/checkout@${CHECKOUT}, with: { persist-credentials: false, fetch-depth: 0 } }
`);
    assert.equal(inventory.occurrences.length, 1);
    assert.equal(inventory.occurrences[0]?.identity, "actions/checkout");
    assert.equal(inventory.occurrences[0]?.ref, CHECKOUT);
    assert.equal(inventory.occurrences[0]?.allowlisted, true);
    assert.equal(inventory.occurrences[0]?.checkoutPersistCredentials, false);
    assert.equal(inventory.occurrences[0]?.checkoutFetchDepth, 0);
    assert.equal(inventory.overallPolicyOk, true);
  });

  it("rejects duplicate mapping keys and alias bypasses", () => {
    const duplicate = evaluateWorkflowActions(`name: ci
on: push
on: pull_request
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${CHECKOUT}
`);
    assert.equal(duplicate.overallPolicyOk, false);
    assert.ok(duplicate.codes.includes("ACTION_YAML_DUPLICATE_KEY") || duplicate.codes.includes("ACTION_YAML_MALFORMED"));

    const aliased = evaluateWorkflowActions(`name: ci
on: push
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - &evil
        uses: actions/cache@v4
      - *evil
`);
    assert.equal(aliased.overallPolicyOk, false);
    assert.ok(aliased.codes.includes("ACTION_YAML_ALIAS") || aliased.codes.includes("ACTION_REF_NOT_IMMUTABLE"));
  });

  it("G-16/G-17 accepts the official repository inventory and exact approved SHAs", () => {
    const inventory = inventoryGitRepository(process.cwd(), { requireProductionPins: true });
    assert.equal(inventory.overallPolicyOk, true);
    assert.deepEqual(inventory.codes, ["PASS"]);
    assert.deepEqual(inventory.trackedManifests, [".github/workflows/ci.yml"]);
    assert.ok(inventory.scannedFiles.includes(".github/workflows/ci.yml"));
    const tuples = new Set(inventory.occurrences.filter((row) => row.kind === "external").map((row) => `${row.identity}@${row.ref}`));
    assert.ok(tuples.has(`actions/checkout@${CHECKOUT}`));
    assert.ok(tuples.has(`actions/setup-node@${SETUP_NODE}`));
    assert.ok(tuples.has(`actions/upload-artifact@${UPLOAD}`));
    assert.equal(inventory.occurrences.every((row) => row.kind === "external" && row.allowlisted === true), true);
    assert.equal(inventory.dockerActionCount, 0);
    assert.equal(inventory.graph.cycles.length, 0);
  });

  it("upload-artifact runs only after post-build security gates", () => {
    const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    assertUploadsAfterSecurityGates(workflow);
  });

  it("a workflow that uploads before security scans is rejected by the order gate", () => {
    const bad = `name: ci
jobs:
  x:
    steps:
      - uses: actions/upload-artifact@${UPLOAD}
      - name: Whitespace check
        run: git diff --check
`;
    assert.throws(() => assertUploadsAfterSecurityGates(bad));
  });
});

function assertUploadsAfterSecurityGates(workflow: string): void {
  const firstUpload = workflow.search(/uses:\s*actions\/upload-artifact@/);
  assert.ok(firstUpload >= 0, "expected at least one upload-artifact");
  const requiredBefore = [
    "Extended canary dependency boundary",
    "Production artifact smoke and forbidden source scan",
    "Whitespace check",
    "Working tree clean",
    "git diff --check",
    'git diff "origin/${BASE_REF}...HEAD" --check',
    'git diff "origin/main...HEAD" --check',
    "git diff --exit-code",
    "git status --porcelain",
  ];
  for (const token of requiredBefore) {
    const idx = workflow.indexOf(token);
    assert.notEqual(idx, -1, `missing ${token}`);
    assert.ok(idx < firstUpload, `${token} must precede upload-artifact`);
  }
  assert.equal(workflow.includes("if: always()"), false);
  assert.equal(workflow.includes("continue-on-error: true"), false);
}
