import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canaryPackageRootFromInstall,
  runCanaryOfflineProbe,
} from "../../../scripts/security/extended-canary-boundary.js";
import { assertCanaryModuleGraph } from "../../../scripts/security/module-graph.js";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const targetRoot = path.resolve(arg("--target-root"));
const installDir = path.resolve(arg("--install-dir"));
const outDir = path.resolve(arg("--out-dir"));
fs.mkdirSync(outDir, { recursive: true });

const canaryRoot = canaryPackageRootFromInstall(installDir);
const started = new Date().toISOString();
const probe = runCanaryOfflineProbe({ canaryRoot, cwd: installDir, repoRoot: targetRoot });
const unavailable = runCanaryOfflineProbe({
  canaryRoot,
  cwd: installDir,
  repoRoot: targetRoot,
  extraEnv: { VENUES: "nado" },
});
const ended = new Date().toISOString();

let moduleGraphHits: string[] = [];
let moduleGraphError = probe.moduleGraphError;
if (!moduleGraphError) {
  moduleGraphHits = assertCanaryModuleGraph({
    records: probe.moduleGraph,
    canaryRoot,
    repoRoot: targetRoot,
  });
}

fs.writeFileSync(path.join(outDir, "probe-stdout.txt"), probe.stdout);
fs.writeFileSync(path.join(outDir, "probe-stderr.txt"), probe.stderr);
fs.writeFileSync(path.join(outDir, "probe-module-graph.json"), `${JSON.stringify(probe.moduleGraph, null, 2)}\n`);
fs.writeFileSync(
  path.join(outDir, "loaded-modules.txt"),
  `${[...new Set(probe.loadedModules)].sort().join("\n")}\n`,
);
fs.writeFileSync(
  path.join(outDir, "unavailable-venue.txt"),
  `${unavailable.stdout}\n--- stderr ---\n${unavailable.stderr}\n`,
);

const payload = {
  schema: "classic-canary-userspace-probe/20260908",
  isolation: "USERSPACE_PROBE_ONLY_NOT_LINUX_SECCOMP",
  kernel_isolation_equivalent: false,
  started_at_utc: started,
  ended_at_utc: ended,
  tool_file: fileURLToPath(import.meta.url),
  probe: {
    exitCode: probe.exitCode,
    forbiddenLoaded: probe.forbiddenLoaded,
    unexpectedNetwork: probe.unexpectedNetwork,
    liveExchangeWrite: probe.liveExchangeWrite,
    productionCredentialUsed: probe.productionCredentialUsed,
    loadedModuleInventory: [...new Set(probe.loadedModules)].sort(),
    moduleGraphHits,
    moduleGraphError: moduleGraphError ?? null,
  },
  unavailable_venue: {
    extraEnv: { VENUES: "nado" },
    exitCode: unavailable.exitCode,
    stdout_stderr: `${unavailable.stdout}\n${unavailable.stderr}`.slice(0, 4000),
  },
};
fs.writeFileSync(path.join(outDir, "userspace-probe.json"), `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
