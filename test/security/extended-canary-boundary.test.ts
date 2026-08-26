import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CANARY_LOCKFILE_RELATIVE,
  CANARY_PACKAGE_JSON_RELATIVE,
  CANARY_VENUE_UNAVAILABLE,
  FORBIDDEN_CANARY_PACKAGES,
  FORBIDDEN_NESTED_WS_PATH,
  assertCanarySourceBoundary,
  forbiddenPackagesPresentInLockfile,
  isForbiddenModuleSpecifier,
  normalizeModuleSpecifier,
  readCanaryManifest,
  repoRootFromHere,
  scanCanarySourceText,
  scanCanaryTree,
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

describe("extended canary boundary adversarial checks", () => {
  it("PASS_BLOCKED: dynamic import literal of a forbidden venue file is rejected", () => {
    const hits = scanCanarySourceText('await import("./venues/n1.js");', "src/cli/run-extended-canary.ts");
    assert.ok(hits.some((hit) => hit.includes("n1.js")));
  });

  it("PASS_ALLOWED: loop.ts keeps the fail-closed literal fallback import of venues/index.js", () => {
    const hits = scanCanarySourceText(
      'bindings?.createExecutor ?? (await import("./venues/index.js")).createExecutor;',
      "src/loop.ts",
    );
    assert.deepEqual(hits, []);
  });

  it("PASS_BLOCKED: non-literal import concatenation of n1.js is rejected", () => {
    const hits = scanCanarySourceText(
      'await import("./venues/" + "n1.js");',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(hits.some((hit) => hit.includes("n1.js")));
  });

  it("PASS_ALLOWED: Extended vendor import(pathToFileURL(vendor).href) stays allowed", () => {
    const hits = scanCanarySourceText(
      "const mod = await import(pathToFileURL(vendor).href);",
      "src/venues/extended.ts",
    );
    assert.deepEqual(hits, []);
  });

  it("PASS_BLOCKED: require, require.resolve, and module.createRequire of viem are rejected", () => {
    assert.ok(scanCanarySourceText('require("viem")', "src/loop.ts").length > 0);
    assert.ok(scanCanarySourceText('require.resolve("viem")', "src/loop.ts").length > 0);
    assert.ok(
      scanCanarySourceText('module.createRequire(import.meta.url)("viem")', "src/loop.ts")
        .some((hit) => hit === "createRequire" || hit.includes("viem")),
    );
    assert.equal(isForbiddenModuleSpecifier("viem"), true);
  });

  it("PASS_BLOCKED: non-literal require concat, template, and comment forms of viem are rejected", () => {
    assert.ok(scanCanarySourceText('require("vi" + "em")', "src/loop.ts").some((hit) => hit.includes("viem")));
    assert.ok(scanCanarySourceText("require(`viem`)", "src/loop.ts").some((hit) => hit.includes("viem")));
    assert.ok(scanCanarySourceText('require(/*x*/ "viem")', "src/loop.ts").some((hit) => hit.includes("viem")));
    assert.ok(
      scanCanarySourceText('require.resolve("vi" + "em")', "src/loop.ts").some((hit) => hit.includes("viem")),
    );
  });

  it("PASS_BLOCKED: aliased createRequire import is rejected", () => {
    const hits = scanCanarySourceText(
      'import { createRequire as cr } from "node:module"; cr(import.meta.url)("viem");',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(hits.includes("createRequire"));
  });

  it("PASS_BLOCKED: path tricks that previously bypassed the matcher now resolve to viem", () => {
    const payloads = [
      "node_modules/viem",
      "/tmp/node_modules//viem/index.js",
      "/tmp/node_modules/./viem/index.js",
      "/tmp/node_modules/viem/../viem/index.js",
      "file:///tmp/node_modules/viem/index.js",
      "file:///tmp/node_modules/viem%2Findex.js",
      "/tmp/node_modules/viem%2Findex.js",
      String.raw`C:\tmp\node_modules\viem\index.js`,
    ];
    for (const payload of payloads) {
      assert.equal(isForbiddenModuleSpecifier(payload), true, payload);
      assert.ok(normalizeModuleSpecifier(payload).replaceAll("\\", "/").includes("viem"), payload);
    }
  });

  it("PASS_ALLOWED: direct ws and node builtins are not High-package forbidden specifiers", () => {
    assert.equal(isForbiddenModuleSpecifier("ws"), false);
    assert.equal(isForbiddenModuleSpecifier("node:net"), false);
    assert.equal(isForbiddenModuleSpecifier("node:tls"), false);
    assert.equal(isForbiddenModuleSpecifier("node:http"), false);
    assert.equal(isForbiddenModuleSpecifier("node:https"), false);
    assert.equal(isForbiddenModuleSpecifier("node:dgram"), false);
  });

  it("PASS_BLOCKED: symlink canary sources that resolve to a different path are rejected", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "classic-canary-symlink-"));
    try {
      fs.mkdirSync(path.join(tmp, "src", "venues"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "src", "venues", "n1.ts"), "export const x = 1;\n");
      fs.symlinkSync(path.join(tmp, "src", "venues", "n1.ts"), path.join(tmp, "src", "venues", "extended.ts"));
      assert.throws(
        () => assertCanarySourceBoundary(tmp, "src/venues/extended.ts"),
        (err: Error) => String(err.message).startsWith("CANARY_SYMLINK_SOURCE:"),
      );
      assert.equal(assertCanarySourceBoundary(tmp, "src/venues/n1.ts").endsWith(`${path.sep}n1.ts`), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("PASS_BLOCKED: production canary tree has no tls/dgram imports, eval, or Function constructor", () => {
    const hits = scanCanaryTree(ROOT);
    assert.deepEqual(hits, []);
    const manifest = readCanaryManifest(ROOT);
    for (const rel of manifest.files) {
      if (!rel.endsWith(".ts") && !rel.endsWith(".js")) continue;
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.equal(/\bfrom\s+["']node:(tls|dgram)["']/.test(text), false, rel);
      assert.equal(/\bfrom\s+["'](tls|dgram)["']/.test(text), false, rel);
    }
  });

  it("PASS_ALLOWED: node:net (lease) and node:http (dashboard) remain in the canary tree", () => {
    const lease = fs.readFileSync(path.join(ROOT, "src/runtimeLease.ts"), "utf8");
    const dashboard = fs.readFileSync(path.join(ROOT, "src/dashboard.ts"), "utf8");
    assert.match(lease, /from "node:net"/);
    assert.match(dashboard, /from "node:http"/);
  });

  it("PASS_ALLOWED: process.env reads in canary config/loadEnv are expected and not treated as High-package loads", () => {
    const config = fs.readFileSync(path.join(ROOT, "src/config.ts"), "utf8");
    const loadEnv = fs.readFileSync(path.join(ROOT, "src/loadEnv.ts"), "utf8");
    assert.match(config, /process\.env/);
    assert.match(loadEnv, /process\.env/);
    assert.equal(isForbiddenModuleSpecifier("process"), false);
    assert.equal(isForbiddenModuleSpecifier("node:process"), false);
    const hits = scanCanarySourceText("const x = process.env.EXPERIMENT_MODE;", "src/config.ts");
    assert.deepEqual(hits, []);
  });

  it("PASS_BLOCKED: eval, Function constructor, and (0, eval) forms are rejected in canary source text", () => {
    assert.ok(scanCanarySourceText("eval('import(\"viem\")')", "src/loop.ts").includes("eval"));
    assert.ok(scanCanarySourceText("new Function('return 1')", "src/loop.ts").includes("Function"));
    assert.ok(scanCanarySourceText("(0, eval)('1')", "src/loop.ts").includes("eval"));
    assert.ok(scanCanarySourceText("(0, Function)('return 1')", "src/loop.ts").includes("Function"));
    assert.ok(scanCanarySourceText("globalThis.eval('1')", "src/loop.ts").includes("eval"));
    assert.ok(scanCanarySourceText("globalThis['eval']('1')", "src/loop.ts").includes("eval"));
  });

  it("PASS_BLOCKED: executable Function() without new and globalThis.Function forms are rejected", () => {
    assert.ok(scanCanarySourceText("Function('return 1')", "src/loop.ts").includes("Function"));
    assert.ok(scanCanarySourceText("globalThis.Function('return 1')", "src/loop.ts").includes("Function"));
    assert.ok(scanCanarySourceText("globalThis['Function']('return 1')", "src/loop.ts").includes("Function"));
    assert.ok(scanCanarySourceText("const F = Function; F('return 1')", "src/loop.ts").includes("Function"));
    assert.ok(scanCanarySourceText("const e = eval; e('1')", "src/loop.ts").includes("eval"));
  });

  it("PASS_ALLOWED: TypeScript Function type annotations are not treated as constructor calls", () => {
    const hits = scanCanarySourceText(
      "type Handler = Function;\nconst x: Function = undefined as never;",
      "src/types.ts",
    );
    assert.deepEqual(hits, []);
  });

  it("PASS_BLOCKED: canary source may not import tls, dgram, or https", () => {
    assert.ok(scanCanarySourceText('import tls from "node:tls";', "src/loop.ts").some((hit) => hit.includes("tls")));
    assert.ok(scanCanarySourceText('import dgram from "node:dgram";', "src/loop.ts").some((hit) => hit.includes("dgram")));
    assert.ok(scanCanarySourceText('import https from "node:https";', "src/loop.ts").some((hit) => hit.includes("https")));
    assert.ok(scanCanarySourceText('await import("node:tls");', "src/loop.ts").some((hit) => hit.includes("tls")));
    assert.ok(scanCanarySourceText('require("dgram");', "src/loop.ts").some((hit) => hit.includes("dgram")));
    assert.ok(scanCanarySourceText('require("https");', "src/loop.ts").some((hit) => hit.includes("https")));
  });

  it("PASS_ALLOWED: node:http and node:net remain allowed in canary source text", () => {
    assert.deepEqual(scanCanarySourceText('import http from "node:http";', "src/dashboard.ts"), []);
    assert.deepEqual(scanCanarySourceText('import net from "node:net";', "src/runtimeLease.ts"), []);
  });
});
