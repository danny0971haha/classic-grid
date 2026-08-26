import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CONTENT_MANIFEST_SCHEMA,
  assertCanonicalRelPath,
  type ContentManifest,
  type ContentManifestFile,
} from "./canary-manifest-schema.js";
import { modeString, parseTgzBuffer, type TarEntry } from "./tar-bytes.js";

export const CONTENT_MANIFEST_RELATIVE = "content-manifest.json";
export const APPROVED_FILE_MODE = "0644";
export const APPROVED_DIR_MODE = "0755";

export function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function listRegularFiles(dir: string, prefix = ""): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`CONTENT_SYMLINK:${rel}`);
    if (entry.isDirectory()) out.push(...listRegularFiles(full, rel));
    else if (entry.isFile()) out.push(rel.replaceAll("\\", "/"));
    else throw new Error(`CONTENT_NON_REGULAR:${rel}`);
  }
  return out;
}

export function buildContentManifest(stagingDir: string, extraExclude: string[] = []): ContentManifest {
  const exclude = new Set([CONTENT_MANIFEST_RELATIVE, ...extraExclude]);
  const files: ContentManifestFile[] = [];
  for (const rel of listRegularFiles(stagingDir)) {
    if (exclude.has(rel)) continue;
    assertCanonicalRelPath(rel, "content");
    const full = path.join(stagingDir, rel);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`CONTENT_NON_REGULAR:${rel}`);
    const mode = modeString(st.mode);
    if (mode !== APPROVED_FILE_MODE) throw new Error(`CONTENT_MODE:${rel}:${mode}`);
    files.push({
      relativePath: rel,
      fileType: "file",
      mode,
      sha256: sha256Buffer(fs.readFileSync(full)),
    });
  }
  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  return {
    schemaVersion: CONTENT_MANIFEST_SCHEMA,
    selfRelativePath: CONTENT_MANIFEST_RELATIVE,
    files,
  };
}

export function writeContentManifest(stagingDir: string): { manifest: ContentManifest; sha256: string } {
  const manifest = buildContentManifest(stagingDir);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(stagingDir, CONTENT_MANIFEST_RELATIVE), text, { mode: 0o644 });
  fs.chmodSync(path.join(stagingDir, CONTENT_MANIFEST_RELATIVE), 0o644);
  return { manifest, sha256: sha256Buffer(Buffer.from(text)) };
}

function stripPackagePrefix(name: string): string {
  const normalized = name.replace(/\/+$/, "");
  if (normalized === "package") return "";
  if (normalized.startsWith("package/")) return normalized.slice("package/".length);
  return normalized;
}

export function verifyTarballContent(tgz: Buffer, expected?: ContentManifest): {
  manifest: ContentManifest;
  manifestSha256: string;
  extra: string[];
  missing: string[];
} {
  const entries = parseTgzBuffer(tgz);
  const names = entries.map((e) => e.name);
  if (new Set(names).size !== names.length) {
    const seen = new Set<string>();
    const dup = names.filter((n) => {
      if (seen.has(n)) return true;
      seen.add(n);
      return false;
    });
    throw new Error(`TAR_DUPLICATE:${dup.join(",")}`);
  }
  const files: TarEntry[] = [];
  for (const entry of entries) {
    const rel = stripPackagePrefix(entry.name);
    if (entry.name.startsWith("/") || entry.name.startsWith("\\") || /^[A-Za-z]:/.test(entry.name)) {
      throw new Error(`TAR_ABSOLUTE:${entry.name}`);
    }
    if (entry.name.split("/").includes("..") || rel.split("/").includes("..")) {
      throw new Error(`TAR_TRAVERSAL:${entry.name}`);
    }
    if (entry.type === "directory") continue;
    if (entry.type === "symlink") throw new Error(`TAR_SYMLINK:${entry.name}`);
    if (entry.type === "hardlink") throw new Error(`TAR_HARDLINK:${entry.name}`);
    if (entry.type === "device" || entry.type === "fifo" || entry.type === "other") {
      throw new Error(`TAR_NON_FILE:${entry.type}:${entry.name}`);
    }
    files.push(entry);
  }
  const manifestEntry = files.find((e) => stripPackagePrefix(e.name) === CONTENT_MANIFEST_RELATIVE);
  if (!manifestEntry) throw new Error("CONTENT_MANIFEST_MISSING");
  let parsed: ContentManifest;
  try {
    parsed = JSON.parse(manifestEntry.data.toString("utf8")) as ContentManifest;
  } catch {
    throw new Error("CONTENT_MANIFEST_MALFORMED");
  }
  if (parsed.schemaVersion !== CONTENT_MANIFEST_SCHEMA) throw new Error("CONTENT_MANIFEST_SCHEMA");
  if (parsed.selfRelativePath !== CONTENT_MANIFEST_RELATIVE) throw new Error("CONTENT_MANIFEST_SELF_PATH");
  if (!Array.isArray(parsed.files)) throw new Error("CONTENT_MANIFEST_FILES");
  const listed = new Map<string, ContentManifestFile>();
  for (const row of parsed.files) {
    if (!row || row.fileType !== "file") throw new Error(`CONTENT_MANIFEST_FILE_TYPE:${row?.relativePath}`);
    assertCanonicalRelPath(row.relativePath, "content-manifest");
    if (row.relativePath === CONTENT_MANIFEST_RELATIVE) throw new Error("CONTENT_MANIFEST_SELF_DIGEST");
    if (row.mode !== APPROVED_FILE_MODE) throw new Error(`CONTENT_MODE:${row.relativePath}:${row.mode}`);
    if (!/^[0-9a-f]{64}$/.test(row.sha256)) throw new Error(`CONTENT_HASH_INVALID:${row.relativePath}`);
    if (listed.has(row.relativePath)) throw new Error(`CONTENT_MANIFEST_DUPLICATE:${row.relativePath}`);
    listed.set(row.relativePath, row);
  }
  const present = new Set(
    files.map((e) => stripPackagePrefix(e.name)).filter((n) => n && n !== CONTENT_MANIFEST_RELATIVE),
  );
  const extra = [...present].filter((n) => !listed.has(n)).sort();
  const missing = [...listed.keys()].filter((n) => !present.has(n)).sort();
  if (extra.length) throw new Error(`TAR_EXTRA:${extra.join(",")}`);
  if (missing.length) throw new Error(`TAR_MISSING:${missing.join(",")}`);
  for (const entry of files) {
    const rel = stripPackagePrefix(entry.name);
    if (rel === CONTENT_MANIFEST_RELATIVE) continue;
    const row = listed.get(rel);
    if (!row) continue;
    const mode = modeString(entry.mode);
    if (mode !== row.mode) throw new Error(`CONTENT_MODE:${rel}:${mode}`);
    const digest = sha256Buffer(entry.data);
    if (digest !== row.sha256) throw new Error(`CONTENT_HASH_MISMATCH:${rel}`);
  }
  if (expected) {
    const expectedMap = new Map(expected.files.map((row) => [row.relativePath, row.sha256]));
    if (expectedMap.size !== listed.size) throw new Error("CONTENT_MANIFEST_STALE");
    for (const [rel, digest] of expectedMap) {
      if (listed.get(rel)?.sha256 !== digest) throw new Error(`CONTENT_MANIFEST_STALE:${rel}`);
    }
  }
  return {
    manifest: parsed,
    manifestSha256: sha256Buffer(manifestEntry.data),
    extra,
    missing,
  };
}

export function verifyExtractedTree(extractRoot: string, manifest: ContentManifest): void {
  const packageDir = fs.existsSync(path.join(extractRoot, "package"))
    ? path.join(extractRoot, "package")
    : extractRoot;
  const present = new Set(listRegularFiles(packageDir));
  const expected = new Set(manifest.files.map((row) => row.relativePath));
  expected.add(CONTENT_MANIFEST_RELATIVE);
  const extra = [...present].filter((n) => !expected.has(n)).sort();
  const missing = [...expected].filter((n) => !present.has(n)).sort();
  if (extra.length) throw new Error(`EXTRACT_EXTRA:${extra.join(",")}`);
  if (missing.length) throw new Error(`EXTRACT_MISSING:${missing.join(",")}`);
  for (const row of manifest.files) {
    const digest = sha256Buffer(fs.readFileSync(path.join(packageDir, row.relativePath)));
    if (digest !== row.sha256) throw new Error(`CONTENT_HASH_MISMATCH:${row.relativePath}`);
  }
}
