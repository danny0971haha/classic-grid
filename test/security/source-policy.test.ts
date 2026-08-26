import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readCanaryManifest, repoRootFromHere } from "../../scripts/security/extended-canary-boundary.js";
import { scanCanarySourceText } from "../../scripts/security/extended-canary-boundary.js";
import {
  analyzeCanarySourcePolicy,
  analyzeSourceText,
} from "../../scripts/security/source-policy.js";
import type { CanaryFileManifest } from "../../scripts/security/canary-manifest-schema.js";

const ROOT = repoRootFromHere();
const MANIFEST: CanaryFileManifest = readCanaryManifest(ROOT);

const VENDOR_SOURCE = `import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export class ExtendedExecutor {
  async connect() {
    const vendor = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../vendor/extended/exchange/index.js"
    );
    const mod = await import(pathToFileURL(vendor).href);
    return mod;
  }
}
`;

const LOOP_SOURCE = `export type LoopRuntimeBindings = {
  createExecutor?: unknown;
  refreshOfficialStats?: unknown;
  getOfficialCache?: unknown;
};
let boundCreateExecutor: unknown = null;
async function bindLoopRuntime(bindings?: LoopRuntimeBindings): Promise<void> {
  boundCreateExecutor =
    bindings?.createExecutor ?? (await import("./venues/index.js")).createExecutor;
  if (bindings?.refreshOfficialStats && bindings?.getOfficialCache) {
    return;
  }
  const official = await import("./officialStats.js");
  void official;
}
export async function runLoop(opts?: LoopRuntimeBindings): Promise<void> {
  await bindLoopRuntime(opts);
}
`;

function hits(source: string, file: string): string[] {
  return analyzeSourceText({ file, source, manifest: MANIFEST, repoRoot: ROOT }).findings.map(
    (row) => `${row.code}:${row.detail}`,
  );
}

describe("source-policy dynamic loaders", () => {
  it("PASS_BLOCKED: import(process.env) is rejected even when the env value is absent", () => {
    const result = hits(
      "const x = process.env.X;\nawait import(x);\n",
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.startsWith("UNRESOLVED_LOADER:")), result.join("\n"));
  });

  it("PASS_BLOCKED: require(process.env) is rejected", () => {
    const result = hits(
      "const x = process.env.X;\nrequire(x);\n",
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.startsWith("UNRESOLVED_LOADER:")), result.join("\n"));
  });

  it("PASS_BLOCKED: aliased require('viem') is rejected", () => {
    const result = hits(
      'const loader = require;\nloader("viem");\n',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.includes("viem")), result.join("\n"));
  });

  it("PASS_BLOCKED: computed globalThis require alias of viem is rejected", () => {
    const result = hits(
      'const loader = globalThis["requ" + "ire"];\nloader("viem");\n',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.includes("viem") || row.startsWith("UNRESOLVED_LOADER:")), result.join("\n"));
  });

  it("PASS_BLOCKED: module.require(process.env) is rejected", () => {
    const result = hits(
      "module.require(process.env.X);\n",
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.startsWith("UNRESOLVED_LOADER:")), result.join("\n"));
  });

  it("PASS_BLOCKED: process.getBuiltinModule('child_process') is rejected", () => {
    const result = hits(
      'process.getBuiltinModule("child_process");\n',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.includes("getBuiltin") || row.includes("FORBIDDEN_PRIMITIVE")), result.join("\n"));
  });

  it("PASS_BLOCKED: concatenated specifier import(name) is rejected", () => {
    const result = hits(
      "const suffix = process.env.S;\nconst name = `vi${suffix}`;\nimport(name);\n",
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.startsWith("UNRESOLVED_LOADER:")), result.join("\n"));
  });

  it("PASS_BLOCKED: import(process.env.MODULE_NAME) is rejected", () => {
    const result = hits(
      "await import(process.env.MODULE_NAME);\n",
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.startsWith("UNRESOLVED_LOADER:")), result.join("\n"));
  });

  it("PASS_BLOCKED: createRequire alias from node:module is rejected", () => {
    const result = hits(
      'const { createRequire: cr } = await import("node:module");\ncr(import.meta.url)(process.env.X);\n',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(
      result.some((row) => row.includes("createRequire") || row.startsWith("UNRESOLVED_LOADER:")),
      result.join("\n"),
    );
  });
});

describe("source-policy constructor and process escapes", () => {
  it("PASS_BLOCKED: computed Function constructor is rejected", () => {
    const result = hits(
      'globalThis["Fun" + "ction"]("return process")();\n',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.includes("function-ctor") || row.includes("Function")), result.join("\n"));
  });

  it("PASS_BLOCKED: Reflect.construct(Function) is rejected", () => {
    const result = hits(
      'Reflect.construct(Function, ["return process"]);\n',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.includes("Function") || row.includes("function-ctor")), result.join("\n"));
  });

  it("PASS_BLOCKED: arrow function .constructor is rejected", () => {
    const result = hits(
      '(() => {}).constructor("return process")();\n',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.includes("function-ctor") || row.includes("Function")), result.join("\n"));
  });

  it("PASS_BLOCKED: import('node:child_process') is rejected", () => {
    const result = hits(
      'await import("node:child_process");\n',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.includes("child_process")), result.join("\n"));
  });

  it("PASS_BLOCKED: import('node:vm') is rejected", () => {
    const result = hits(
      'await import("node:vm");\n',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.includes("vm")), result.join("\n"));
  });

  it("PASS_BLOCKED: import('node:worker_threads') is rejected", () => {
    const result = hits(
      'await import("node:worker_threads");\n',
      "src/cli/run-extended-canary.ts",
    );
    assert.ok(result.some((row) => row.includes("worker_threads")), result.join("\n"));
  });

  it("PASS_ALLOWED: TypeScript Function type annotations are not constructor calls", () => {
    const result = hits(
      "type Handler = Function;\nconst x: Function = undefined as never;\n",
      "src/types.ts",
    );
    assert.deepEqual(result, []);
  });
});

describe("source-policy approved vendor import", () => {
  it("PASS_ALLOWED: exact Extended vendor import is accepted", () => {
    const result = hits(VENDOR_SOURCE, "src/venues/extended.ts");
    assert.deepEqual(result, [], result.join("\n"));
  });

  it("PASS_ALLOWED: current src/venues/extended.ts matches the approved vendor AST", () => {
    const findings = analyzeCanarySourcePolicy(ROOT, MANIFEST).filter((row) =>
      row.file === "src/venues/extended.ts" && row.code !== "UNLISTED_LOCAL",
    );
    assert.deepEqual(findings, [], findings.map((row) => `${row.code}:${row.detail}`).join("\n"));
  });

  it("PASS_BLOCKED: import(pathToFileURL(other).href) is rejected", () => {
    const source = VENDOR_SOURCE.replace("pathToFileURL(vendor).href", "pathToFileURL(other).href");
    const result = hits(source, "src/venues/extended.ts");
    assert.ok(result.some((row) => row.startsWith("UNRESOLVED_LOADER:")), result.join("\n"));
  });

  it("PASS_BLOCKED: import(pathToFileURL(vendor + suffix).href) is rejected", () => {
    const source = VENDOR_SOURCE.replace(
      "pathToFileURL(vendor).href",
      "pathToFileURL(vendor + suffix).href",
    );
    const result = hits(source, "src/venues/extended.ts");
    assert.ok(result.some((row) => row.startsWith("UNRESOLVED_LOADER:")), result.join("\n"));
  });

  it("PASS_BLOCKED: import(pathToFileURL(process.env.VENDOR).href) is rejected", () => {
    const source = VENDOR_SOURCE.replace(
      "pathToFileURL(vendor).href",
      "pathToFileURL(process.env.VENDOR).href",
    );
    const result = hits(source, "src/venues/extended.ts");
    assert.ok(result.some((row) => row.startsWith("UNRESOLVED_LOADER:")), result.join("\n"));
  });

  it("PASS_BLOCKED: changed vendor path literal is rejected", () => {
    const source = VENDOR_SOURCE.replace(
      "../../vendor/extended/exchange/index.js",
      "../../vendor/extended/exchange/other.js",
    );
    const result = hits(source, "src/venues/extended.ts");
    assert.ok(result.some((row) => row.startsWith("UNRESOLVED_LOADER:") || row.includes("STALE")), result.join("\n"));
  });
});

describe("source-policy loop binding contract", () => {
  it("PASS_ALLOWED: current canary entrypoint supplies all three bindings", () => {
    const findings = analyzeCanarySourcePolicy(ROOT, MANIFEST).filter((row) => row.code === "ENTRYPOINT_BINDING");
    assert.deepEqual(findings, [], findings.map((row) => row.detail).join("\n"));
  });

  it("PASS_BLOCKED: removing one entrypoint binding fails", () => {
    const source = `import { runLoop } from "../loop.js";
await runLoop({
  once: true,
  createExecutor: createExtendedCanaryExecutor,
  getOfficialCache: getCanaryOfficialCache,
});
`;
    const result = analyzeSourceText({
      file: "src/cli/run-extended-canary.ts",
      source,
      manifest: MANIFEST,
      repoRoot: ROOT,
    });
    const policy = analyzeCanarySourcePolicy(
      ROOT,
      MANIFEST,
      new Map([["src/cli/run-extended-canary.ts", source]]),
    );
    assert.ok(
      result.runLoopCalls[0] && !result.runLoopCalls[0].bindings.includes("refreshOfficialStats"),
    );
    assert.ok(
      policy.some((row) => row.code === "ENTRYPOINT_BINDING" && row.detail.includes("refreshOfficialStats")),
      policy.map((row) => `${row.code}:${row.detail}`).join("\n"),
    );
  });

  it("PASS_BLOCKED: a second canary file calling runLoop without bindings fails", () => {
    const extra = 'import { runLoop } from "../loop.js";\nawait runLoop({ once: true });\n';
    const policy = analyzeCanarySourcePolicy(
      ROOT,
      {
        ...MANIFEST,
        runtimeFiles: [...MANIFEST.runtimeFiles, "src/cli/extra-canary.ts"].sort(),
        files: [...MANIFEST.files, "src/cli/extra-canary.ts"],
      },
      new Map([["src/cli/extra-canary.ts", extra]]),
    );
    assert.ok(
      policy.some((row) => row.code === "ENTRYPOINT_BINDING" && row.detail.includes("secondary-runLoop")),
      policy.map((row) => `${row.code}:${row.detail}`).join("\n"),
    );
  });

  it("PASS_BLOCKED: moving fallback imports outside bindLoopRuntime fails", () => {
    const source = LOOP_SOURCE.replace(
      "bindings?.createExecutor ?? (await import(\"./venues/index.js\")).createExecutor;",
      "null;",
    ).replace(
      "const official = await import(\"./officialStats.js\");",
      "null;",
    ) + `\nawait import("./venues/index.js");\nawait import("./officialStats.js");\n`;
    const result = hits(source, "src/loop.ts");
    assert.ok(result.some((row) => row.includes("venues/index.js") || row.includes("officialStats")), result.join("\n"));
  });

  it("PASS_BLOCKED: a third fallback import fails", () => {
    const source = LOOP_SOURCE.replace(
      "const official = await import(\"./officialStats.js\");",
      'const official = await import("./officialStats.js");\n  await import("./venues/n1.js");',
    );
    const result = hits(source, "src/loop.ts");
    assert.ok(result.some((row) => row.includes("n1.js") || row.includes("FORBIDDEN")), result.join("\n"));
  });

  it("PASS_ALLOWED: current loop fallbacks inside bindLoopRuntime are accepted", () => {
    const result = hits(LOOP_SOURCE, "src/loop.ts");
    assert.deepEqual(result, [], result.join("\n"));
  });
});

const POLICY_FILE = "src/types.ts";

function astFindings(source: string): string[] {
  return hits(source, POLICY_FILE);
}

function policyFindings(source: string): string[] {
  return analyzeCanarySourcePolicy(
    ROOT,
    MANIFEST,
    new Map([[POLICY_FILE, source]]),
  )
    .filter((row) =>
      row.file === POLICY_FILE
      && row.code !== "ENTRYPOINT_BINDING"
      && row.code !== "STALE_EXCEPTION"
      && row.code !== "UNLISTED_LOCAL"
    )
    .map((row) => `${row.code}:${row.detail}`);
}

function blockedByAstAndPolicy(source: string, label: string): string[] {
  const ast = astFindings(source);
  const policy = policyFindings(source);
  assert.ok(ast.length > 0, `${label} AST empty:\n${ast.join("\n")}`);
  assert.ok(policy.length > 0, `${label} analyzeCanarySourcePolicy empty:\n${policy.join("\n")}`);
  return ast;
}

describe("source-policy aliased and computed loader escapes", () => {
  it("PASS_BLOCKED: process.getBuiltinModule one-hop alias is rejected", () => {
    const source = 'const g = process.getBuiltinModule;\ng("child_process");\n';
    const result = blockedByAstAndPolicy(source, "getBuiltin_alias");
    assert.ok(
      result.some((row) => row.includes("getBuiltin") || row.startsWith("FORBIDDEN_PRIMITIVE:")),
      result.join("\n"),
    );
    assert.ok(scanCanarySourceText(source, POLICY_FILE).length > 0);
  });

  it("PASS_BLOCKED: Module._load one-hop alias is rejected", () => {
    const source = 'const L = Module._load;\nL("node:vm");\n';
    const result = blockedByAstAndPolicy(source, "Module_load_alias");
    assert.ok(
      result.some((row) => row.includes("module-load") || row.startsWith("FORBIDDEN_PRIMITIVE:")),
      result.join("\n"),
    );
    assert.ok(scanCanarySourceText(source, POLICY_FILE).length > 0);
  });

  it("PASS_BLOCKED: module.require one-hop alias is rejected", () => {
    const source = 'const mr = module.require;\nmr("node:vm");\n';
    const result = blockedByAstAndPolicy(source, "module_require_alias");
    assert.ok(
      result.some((row) =>
        row.includes("module-require")
        || row.includes("node:vm")
        || row.startsWith("FORBIDDEN_SPECIFIER:")
        || row.startsWith("UNRESOLVED_LOADER:"),
      ),
      result.join("\n"),
    );
    assert.ok(scanCanarySourceText(source, POLICY_FILE).length > 0);
  });

  it("PASS_BLOCKED: import.meta.resolve one-hop alias is rejected", () => {
    const source = 'const res = import.meta.resolve;\nres("viem");\n';
    const result = blockedByAstAndPolicy(source, "import_meta_resolve_alias");
    assert.ok(
      result.some((row) => row.includes("import-meta-resolve") || row.startsWith("FORBIDDEN_PRIMITIVE:")),
      result.join("\n"),
    );
    assert.ok(scanCanarySourceText(source, POLICY_FILE).length > 0);
  });

  it("PASS_BLOCKED: Reflect.construct one-hop alias is rejected", () => {
    const source = "const rc = Reflect.construct;\nrc(Function, []);\n";
    const result = blockedByAstAndPolicy(source, "Reflect_construct_alias");
    assert.ok(
      result.some((row) =>
        row.includes("reflect-construct")
        || row.includes("Function")
        || row.includes("function-ctor"),
      ),
      result.join("\n"),
    );
    assert.ok(scanCanarySourceText(source, POLICY_FILE).length > 0);
  });

  it("PASS_BLOCKED: globalThis require destructure alias is rejected", () => {
    const source = 'const { require: r } = globalThis;\nr("node:vm");\n';
    const result = blockedByAstAndPolicy(source, "globalThis_require_destructure");
    assert.ok(
      result.some((row) =>
        row.includes("require")
        || row.includes("node:vm")
        || row.startsWith("FORBIDDEN_SPECIFIER:")
        || row.startsWith("FORBIDDEN_PRIMITIVE:"),
      ),
      result.join("\n"),
    );
    assert.ok(scanCanarySourceText(source, POLICY_FILE).length > 0);
  });

  it("PASS_BLOCKED: unresolved computed globalThis dispatch is rejected", () => {
    const source = 'globalThis[k]("return 1")();\n';
    const result = blockedByAstAndPolicy(source, "unknown_computed_global_dispatch");
    assert.ok(
      result.some((row) => row.startsWith("UNRESOLVED_COMPUTED_DISPATCH:")),
      result.join("\n"),
    );
    assert.ok(scanCanarySourceText(source, POLICY_FILE).length > 0);
  });

  it("PASS_BLOCKED: two-hop globalThis.require alias is rejected", () => {
    const source = 'const a = globalThis.require;\nconst b = a;\nb("node:vm");\n';
    const result = blockedByAstAndPolicy(source, "two_hop_require");
    assert.ok(
      result.some((row) =>
        row.includes("require")
        || row.includes("node:vm")
        || row.startsWith("FORBIDDEN_SPECIFIER:"),
      ),
      result.join("\n"),
    );
  });

  it("PASS_BLOCKED: Function constructor alias is rejected", () => {
    const source = 'const F = Function;\nnew F("return process")();\n';
    const result = blockedByAstAndPolicy(source, "Function_alias");
    assert.ok(
      result.some((row) => row.includes("Function") || row.includes("function-ctor")),
      result.join("\n"),
    );
  });

  it("PASS_BLOCKED: getBuiltin alias result is still classified", () => {
    const source = 'const gb = process.getBuiltinModule;\nconst cp = gb("child_process");\n';
    const result = blockedByAstAndPolicy(source, "getBuiltin_alias_result");
    assert.ok(
      result.some((row) => row.includes("getBuiltin") || row.startsWith("FORBIDDEN_PRIMITIVE:")),
      result.join("\n"),
    );
  });

  it("PASS_BLOCKED: globalThis eval destructure is rejected", () => {
    const source = 'const { eval: e } = globalThis;\ne("1+1");\n';
    const result = blockedByAstAndPolicy(source, "eval_destructure");
    assert.ok(
      result.some((row) => row.includes("eval") || row.startsWith("FORBIDDEN_PRIMITIVE:")),
      result.join("\n"),
    );
  });

  it("PASS_BLOCKED: globalThis require shorthand destructure is rejected", () => {
    const source = 'const { require } = globalThis;\nrequire("node:vm");\n';
    const result = blockedByAstAndPolicy(source, "require_shorthand_destructure");
    assert.ok(
      result.some((row) =>
        row.includes("require")
        || row.includes("node:vm")
        || row.startsWith("FORBIDDEN_PRIMITIVE:")
        || row.startsWith("FORBIDDEN_SPECIFIER:"),
      ),
      result.join("\n"),
    );
  });

  it("PASS_BLOCKED: constant-folded computed globalThis require is rejected", () => {
    const source = 'const key = "requ" + "ire";\nglobalThis[key]("node:vm");\n';
    const result = blockedByAstAndPolicy(source, "folded_computed_require");
    assert.ok(
      result.some((row) =>
        row.includes("require")
        || row.includes("node:vm")
        || row.startsWith("UNRESOLVED_COMPUTED_DISPATCH:")
        || row.startsWith("FORBIDDEN_SPECIFIER:")
        || row.startsWith("FORBIDDEN_PRIMITIVE:"),
      ),
      result.join("\n"),
    );
  });

  it("PASS_BLOCKED: two-hop getBuiltin alias is rejected", () => {
    const source = 'const a = process.getBuiltinModule;\nconst b = a;\nb("child_process");\n';
    const result = blockedByAstAndPolicy(source, "two_hop_getBuiltin");
    assert.ok(
      result.some((row) => row.includes("getBuiltin") || row.startsWith("FORBIDDEN_PRIMITIVE:")),
      result.join("\n"),
    );
  });

  it("PASS_BLOCKED: unresolved computed process dispatch is rejected", () => {
    const source = "process[k]();\n";
    const result = blockedByAstAndPolicy(source, "process_computed");
    assert.ok(
      result.some((row) => row.startsWith("UNRESOLVED_COMPUTED_DISPATCH:")),
      result.join("\n"),
    );
  });

  it("PASS_ALLOWED: ordinary function aliasing is not treated as a loader", () => {
    const source = `function add(a: number, b: number): number { return a + b; }
const fn = add;
fn(1, 2);
`;
    assert.deepEqual(astFindings(source), [], astFindings(source).join("\n"));
    assert.deepEqual(scanCanarySourceText(source, POLICY_FILE), []);
  });

  it("PASS_ALLOWED: ordinary computed property access on a local object is accepted", () => {
    const source = `const obj = { run: (x: number) => x };
const k = "run";
obj[k](1);
`;
    assert.deepEqual(astFindings(source), [], astFindings(source).join("\n"));
    assert.deepEqual(scanCanarySourceText(source, POLICY_FILE), []);
  });

  it("PASS_ALLOWED: process.env reads remain accepted", () => {
    const source = "const x = process.env.EXPERIMENT_MODE;\n";
    assert.deepEqual(astFindings(source), [], astFindings(source).join("\n"));
    assert.deepEqual(scanCanarySourceText(source, POLICY_FILE), []);
  });
});
