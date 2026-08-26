import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MODULE_GRAPH_SCHEMA } from "./canary-manifest-schema.js";

export type ModuleGraphRecord = {
  schemaVersion: typeof MODULE_GRAPH_SCHEMA;
  specifier: string;
  parentURL: string | null;
  resolvedURL: string;
};

export const VERIFIER_BOOTSTRAP_RELATIVE = [
  "scripts/security/register-module-load-hook.mjs",
  "scripts/security/module-load-hook.mjs",
  "scripts/security/canary-offline-probe.ts",
] as const;

function asFilePath(url: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  try {
    return fs.realpathSync(fileURLToPath(url));
  } catch {
    try {
      return fileURLToPath(url);
    } catch {
      return undefined;
    }
  }
}

function isUnder(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isBuiltin(url: string): boolean {
  return url.startsWith("node:") || url.startsWith("node:") || url === "node:module";
}

export function parseModuleGraphLog(raw: string): ModuleGraphRecord[] {
  const records: ModuleGraphRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`MODULE_GRAPH_MALFORMED:${trimmed.slice(0, 120)}`);
    }
    const row = parsed as Partial<ModuleGraphRecord>;
    if (typeof row.specifier !== "string" || typeof row.resolvedURL !== "string") {
      throw new Error("MODULE_GRAPH_FIELDS");
    }
    if (row.parentURL !== null && typeof row.parentURL !== "string") {
      throw new Error("MODULE_GRAPH_PARENT");
    }
    records.push({
      schemaVersion: MODULE_GRAPH_SCHEMA,
      specifier: row.specifier,
      parentURL: row.parentURL ?? null,
      resolvedURL: row.resolvedURL,
    });
  }
  return records;
}

export function assertCanaryModuleGraph(p: {
  records: ModuleGraphRecord[];
  canaryRoot: string;
  repoRoot: string;
  bootstrapFiles?: readonly string[];
}): string[] {
  const canaryRoot = fs.realpathSync(p.canaryRoot);
  const repoRoot = fs.realpathSync(p.repoRoot);
  const bootstrap = new Set(
    (p.bootstrapFiles ?? VERIFIER_BOOTSTRAP_RELATIVE).map((rel) => {
      const full = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
      try {
        return fs.realpathSync(full);
      } catch {
        return path.resolve(full);
      }
    }),
  );
  const hits: string[] = [];
  for (const row of p.records) {
    if (isBuiltin(row.resolvedURL) || row.resolvedURL.startsWith("node:")) continue;
    const parentPath = row.parentURL ? asFilePath(row.parentURL) : undefined;
    const resolvedPath = asFilePath(row.resolvedURL);
    if (!parentPath) continue;
    const parentIsBootstrap = [...bootstrap].some((b) => parentPath === b || isUnder(path.dirname(b), parentPath) && bootstrap.has(parentPath));
    const parentIsCanary = isUnder(canaryRoot, parentPath);
    if (!parentIsCanary || parentIsBootstrap) continue;
    if (!resolvedPath) {
      hits.push(`UNRESOLVED_URL:${row.specifier}`);
      continue;
    }
    if (isUnder(canaryRoot, resolvedPath)) continue;
    if (isUnder(path.join(canaryRoot, "node_modules"), resolvedPath)) continue;
    if (isUnder(repoRoot, resolvedPath) && !isUnder(canaryRoot, resolvedPath)) {
      hits.push(`ROOT_REPOSITORY_RESOLUTION:${row.specifier}->${resolvedPath}`);
      continue;
    }
    hits.push(`OUTSIDE_CANARY_RESOLUTION:${row.specifier}->${resolvedPath}`);
  }
  return hits;
}

export function bootstrapFileUrls(repoRoot: string): string[] {
  return VERIFIER_BOOTSTRAP_RELATIVE.map((rel) => pathToFileURL(path.join(repoRoot, rel)).href);
}
