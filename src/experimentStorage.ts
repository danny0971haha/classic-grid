import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type Envelope<T> = {
  schema_version: "1";
  checksum_sha256: string;
  payload: T;
};

export function assertSafeExperimentId(value: string): string {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) {
    throw new Error("invalid experiment id");
  }
  return id;
}

export function sha256Json(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function atomicWriteFile(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
    try {
      const dfd = fs.openSync(dir, "r");
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
    } catch {
      // Some platforms do not permit fsync on directories.
    }
  } catch (error) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore cleanup failure */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw error;
  }
}

export function writeChecksummedJson<T>(filePath: string, payload: T): void {
  if (fs.existsSync(filePath)) {
    atomicWriteFile(`${filePath}.bak`, fs.readFileSync(filePath, "utf8"));
  }
  const envelope: Envelope<T> = {
    schema_version: "1",
    checksum_sha256: sha256Json(payload),
    payload,
  };
  atomicWriteFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
}

export function readChecksummedJson<T>(filePath: string): T {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Envelope<T>;
  if (parsed?.schema_version !== "1" || parsed?.payload == null) {
    throw new Error("unsupported or missing state envelope");
  }
  if (parsed.checksum_sha256 !== sha256Json(parsed.payload)) {
    throw new Error("state checksum mismatch");
  }
  return parsed.payload;
}

export type ExperimentLease = {
  scopeKey: string;
  generation: string;
  release(): void;
};

export function acquireExperimentLease(p: {
  experimentDir: string;
  scopeKey: string;
}): ExperimentLease {
  fs.mkdirSync(p.experimentDir, { recursive: true });
  const lockPath = path.join(p.experimentDir, "runtime.lock");
  const generation = `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (error: any) {
    const owner = (() => {
      try { return fs.readFileSync(lockPath, "utf8").slice(0, 300); }
      catch { return "unreadable owner"; }
    })();
    throw new Error(`experiment already locked (${owner}): ${String(error?.code || error)}`);
  }
  fs.writeFileSync(
    fd,
    `${JSON.stringify({ pid: process.pid, scope_key: p.scopeKey, generation, acquired_at: new Date().toISOString() })}\n`,
    "utf8"
  );
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  let released = false;
  return {
    scopeKey: p.scopeKey,
    generation,
    release() {
      if (released) return;
      released = true;
      try {
        const row = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (row?.generation === generation) fs.unlinkSync(lockPath);
      } catch {
        // Never remove a lock whose generation cannot be verified.
      }
    },
  };
}
