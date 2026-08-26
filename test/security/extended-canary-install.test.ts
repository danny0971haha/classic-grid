import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CANARY_MANIFEST_RELATIVE,
  repoRootFromHere,
  verifyExtendedCanary,
} from "../../scripts/security/extended-canary-boundary.js";

const ROOT = repoRootFromHere();

describe("extended canary clean artifact", () => {
  it("clean temporary install, audit, module-load, and offline dry-run", {
    timeout: 180_000,
    skip: process.env.DEPENDENCY_BOUNDARY_SKIP_INSTALL_TEST === "1",
  }, () => {
    const result = verifyExtendedCanary(ROOT);
    assert.equal(result.ok, true, result.codes.join(","));
    assert.deepEqual(result.codes, ["CHECKS_OK"]);
    assert.equal(result.audit.critical, 0);
    assert.equal(result.audit.high, 0);
    assert.deepEqual(result.forbiddenInLockfile, []);
    assert.deepEqual(result.forbiddenInstalled, []);
    assert.deepEqual(result.forbiddenLoaded, []);
    assert.deepEqual(result.unexpectedNetwork, []);
    assert.deepEqual(result.secretLikeFiles, []);
    assert.equal(result.liveExchangeWrite, false);
    assert.equal(result.productionCredentialUsed, false);
    assert.equal(result.probeExitCode, 0);
    assert.notEqual(result.unavailableVenueExitCode, 0);
    assert.match(result.unavailableVenueError, /CANARY_VENUE_UNAVAILABLE:nado/);
    assert.match(result.lockfileSha256, /^[0-9a-f]{64}$/);
    assert.match(result.artifactSha256, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(path.join(ROOT, CANARY_MANIFEST_RELATIVE)), true);
  });
});
