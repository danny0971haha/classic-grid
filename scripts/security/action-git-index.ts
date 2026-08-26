import { spawnSync } from "node:child_process";

export const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
export const SYMLINK_MODE = "120000";
export const GITLINK_MODE = "160000";

export type GitIndexEntry = {
  path: string;
  mode: string;
  object: string;
  stage: string;
};

export type GitIndexResult =
  | { ok: true; entries: GitIndexEntry[]; byPath: Map<string, GitIndexEntry> }
  | { ok: false; code: "ACTION_GIT_INDEX_UNREADABLE"; detail: string };

const WORKFLOW_PATH = /^\.github\/workflows\/.+\.(yml|yaml)$/;
const ACTION_MANIFEST_PATH = /^\.github\/actions\/(?:.*\/)?action\.(yml|yaml)$/;

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}

export function isWorkflowManifestPath(posixPath: string): boolean {
  return WORKFLOW_PATH.test(posixPath);
}

export function isActionManifestPath(posixPath: string): boolean {
  return ACTION_MANIFEST_PATH.test(posixPath);
}

export function isTrackedManifestPath(posixPath: string): boolean {
  return isWorkflowManifestPath(posixPath) || isActionManifestPath(posixPath);
}

export function normalizeIndexPath(posixPath: string): string {
  return posixPath.normalize("NFC");
}

export function pathCaseFold(posixPath: string): string {
  return normalizeIndexPath(posixPath).toLowerCase();
}

export function isEscapingPath(posixPath: string): boolean {
  if (posixPath.length === 0) return true;
  if (posixPath.includes("\0") || posixPath.includes("\\")) return true;
  if (posixPath.startsWith("/") || posixPath.startsWith("~")) return true;
  const parts = posixPath.split("/");
  return parts.some((part) => part === "" || part === "." || part === "..");
}

function splitNul(buf: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) {
      if (i > start) parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts;
}

export function git(root: string, args: string[], input?: Buffer | string): {
  ok: true;
  stdout: Buffer;
  stderr: string;
} | {
  ok: false;
  stdout: Buffer;
  stderr: string;
  status: number | null;
} {
  const spawned = spawnSync("git", args, {
    cwd: root,
    encoding: "buffer",
    input: input === undefined ? undefined : Buffer.from(input),
    maxBuffer: 32 * 1024 * 1024,
    env: gitEnv(),
  });
  const stdout = spawned.stdout ?? Buffer.alloc(0);
  const stderr = (spawned.stderr ?? Buffer.alloc(0)).toString("utf8");
  if (spawned.error || spawned.status !== 0) {
    return { ok: false, stdout, stderr, status: spawned.status };
  }
  return { ok: true, stdout, stderr };
}

export function listGitIndex(root: string): GitIndexResult {
  const listed = git(root, ["ls-files", "-z", "--stage"]);
  if (!listed.ok) {
    return {
      ok: false,
      code: "ACTION_GIT_INDEX_UNREADABLE",
      detail: listed.stderr.trim() || `git ls-files exited ${listed.status}`,
    };
  }
  const entries: GitIndexEntry[] = [];
  const byPath = new Map<string, GitIndexEntry>();
  for (const rec of splitNul(listed.stdout)) {
    const text = rec.toString("utf8");
    const match = text.match(/^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t(.*)$/);
    if (!match) {
      return {
        ok: false,
        code: "ACTION_GIT_INDEX_UNREADABLE",
        detail: "malformed git ls-files --stage record",
      };
    }
    const entry: GitIndexEntry = {
      mode: match[1]!,
      object: match[2]!,
      stage: match[3]!,
      path: match[4]!,
    };
    if (entry.path.includes("\0") || byPath.has(entry.path)) {
      return {
        ok: false,
        code: "ACTION_GIT_INDEX_UNREADABLE",
        detail: "duplicate or NUL git path",
      };
    }
    entries.push(entry);
    byPath.set(entry.path, entry);
  }
  return { ok: true, entries, byPath };
}

export function gitCatBlob(root: string, object: string): { ok: true; text: string } | { ok: false } {
  if (!/^[0-9a-f]{40}$/.test(object)) return { ok: false };
  const result = git(root, ["cat-file", "blob", object]);
  if (!result.ok) return { ok: false };
  return { ok: true, text: result.stdout.toString("utf8") };
}

export function caseCollidingPaths(paths: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const posixPath of paths) {
    const key = pathCaseFold(posixPath);
    const group = groups.get(key);
    if (group) group.push(posixPath);
    else groups.set(key, [posixPath]);
  }
  return [...groups.values()].filter((group) => new Set(group).size > 1);
}
