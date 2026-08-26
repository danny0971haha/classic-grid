import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertTrackedRegularFile,
  gitIndexForRoot,
  parseCanaryManifestJson,
  parseCanaryManifestFile,
} from "../../scripts/security/canary-manifest-schema.js";
import { repoRootFromHere } from "../../scripts/security/extended-canary-boundary.js";
import { analyzeCanarySourcePolicy } from "../../scripts/security/source-policy.js";

const ROOT = repoRootFromHere();

function cloneManifest(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "packages/extended-canary/file-manifest.json"), "utf8")) as Record<string, unknown>;
}

describe("strict canary manifest schema", () => {
  it("PASS_ALLOWED: committed schema 2 manifest parses", () => {
    const manifest = parseCanaryManifestFile(ROOT);
    assert.equal(manifest.schemaVersion, "classic-v0.2-extended-canary-file-manifest/2");
    assert.deepEqual(manifest.entrypoints, ["src/cli/run-extended-canary.ts"]);
    assert.equal(manifest.files.includes("public/index.html"), true);
    assert.equal(manifest.runtimeFiles.includes("public/index.html"), false);
  });

  it("PASS_BLOCKED: unknown field is rejected", () => {
    const raw = cloneManifest();
    raw.forbiddenSourceBasenames = ["n1.ts"];
    assert.throws(() => parseCanaryManifestJson(raw), /UNKNOWN_FIELD/);
  });

  it("PASS_BLOCKED: duplicate runtime file is rejected", () => {
    const raw = cloneManifest();
    const files = [...(raw.runtimeFiles as string[])];
    files.push(files[0]!);
    files.sort();
    raw.runtimeFiles = files;
    assert.throws(() => parseCanaryManifestJson(raw), /DUPLICATE/);
  });

  it("PASS_BLOCKED: path case collision is rejected", () => {
    const raw = cloneManifest();
    const files = [...(raw.runtimeFiles as string[])];
    files.push("src/Loop.ts");
    files.sort();
    raw.runtimeFiles = files;
    assert.throws(() => parseCanaryManifestJson(raw), /CASE_COLLISION/);
  });

  it("PASS_BLOCKED: absolute path is rejected", () => {
    const raw = cloneManifest();
    const files = [...(raw.runtimeFiles as string[]), "/tmp/evil.ts"];
    files.sort();
    raw.runtimeFiles = files;
    assert.throws(() => parseCanaryManifestJson(raw), /ABSOLUTE/);
  });

  it("PASS_BLOCKED: ../ escape is rejected", () => {
    const raw = cloneManifest();
    const files = [...(raw.runtimeFiles as string[]), "../secrets.ts"];
    files.sort();
    raw.runtimeFiles = files;
    assert.throws(() => parseCanaryManifestJson(raw), /ESCAPE/);
  });

  it("PASS_BLOCKED: backslash-equivalent path is rejected", () => {
    const raw = cloneManifest();
    const files = [...(raw.runtimeFiles as string[]), "src\\loop.ts"];
    files.sort();
    raw.runtimeFiles = files;
    assert.throws(() => parseCanaryManifestJson(raw), /INVALID|ESCAPE|ABSOLUTE/);
  });

  it("PASS_BLOCKED: missing required field is rejected", () => {
    const raw = cloneManifest();
    delete raw.assets;
    assert.throws(() => parseCanaryManifestJson(raw), /MISSING_FIELD|UNKNOWN_FIELD/);
  });

  it("PASS_BLOCKED: missing file is rejected", () => {
    assert.throws(
      () => assertTrackedRegularFile(ROOT, "src/does-not-exist-canary.ts", undefined),
      /MISSING/,
    );
  });

  it("PASS_BLOCKED: symlink source is rejected", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "classic-manifest-symlink-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "src", "real.ts"), "export const x = 1;\n");
      fs.symlinkSync(path.join(tmp, "src", "real.ts"), path.join(tmp, "src", "loop.ts"));
      assert.throws(
        () => assertTrackedRegularFile(tmp, "src/loop.ts", undefined),
        /SYMLINK/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("PASS_BLOCKED: untracked file is rejected against the git index", () => {
    const manifest = parseCanaryManifestFile(ROOT);
    const gitIndex = gitIndexForRoot(ROOT);
    assert.ok(gitIndex);
    const untracked = path.join(ROOT, "src", "untracked-canary-temp.ts");
    fs.writeFileSync(untracked, "export const x = 1;\n");
    try {
      assert.throws(
        () => assertTrackedRegularFile(ROOT, "src/untracked-canary-temp.ts", gitIndex),
        /UNTRACKED/,
      );
    } finally {
      fs.rmSync(untracked, { force: true });
    }
    assert.ok(manifest.runtimeFiles.includes("src/loop.ts"));
  });

  it("PASS_BLOCKED: executable extension not scanned is rejected", () => {
    const raw = cloneManifest();
    const files = [...(raw.runtimeFiles as string[]), "src/evil.jsx"];
    files.sort();
    raw.runtimeFiles = files;
    assert.throws(() => parseCanaryManifestJson(raw), /UNSCANNED_EXTENSION/);
  });

  it("PASS_BLOCKED: unlisted imported local file is rejected", () => {
    const extra = 'import "./ghost.js";\nexport const x = 1;\n';
    const policy = analyzeCanarySourcePolicy(
      ROOT,
      parseCanaryManifestFile(ROOT),
      new Map([["src/cli/run-extended-canary.ts", extra]]),
    );
    assert.ok(
      policy.some((row) => row.code === "UNLISTED_LOCAL" || row.code === "UNRESOLVED_LOCAL"),
      policy.map((row) => `${row.code}:${row.detail}`).join("\n"),
    );
  });

  it("PASS_BLOCKED: stale approved exception is rejected", () => {
    const source = `import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export const x = 1;
`;
    const policy = analyzeCanarySourcePolicy(
      ROOT,
      parseCanaryManifestFile(ROOT),
      new Map([["src/venues/extended.ts", source]]),
    );
    assert.ok(
      policy.some((row) => row.code === "STALE_EXCEPTION"),
      policy.map((row) => `${row.code}:${row.detail}`).join("\n"),
    );
  });
});
