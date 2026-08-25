import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitEnv, isTrackedManifestPath } from "./action-git-index.js";
import {
  APPROVED_DOCKER_ACTIONS,
  APPROVED_EXTERNAL_ACTIONS,
  inventoryGitRepository,
  type ActionPinInventory,
} from "./action-pin-policy.js";
import { actionInventoryDocument, repoPath } from "./audit-policy.js";
import { repoRootFromHere, SECURITY_ARTIFACT_DIR } from "./audit-baseline.js";

type Check = { ok: boolean; message: string };

function gitLsFilesStage(root: string): string[] {
  const spawned = spawnSync("git", ["ls-files", "-z", "--stage"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    env: gitEnv(),
  });
  if (spawned.status !== 0 || spawned.error) {
    throw new Error(`independent git ls-files failed: ${(spawned.stderr ?? Buffer.alloc(0)).toString("utf8")}`);
  }
  const buf = spawned.stdout ?? Buffer.alloc(0);
  const paths: string[] = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i += 1) {
    if (i === buf.length || buf[i] === 0) {
      if (i > start) {
        const rec = buf.subarray(start, i).toString("utf8");
        const tab = rec.indexOf("\t");
        if (tab < 0) throw new Error("independent git ls-files record missing tab");
        paths.push(rec.slice(tab + 1));
      }
      start = i + 1;
    }
  }
  return paths;
}

function equalSet(a: string[], b: string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function approvedTuple(identity: string, ref: string | null): boolean {
  return APPROVED_EXTERNAL_ACTIONS.some((row) => row.identity === identity && row.sha === ref);
}

function dockerApproved(raw: string): boolean {
  return APPROVED_DOCKER_ACTIONS.some((row) => raw === `docker://${row.image}@${row.digest}`);
}

function cycleFree(inventory: ActionPinInventory): boolean {
  if (inventory.graph.cycles.length > 0) return false;
  const adj = new Map<string, string[]>();
  for (const edge of inventory.graph.edges) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }
  const visiting = new Set<string>();
  const seen = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return false;
    if (seen.has(node)) return true;
    visiting.add(node);
    for (const next of adj.get(node) ?? []) {
      if (!visit(next)) return false;
    }
    visiting.delete(node);
    seen.add(node);
    return true;
  };
  return inventory.graph.nodes.every((node) => visit(node));
}

function localGraphComplete(inventory: ActionPinInventory): boolean {
  for (const row of inventory.occurrences) {
    if (row.kind !== "local" && row.kind !== "reusable-local") continue;
    if (row.codes.includes("ACTION_LOCAL_PATH_UNSAFE") || row.codes.includes("ACTION_USES_DYNAMIC")) continue;
    const edge = inventory.graph.edges.find((item) => item.from === row.file && (
      row.raw.endsWith(item.to) || item.to === row.identity.replace(/^\.\//, "")
    ));
    if (!edge) return false;
  }
  return true;
}

export function verifyActionInventory(root = repoRootFromHere(), inventory?: ActionPinInventory): Check[] {
  const current = inventory ?? inventoryGitRepository(root, { requireProductionPins: true });
  const independentManifests = gitLsFilesStage(root).filter((posixPath) => isTrackedManifestPath(posixPath)).sort();
  const checks: Check[] = [];
  checks.push({
    ok: equalSet(independentManifests, current.trackedManifests),
    message: "independent git ls-files manifests equal inventory.trackedManifests",
  });
  checks.push({
    ok: independentManifests.every((posixPath) => current.scannedFiles.includes(posixPath)),
    message: "every tracked workflow/action manifest is in inventory.scannedFiles",
  });
  checks.push({
    ok: current.scannedFiles.every((posixPath) => (
      independentManifests.includes(posixPath)
      || current.graph.nodes.includes(posixPath)
    )),
    message: "inventory has no extra untracked scan roots",
  });
  const missingIndependent = independentManifests.filter((posixPath) => !current.scannedFiles.includes(posixPath));
  checks.push({
    ok: missingIndependent.length === 0,
    message: missingIndependent.length === 0
      ? "no missed tracked manifests"
      : `missed tracked manifests: ${missingIndependent.join(",")}`,
  });
  const externalOk = current.occurrences
    .filter((row) => row.kind === "external")
    .every((row) => row.allowlisted === true && approvedTuple(row.identity, row.ref));
  checks.push({
    ok: current.overallPolicyOk ? externalOk : true,
    message: "every passing external Action matches an exact allowlist tuple",
  });
  if (current.overallPolicyOk) {
    checks.push({
      ok: current.occurrences.filter((row) => row.kind === "external").every((row) => approvedTuple(row.identity, row.ref)),
      message: "allowlist tuples are exact identity+SHA",
    });
  }
  checks.push({
    ok: current.overallPolicyOk ? localGraphComplete(current) && cycleFree(current) : cycleFree(current) || current.codes.includes("ACTION_LOCAL_CYCLE"),
    message: "local Action/reusable workflow graph is complete and reports cycles",
  });
  const dockerOk = current.occurrences
    .filter((row) => row.kind === "docker")
    .every((row) => dockerApproved(row.raw));
  checks.push({
    ok: current.dockerActionCount === 0 || (APPROVED_DOCKER_ACTIONS.length > 0 && dockerOk),
    message: current.dockerActionCount === 0
      ? "no Docker Actions"
      : "every Docker Action matches exact image+digest allowlist",
  });
  if (current.overallPolicyOk) {
    checks.push({
      ok: current.graph.cycles.length === 0 && cycleFree(current),
      message: "passing inventory has an acyclic local graph",
    });
    checks.push({
      ok: current.codes.length === 1 && current.codes[0] === "PASS",
      message: "passing inventory codes are PASS",
    });
  }
  return checks;
}

function isMain(argv1: string | undefined): boolean {
  return typeof argv1 === "string" && pathToFileURL(path.resolve(argv1)).href === import.meta.url;
}

function main(): void {
  const root = repoRootFromHere();
  const inventory = inventoryGitRepository(root, { requireProductionPins: true });
  const outFile = repoPath(root, path.join(SECURITY_ARTIFACT_DIR, "action-pin-inventory.json"));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (!fs.existsSync(outFile)) {
    fs.writeFileSync(outFile, `${JSON.stringify(actionInventoryDocument(inventory), null, 2)}\n`);
  }
  const fromDisk = JSON.parse(fs.readFileSync(outFile, "utf8")) as ActionPinInventory;
  if (fromDisk.schemaVersion !== inventory.schemaVersion) {
    console.error(JSON.stringify({ ok: false, reason: "inventory schema mismatch" }, null, 2));
    process.exit(1);
  }
  const checks = verifyActionInventory(root, inventory);
  const ok = inventory.overallPolicyOk && checks.every((row) => row.ok);
  const payload = {
    ok,
    overallPolicyOk: inventory.overallPolicyOk,
    codes: inventory.codes,
    trackedManifests: inventory.trackedManifests,
    scannedFiles: inventory.scannedFiles,
    actionUsesTotal: inventory.actionUsesTotal,
    dockerActionCount: inventory.dockerActionCount,
    graphCycles: inventory.graph.cycles.length,
    checks,
  };
  if (!ok) {
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(payload, null, 2));
}

if (isMain(process.argv[1])) {
  main();
}
