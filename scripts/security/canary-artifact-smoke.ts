import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { verifyTarballContent } from "./content-manifest.js";

const verification = JSON.parse(
  fs.readFileSync("artifacts/security/extended-canary-verification.json", "utf8"),
) as {
  ok?: boolean;
  audit?: { high?: number; critical?: number };
  forbiddenInLockfile?: string[];
  forbiddenInstalled?: string[];
  forbiddenLoaded?: string[];
  secretLikeFiles?: string[];
  unexpectedNetwork?: string[];
  contentManifestSha256?: string;
  moduleGraphHits?: string[];
};

if (verification.ok !== true) throw new Error("CANARY_VERIFICATION_NOT_OK");
if (verification.audit?.high !== 0 || verification.audit?.critical !== 0) {
  throw new Error("CANARY_AUDIT_NOT_ZERO_HIGH");
}
for (const key of ["forbiddenInLockfile", "forbiddenInstalled", "forbiddenLoaded", "secretLikeFiles", "unexpectedNetwork", "moduleGraphHits"] as const) {
  if ((verification[key] ?? []).length) throw new Error(`CANARY_${key.toUpperCase()}`);
}
if (!verification.contentManifestSha256 || !/^[0-9a-f]{64}$/.test(verification.contentManifestSha256)) {
  throw new Error("CONTENT_MANIFEST_SHA_MISSING");
}

const dir = "artifacts/extended-canary";
const tgz = fs.readdirSync(dir).filter((name) => name.endsWith(".tgz"));
if (tgz.length !== 1) throw new Error(`CANARY_TGZ_COUNT:${tgz.length}`);
const tarballPath = path.join(dir, tgz[0]!);
const listed = spawnSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
if (listed.status !== 0) throw new Error("CANARY_TAR_LIST_FAILED");
const names = (listed.stdout || "").split(/\n/).filter(Boolean);
const forbiddenExact = [
  "src/venues/n1.ts",
  "src/venues/nado.ts",
  "src/venues/phoenix.ts",
  "src/venues/popdex.ts",
  "src/officialStats.ts",
  "src/venues/index.ts",
];
for (const item of forbiddenExact) {
  if (names.some((name) => name === item || name.endsWith(`/${item}`))) {
    throw new Error(`SOURCE_LEAK:${item}`);
  }
}
if (names.some((name) => /(^|\/)\.env($|\.)/.test(name) || name.includes("/secrets/"))) {
  throw new Error("SECRET_IN_TGZ");
}
const verified = verifyTarballContent(fs.readFileSync(tarballPath));
if (verified.manifestSha256 !== verification.contentManifestSha256) {
  throw new Error("CONTENT_MANIFEST_SHA_MISMATCH");
}
process.stdout.write(`artifact_smoke_ok files=${names.length} content=${verified.manifestSha256}\n`);
