import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { verifyTarballContent } from "../../scripts/security/content-manifest.js";
import {
  CONTENT_MANIFEST_SCHEMA,
  MODULE_GRAPH_SCHEMA,
} from "../../scripts/security/canary-manifest-schema.js";
import { assertCanaryModuleGraph } from "../../scripts/security/module-graph.js";
import { buildTgzBuffer as buildTgz } from "../../scripts/security/tar-bytes.js";

function contentManifest(files: Array<{ relativePath: string; sha256: string }>): string {
  return `${JSON.stringify({
    schemaVersion: CONTENT_MANIFEST_SCHEMA,
    selfRelativePath: "content-manifest.json",
    files: files.map((row) => ({
      relativePath: row.relativePath,
      fileType: "file",
      mode: "0644",
      sha256: row.sha256,
    })),
  }, null, 2)}\n`;
}

const HELLO = Buffer.from("hello\n");
const HELLO_HASH = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";

describe("canary artifact content manifest", () => {
  it("PASS_BLOCKED: extra tar file is rejected", () => {
    const manifest = contentManifest([{ relativePath: "a.txt", sha256: HELLO_HASH }]);
    const tgz = buildTgz([
      { name: "package/content-manifest.json", data: manifest, mode: 0o644 },
      { name: "package/a.txt", data: HELLO, mode: 0o644 },
      { name: "package/extra.txt", data: HELLO, mode: 0o644 },
    ]);
    assert.throws(() => verifyTarballContent(tgz), /TAR_EXTRA/);
  });

  it("PASS_BLOCKED: missing tar file is rejected", () => {
    const manifest = contentManifest([
      { relativePath: "a.txt", sha256: HELLO_HASH },
      { relativePath: "b.txt", sha256: HELLO_HASH },
    ]);
    const tgz = buildTgz([
      { name: "package/content-manifest.json", data: manifest, mode: 0o644 },
      { name: "package/a.txt", data: HELLO, mode: 0o644 },
    ]);
    assert.throws(() => verifyTarballContent(tgz), /TAR_MISSING/);
  });

  it("PASS_BLOCKED: changed file hash is rejected", () => {
    const manifest = contentManifest([{ relativePath: "a.txt", sha256: "0".repeat(64) }]);
    const tgz = buildTgz([
      { name: "package/content-manifest.json", data: manifest, mode: 0o644 },
      { name: "package/a.txt", data: HELLO, mode: 0o644 },
    ]);
    assert.throws(() => verifyTarballContent(tgz), /CONTENT_HASH_MISMATCH/);
  });

  it("PASS_BLOCKED: duplicate tar entry is rejected", () => {
    const manifest = contentManifest([{ relativePath: "a.txt", sha256: HELLO_HASH }]);
    const tgz = buildTgz([
      { name: "package/content-manifest.json", data: manifest, mode: 0o644 },
      { name: "package/a.txt", data: HELLO, mode: 0o644 },
      { name: "package/a.txt", data: HELLO, mode: 0o644 },
    ]);
    assert.throws(() => verifyTarballContent(tgz), /TAR_DUPLICATE/);
  });

  it("PASS_BLOCKED: symlink entry is rejected", () => {
    const manifest = contentManifest([{ relativePath: "a.txt", sha256: HELLO_HASH }]);
    const tgz = buildTgz([
      { name: "package/content-manifest.json", data: manifest, mode: 0o644 },
      { name: "package/a.txt", data: HELLO, mode: 0o644 },
      { name: "package/link", typeflag: "2", linkname: "a.txt", mode: 0o644 },
    ]);
    assert.throws(() => verifyTarballContent(tgz), /TAR_SYMLINK/);
  });

  it("PASS_BLOCKED: hardlink entry is rejected", () => {
    const manifest = contentManifest([{ relativePath: "a.txt", sha256: HELLO_HASH }]);
    const tgz = buildTgz([
      { name: "package/content-manifest.json", data: manifest, mode: 0o644 },
      { name: "package/a.txt", data: HELLO, mode: 0o644 },
      { name: "package/hard", typeflag: "1", linkname: "package/a.txt", mode: 0o644 },
    ]);
    assert.throws(() => verifyTarballContent(tgz), /TAR_HARDLINK/);
  });

  it("PASS_BLOCKED: absolute path entry is rejected", () => {
    const manifest = contentManifest([{ relativePath: "a.txt", sha256: HELLO_HASH }]);
    const tgz = buildTgz([
      { name: "package/content-manifest.json", data: manifest, mode: 0o644 },
      { name: "/tmp/evil.txt", data: HELLO, mode: 0o644 },
    ]);
    assert.throws(() => verifyTarballContent(tgz), /TAR_ABSOLUTE/);
  });

  it("PASS_BLOCKED: traversal entry is rejected", () => {
    const manifest = contentManifest([{ relativePath: "a.txt", sha256: HELLO_HASH }]);
    const tgz = buildTgz([
      { name: "package/content-manifest.json", data: manifest, mode: 0o644 },
      { name: "package/../evil.txt", data: HELLO, mode: 0o644 },
    ]);
    assert.throws(() => verifyTarballContent(tgz), /TAR_TRAVERSAL/);
  });

  it("PASS_BLOCKED: stale content manifest hashes are rejected", () => {
    const expected = {
      schemaVersion: CONTENT_MANIFEST_SCHEMA,
      selfRelativePath: "content-manifest.json" as const,
      files: [
        { relativePath: "a.txt", fileType: "file" as const, mode: "0644", sha256: HELLO_HASH },
      ],
    };
    const stale = contentManifest([{ relativePath: "a.txt", sha256: "1".repeat(64) }]);
    const tgz = buildTgz([
      { name: "package/content-manifest.json", data: stale, mode: 0o644 },
      { name: "package/a.txt", data: HELLO, mode: 0o644 },
    ]);
    assert.throws(() => verifyTarballContent(tgz, expected), /CONTENT_HASH_MISMATCH|CONTENT_MANIFEST_STALE/);
  });

  it("PASS_BLOCKED: canary-origin parent resolving into the root repository is rejected", () => {
    const canaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "classic-canary-root-"));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "classic-repo-root-"));
    try {
      fs.mkdirSync(path.join(canaryRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(canaryRoot, "src", "entry.ts"), "export {}\n");
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "src", "loop.ts"), "export {}\n");
      const hits = assertCanaryModuleGraph({
        records: [
          {
            schemaVersion: MODULE_GRAPH_SCHEMA,
            specifier: "../loop.js",
            parentURL: pathToFileURL(path.join(canaryRoot, "src", "entry.ts")).href,
            resolvedURL: pathToFileURL(path.join(repoRoot, "src", "loop.ts")).href,
          },
        ],
        canaryRoot,
        repoRoot,
      });
      assert.ok(hits.some((hit) => hit.startsWith("ROOT_REPOSITORY_RESOLUTION:")), hits.join("\n"));
    } finally {
      fs.rmSync(canaryRoot, { recursive: true, force: true });
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
