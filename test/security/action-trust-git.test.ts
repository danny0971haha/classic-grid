import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { gitEnv, listGitIndex } from "../../scripts/security/action-git-index.js";
import { inventoryGitRepository } from "../../scripts/security/action-pin-policy.js";
import { verifyActionInventory } from "../../scripts/security/verify-action-inventory.js";

const CHECKOUT = "11d5960a326750d5838078e36cf38b85af677262";
const SETUP_NODE = "49933ea5288caeca8642d1e84afbd3f7d6820020";
const UPLOAD = "ea165f8d65b6e75b540449e92b4886f43607fa02";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DOCKER = "docker://evil/image@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const repos: string[] = [];

after(() => {
  for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: gitEnv(),
  }).toString();
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-grid-action-trust-"));
  repos.push(dir);
  const template = path.join(dir, ".empty-git-template");
  fs.mkdirSync(template, { recursive: true });
  git(dir, ["init", "-q", "--template", template]);
  git(dir, ["config", "user.email", "action-trust@example.test"]);
  git(dir, ["config", "user.name", "action-trust"]);
  git(dir, ["config", "core.symlinks", "true"]);
  return dir;
}

function writeTracked(root: string, rel: string, contents: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  git(root, ["add", "--", rel]);
}

function passingWorkflow(extraSteps = ""): string {
  return `name: ci
on: push
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${CHECKOUT}
        with:
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@${SETUP_NODE}
      - uses: actions/upload-artifact@${UPLOAD}
${extraSteps}`;
}

function composite(steps: string): string {
  return `name: local
runs:
  using: composite
  steps:
${steps}`;
}

function failClosed(root: string): ReturnType<typeof inventoryGitRepository> {
  return inventoryGitRepository(root, { requireProductionPins: false });
}

describe("GitHub Actions trust boundary in real Git repositories", () => {
  it("fails a second tracked workflow that uses an unpinned Action", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/ci.yml", passingWorkflow());
    writeTracked(root, ".github/workflows/extra.yml", `name: extra
on: push
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
`);
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.trackedManifests.includes(".github/workflows/extra.yml"));
    assert.ok(inventory.codes.includes("ACTION_REF_NOT_IMMUTABLE"));
    assert.ok(inventory.codes.includes("ACTION_NOT_ALLOWLISTED"));
  });

  it("scans a .yaml workflow extension from git ls-files", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/other.yaml", `name: yaml
on: push
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
`);
    const index = listGitIndex(root);
    assert.equal(index.ok, true);
    if (!index.ok) throw new Error("index");
    assert.ok(index.byPath.has(".github/workflows/other.yaml"));
    assert.ok(REGULAR_OR_NOT(index.byPath.get(".github/workflows/other.yaml")!.mode));
    const inventory = failClosed(root);
    assert.ok(inventory.trackedManifests.includes(".github/workflows/other.yaml"));
    assert.ok(inventory.scannedFiles.includes(".github/workflows/other.yaml"));
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_REF_NOT_IMMUTABLE"));
  });

  it("fails a local composite Action that uses actions/checkout@v4", () => {
    const root = tempRepo();
    writeTracked(root, ".github/actions/wrapper/action.yml", composite("      - uses: actions/checkout@v4\n"));
    writeTracked(root, ".github/workflows/ci.yml", passingWorkflow("      - uses: ./.github/actions/wrapper\n"));
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_REF_NOT_IMMUTABLE"));
    assert.equal(inventory.occurrences.some((row) => row.file === ".github/actions/wrapper/action.yml" && row.raw === "actions/checkout@v4"), true);
  });

  it("fails two-layer local composite Actions when the deepest uses is unpinned", () => {
    const root = tempRepo();
    writeTracked(root, ".github/actions/inner/action.yml", composite("      - uses: actions/cache@v4\n"));
    writeTracked(root, ".github/actions/outer/action.yml", composite("      - uses: ./.github/actions/inner\n"));
    writeTracked(root, ".github/workflows/ci.yml", passingWorkflow("      - uses: ./.github/actions/outer\n"));
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.graph.edges.some((edge) => edge.from === ".github/workflows/ci.yml" && edge.to === ".github/actions/outer"));
    assert.ok(inventory.graph.edges.some((edge) => edge.from === ".github/actions/outer/action.yml" && edge.to === ".github/actions/inner"));
    assert.ok(inventory.codes.includes("ACTION_REF_NOT_IMMUTABLE"));
  });

  it("fails a local Action path cycle", () => {
    const root = tempRepo();
    writeTracked(root, ".github/actions/a/action.yml", composite("      - uses: ./.github/actions/b\n"));
    writeTracked(root, ".github/actions/b/action.yml", composite("      - uses: ./.github/actions/a\n"));
    writeTracked(root, ".github/workflows/ci.yml", passingWorkflow("      - uses: ./.github/actions/a\n"));
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_LOCAL_CYCLE"));
    assert.ok(inventory.graph.cycles.length >= 1);
  });

  it("fails a job-level local reusable workflow that contains an unpinned Action", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/reusable.yml", `name: reusable
on: workflow_call
permissions:
  contents: read
jobs:
  inner:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
`);
    writeTracked(root, ".github/workflows/ci.yml", `name: ci
on: push
permissions:
  contents: read
jobs:
  x:
    uses: ./.github/workflows/reusable.yml
`);
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_REF_NOT_IMMUTABLE"));
    assert.equal(inventory.occurrences.some((row) => row.source === "job" && row.kind === "reusable-local"), true);
    assert.ok(inventory.graph.edges.some((edge) => edge.kind === "reusable-workflow"));
  });

  it("fails docker://evil/image@sha256 digest uses", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/ci.yml", passingWorkflow(`      - uses: ${DOCKER}\n`));
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_DOCKER_FORBIDDEN"));
    assert.equal(inventory.dockerActionCount, 1);
  });

  it("fails actions/checkout pinned to a different valid 40-hex SHA", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/ci.yml", `name: ci
on: push
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${OTHER_SHA}
        with:
          persist-credentials: false
          fetch-depth: 0
`);
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_NOT_ALLOWLISTED"));
    assert.equal(inventory.occurrences[0]?.immutablePin, true);
    assert.equal(inventory.occurrences[0]?.allowlisted, false);
    assert.equal(inventory.occurrences[0]?.ref, OTHER_SHA);
  });

  it("fails a tracked workflow symlink using the Git index mode", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/ci.yml", passingWorkflow());
    fs.symlinkSync("ci.yml", path.join(root, ".github/workflows/link.yml"));
    git(root, ["add", "--", ".github/workflows/link.yml"]);
    const index = listGitIndex(root);
    assert.equal(index.ok, true);
    if (!index.ok) throw new Error("index");
    assert.equal(index.byPath.get(".github/workflows/link.yml")?.mode, "120000");
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_SYMLINK_FORBIDDEN"));
    assert.ok(inventory.trackedManifests.includes(".github/workflows/link.yml"));
  });

  it("fails a tracked action.yml symlink using the Git index mode", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/ci.yml", passingWorkflow("      - uses: ./.github/actions/evil\n"));
    fs.mkdirSync(path.join(root, ".github/actions/evil"), { recursive: true });
    fs.symlinkSync("../../workflows/ci.yml", path.join(root, ".github/actions/evil/action.yml"));
    git(root, ["add", "--", ".github/actions/evil/action.yml"]);
    const index = listGitIndex(root);
    assert.equal(index.ok, true);
    if (!index.ok) throw new Error("index");
    assert.equal(index.byPath.get(".github/actions/evil/action.yml")?.mode, "120000");
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_SYMLINK_FORBIDDEN"));
  });

  it("fails duplicate YAML mapping keys in a tracked workflow", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/ci.yml", `name: ci
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
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_YAML_DUPLICATE_KEY") || inventory.codes.includes("ACTION_YAML_MALFORMED"));
  });

  it("fails alias/anchor bypasses in a tracked workflow", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/ci.yml", `name: ci
on: push
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - &evil
        uses: actions/checkout@v4
      - *evil
`);
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_YAML_ALIAS") || inventory.codes.includes("ACTION_REF_NOT_IMMUTABLE"));
  });

  it("parses quoted uses from git-tracked content", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/ci.yml", passingWorkflow(
      `      - uses: "actions/checkout@${CHECKOUT}"\n` +
      "        with:\n" +
      "          persist-credentials: false\n" +
      "          fetch-depth: 0\n",
    ));
    const inventory = failClosed(root);
    assert.equal(inventory.occurrences.some((row) => row.raw === `actions/checkout@${CHECKOUT}` && row.allowlisted), true);
  });

  it("parses flow-mapping uses from git-tracked content", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/ci.yml", `name: ci
on: push
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - { uses: actions/checkout@${CHECKOUT}, with: { persist-credentials: false, fetch-depth: 0 } }
      - uses: actions/setup-node@${SETUP_NODE}
      - uses: actions/upload-artifact@${UPLOAD}
`);
    const inventory = failClosed(root);
    const checkout = inventory.occurrences.find((row) => row.identity === "actions/checkout");
    assert.equal(checkout?.allowlisted, true);
    assert.equal(checkout?.checkoutPersistCredentials, false);
    assert.equal(checkout?.checkoutFetchDepth, 0);
    assert.equal(inventory.overallPolicyOk, true);
  });

  it("fails case-colliding workflow paths in the Git index", () => {
    const root = tempRepo();
    writeTracked(root, ".github/workflows/ci.yml", passingWorkflow());
    const blob = git(root, ["hash-object", "-w", "--stdin"], `name: CI
on: push
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
`).trim();
    git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},.github/workflows/CI.yml`]);
    const index = listGitIndex(root);
    assert.equal(index.ok, true);
    if (!index.ok) throw new Error("index");
    const names = [...index.byPath.keys()].filter((posixPath) => posixPath.startsWith(".github/workflows/"));
    assert.ok(names.includes(".github/workflows/ci.yml"));
    assert.ok(names.includes(".github/workflows/CI.yml"));
    const inventory = failClosed(root);
    assert.equal(inventory.overallPolicyOk, false);
    assert.ok(inventory.codes.includes("ACTION_PATH_CASE_COLLISION"));
  });

  it("accepts the current official repository via git ls-files", () => {
    const inventory = inventoryGitRepository(process.cwd(), { requireProductionPins: true });
    assert.equal(inventory.overallPolicyOk, true);
    assert.deepEqual(inventory.trackedManifests, [".github/workflows/ci.yml"]);
    assert.equal(inventory.occurrences.every((row) => row.kind === "external" && row.allowlisted), true);
    const tuples = inventory.occurrences.map((row) => `${row.identity}@${row.ref}`);
    assert.ok(tuples.includes(`actions/checkout@${CHECKOUT}`));
    assert.ok(tuples.includes(`actions/setup-node@${SETUP_NODE}`));
    assert.ok(tuples.includes(`actions/upload-artifact@${UPLOAD}`));
    const checks = verifyActionInventory(process.cwd(), inventory);
    assert.equal(checks.every((row) => row.ok), true, checks.filter((row) => !row.ok).map((row) => row.message).join("; "));
  });
});

function REGULAR_OR_NOT(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}
