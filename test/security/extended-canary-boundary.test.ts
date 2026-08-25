import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CANARY_LOCKFILE_RELATIVE,
  CANARY_PACKAGE_JSON_RELATIVE,
  CANARY_VENUE_UNAVAILABLE,
  FORBIDDEN_CANARY_PACKAGES,
  FORBIDDEN_NESTED_WS_PATH,
  forbiddenPackagesPresentInLockfile,
  isForbiddenModuleSpecifier,
  readCanaryManifest,
  repoRootFromHere,
} from "../../scripts/security/extended-canary-boundary.js";
import {
  assertCanaryVenueSelection,
  createExtendedCanaryExecutor,
} from "../../src/venues/extendedFactory.js";
import { canaryVenueUnavailableError } from "../../src/venues/factory.js";

const ROOT = repoRootFromHere();

describe("extended canary dependency boundary (unit)", () => {
  it("fails closed when a canary factory is asked for an uninstalled venue", () => {
    const error = canaryVenueUnavailableError("nado");
    assert.equal(error.message, `${CANARY_VENUE_UNAVAILABLE}:nado`);
    assert.throws(
      () => createExtendedCanaryExecutor("nado", true),
      (err: Error) => err.message === `${CANARY_VENUE_UNAVAILABLE}:nado`,
    );
    assert.throws(
      () => createExtendedCanaryExecutor("phoenix", true),
      (err: Error) => err.message === `${CANARY_VENUE_UNAVAILABLE}:phoenix`,
    );
    assert.throws(
      () => createExtendedCanaryExecutor("popdex", true),
      (err: Error) => err.message === `${CANARY_VENUE_UNAVAILABLE}:popdex`,
    );
    const extended = createExtendedCanaryExecutor("extended", true);
    assert.equal(extended.id, "extended");
  });

  it("fails closed on VENUES selection and never remaps to extended", () => {
    assert.throws(
      () => assertCanaryVenueSelection("nado"),
      (err: Error) => err.message === `${CANARY_VENUE_UNAVAILABLE}:nado`,
    );
    assert.throws(
      () => assertCanaryVenueSelection("extended,nado"),
      (err: Error) => err.message === `${CANARY_VENUE_UNAVAILABLE}:nado`,
    );
    assert.throws(
      () => assertCanaryVenueSelection("risex"),
      (err: Error) => err.message === `${CANARY_VENUE_UNAVAILABLE}:risex`,
    );
    assert.deepEqual(assertCanaryVenueSelection("extended"), ["extended"]);
    assert.deepEqual(assertCanaryVenueSelection(undefined), ["extended"]);
  });

  it("does not statically import unselected venue adapters from the canary entry or loop", () => {
    const loop = fs.readFileSync(path.join(ROOT, "src/loop.ts"), "utf8");
    const entry = fs.readFileSync(path.join(ROOT, "src/cli/run-extended-canary.ts"), "utf8");
    const factory = fs.readFileSync(path.join(ROOT, "src/venues/extendedFactory.ts"), "utf8");
    for (const src of [loop, entry, factory]) {
      assert.equal(src.includes('from "./venues/index.js"'), false);
      assert.equal(src.includes("from \"./n1.js\""), false);
      assert.equal(src.includes("from \"./phoenix.js\""), false);
      assert.equal(src.includes("from \"./nado.js\""), false);
      assert.equal(src.includes("from \"./popdex.js\""), false);
      assert.equal(src.includes("@n1xyz/nord-ts"), false);
      assert.equal(src.includes("@solana/web3.js"), false);
      assert.equal(src.includes("@nadohq/client"), false);
      assert.equal(src.includes('from "viem"'), false);
    }
    assert.match(loop, /await import\("\.\/venues\/index\.js"\)/);
    assert.match(entry, /createExtendedCanaryExecutor/);
  });

  it("keeps global/root High packages in the repository manifest and not in the canary manifest", () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const canaryPkg = JSON.parse(fs.readFileSync(path.join(ROOT, CANARY_PACKAGE_JSON_RELATIVE), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.ok(rootPkg.dependencies["@n1xyz/nord-ts"]);
    assert.ok(rootPkg.dependencies["@nadohq/client"]);
    assert.ok(rootPkg.dependencies["@nadohq/shared"]);
    assert.ok(rootPkg.dependencies["@solana/web3.js"]);
    assert.ok(rootPkg.dependencies.viem);
    assert.equal(canaryPkg.dependencies["@n1xyz/nord-ts"], undefined);
    assert.equal(canaryPkg.dependencies["@nadohq/client"], undefined);
    assert.equal(canaryPkg.dependencies["@nadohq/shared"], undefined);
    assert.equal(canaryPkg.dependencies["@solana/web3.js"], undefined);
    assert.equal(canaryPkg.dependencies.viem, undefined);
    assert.ok(canaryPkg.dependencies.tsx);
    assert.ok(canaryPkg.dependencies.ws);
    assert.ok(canaryPkg.dependencies.undici);
    const manifest = readCanaryManifest(ROOT);
    assert.equal(manifest.files.includes("src/venues/index.ts"), false);
    assert.equal(manifest.files.includes("src/venues/n1.ts"), false);
    assert.equal(manifest.files.includes("src/venues/nado.ts"), false);
    assert.equal(manifest.files.includes("src/venues/phoenix.ts"), false);
    assert.equal(manifest.files.includes("src/venues/popdex.ts"), false);
    assert.equal(manifest.files.includes("src/officialStats.ts"), false);
    assert.ok(manifest.files.includes("src/cli/run-extended-canary.ts"));
    assert.ok(manifest.files.includes("src/venues/extended.ts"));
  });

  it("canary lockfile does not contain forbidden High package paths", () => {
    const lock = fs.readFileSync(path.join(ROOT, CANARY_LOCKFILE_RELATIVE), "utf8");
    assert.deepEqual(forbiddenPackagesPresentInLockfile(lock), []);
    assert.equal(lock.includes(FORBIDDEN_NESTED_WS_PATH), false);
    for (const name of FORBIDDEN_CANARY_PACKAGES) {
      assert.equal(lock.includes(`"node_modules/${name}"`), false, name);
    }
  });

  it("module specifier matcher treats nested viem ws as forbidden and direct ws as allowed", () => {
    assert.equal(isForbiddenModuleSpecifier("ws"), false);
    assert.equal(isForbiddenModuleSpecifier("viem"), true);
    assert.equal(isForbiddenModuleSpecifier("@nadohq/client"), true);
    assert.equal(isForbiddenModuleSpecifier("/tmp/node_modules/viem/node_modules/ws/index.js"), true);
    assert.equal(isForbiddenModuleSpecifier("bigint-buffer"), true);
  });

  it("does not convert canary isolation into global clearance text", () => {
    const security = fs.readFileSync(path.join(ROOT, "SECURITY.md"), "utf8");
    const baseline = fs.readFileSync(path.join(ROOT, "docs/security-audit-baseline.md"), "utf8");
    const corrective = fs.readFileSync(
      path.join(ROOT, "docs/classic-v0.2-dependency-boundary-corrective-1.md"),
      "utf8",
    );
    for (const text of [security, baseline, corrective]) {
      assert.match(text, /DEPENDENCY_SECURITY_CLEARANCE=NO/);
      assert.match(text, /LIVE_RELEASE_BLOCKED=YES/);
      assert.equal(text.includes("GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=YES"), false);
      assert.equal(/\bPASS\b/.test(text) && text.includes("independentReview=ACCEPT"), false);
    }
    assert.match(corrective, /EXTENDED_CANARY_DEPENDENCY_BOUNDARY=REVIEW_CANDIDATE/);
    assert.match(corrective, /independentReview=NOT_PERFORMED/);
    assert.match(corrective, /gateStatus=NOT_EMITTED/);
  });

  it("Checkpoint E and F evidence identity rules remain intact", () => {
    const e = fs.readFileSync(path.join(ROOT, "tools/checkpoint-e-evidence.ts"), "utf8");
    const f = fs.readFileSync(path.join(ROOT, "tools/checkpoint-f-evidence.ts"), "utf8");
    assert.match(e, /classic-v0\.2-checkpoint-e\/3/);
    assert.match(f, /classic-v0\.2-checkpoint-f\/2/);
    assert.match(e, /CHECKPOINT_E_SOURCE_HEAD_SHA/);
    assert.match(e, /STALE_SOURCE_HEAD_SHA/);
    assert.match(f, /SOURCE_HEAD_SHA_ENV/);
    assert.match(f, /IDENTITY_COLLISION/);
    assert.match(f, /SOURCE_IDENTITY_CONFLICT/);
    assert.match(f, /requestedVerdict/);
  });
});
