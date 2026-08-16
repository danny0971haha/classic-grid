import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type Envelope<T> = {
  schema_version: "1";
  checksum_sha256: string;
  payload: T;
};

export type ChecksummedEnvelopeV2<T> = {
  schemaVersion: 2;
  kind: string;
  experimentId: string;
  scopeKey: string;
  storeGeneration: number;
  leaseGeneration: string | null;
  createdAt: string;
  writtenAt: string;
  payloadSha256: string;
  previousEnvelopeSha256: string | null;
  payload: T;
  envelopeSha256: string;
};

export type EnvelopeInspectionCondition =
  | "VALID"
  | "MISSING"
  | "CORRUPT"
  | "SCOPE_MISMATCH"
  | "KIND_MISMATCH"
  | "EXPERIMENT_MISMATCH"
  | "UNSUPPORTED_VERSION";

export type EnvelopeInspection<T> = {
  condition: EnvelopeInspectionCondition;
  envelope?: ChecksummedEnvelopeV2<T>;
  raw?: string;
  diagnosticCode?: string;
};

export type StorageFileSystem = Pick<
  typeof fs,
  | "closeSync"
  | "existsSync"
  | "fsyncSync"
  | "mkdirSync"
  | "openSync"
  | "readFileSync"
  | "renameSync"
  | "unlinkSync"
  | "writeFileSync"
>;

export type AtomicWriteStep =
  | "BEFORE_TEMP_OPEN"
  | "AFTER_TEMP_OPEN"
  | "AFTER_WRITE"
  | "AFTER_FILE_FSYNC"
  | "BEFORE_RENAME"
  | "AFTER_RENAME"
  | "BEFORE_DIRECTORY_FSYNC"
  | "AFTER_DIRECTORY_FSYNC";

export type StorageOptions = {
  fileSystem?: StorageFileSystem;
  onAtomicWriteStep?: (step: AtomicWriteStep, targetPath: string) => void;
};

const NODE_FILE_SYSTEM: StorageFileSystem = fs;

export function assertSafeExperimentId(value: string): string {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) {
    throw new Error("invalid experiment id");
  }
  return id;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical json rejects non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    return `{${keys.map((key) => {
      const child = row[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
        throw new Error("canonical json rejects unsupported value");
      }
      return `${JSON.stringify(key)}:${canonicalJson(child)}`;
    }).join(",")}}`;
  }
  throw new Error("canonical json rejects unsupported value");
}

export function sha256Json(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createChecksummedEnvelopeV2<T>(p: {
  kind: string;
  experimentId: string;
  scopeKey: string;
  storeGeneration: number;
  leaseGeneration: string | null;
  createdAt: string;
  writtenAt: string;
  previousEnvelopeSha256: string | null;
  payload: T;
}): ChecksummedEnvelopeV2<T> {
  if (!p.kind || !p.scopeKey || !Number.isSafeInteger(p.storeGeneration) || p.storeGeneration < 1) {
    throw new Error("invalid v2 envelope metadata");
  }
  assertSafeExperimentId(p.experimentId);
  const withoutHash: Omit<ChecksummedEnvelopeV2<T>, "envelopeSha256"> = {
    schemaVersion: 2,
    kind: p.kind,
    experimentId: p.experimentId,
    scopeKey: p.scopeKey,
    storeGeneration: p.storeGeneration,
    leaseGeneration: p.leaseGeneration,
    createdAt: p.createdAt,
    writtenAt: p.writtenAt,
    payloadSha256: sha256Canonical(p.payload),
    previousEnvelopeSha256: p.previousEnvelopeSha256,
    payload: p.payload,
  };
  return {
    ...withoutHash,
    envelopeSha256: sha256Canonical(withoutHash),
  };
}

export function serializeChecksummedEnvelopeV2<T>(envelope: ChecksummedEnvelopeV2<T>): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function atomicWriteFile(filePath: string, contents: string, options: StorageOptions = {}): void {
  const storage = options.fileSystem || NODE_FILE_SYSTEM;
  const notify = (step: AtomicWriteStep): void => options.onAtomicWriteStep?.(step, filePath);
  const dir = path.dirname(filePath);
  storage.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd: number | null = null;
  let directoryFd: number | null = null;
  try {
    notify("BEFORE_TEMP_OPEN");
    fd = storage.openSync(tmp, "wx", 0o600);
    notify("AFTER_TEMP_OPEN");
    storage.writeFileSync(fd, contents, "utf8");
    notify("AFTER_WRITE");
    storage.fsyncSync(fd);
    notify("AFTER_FILE_FSYNC");
    storage.closeSync(fd);
    fd = null;
    notify("BEFORE_RENAME");
    storage.renameSync(tmp, filePath);
    notify("AFTER_RENAME");
    notify("BEFORE_DIRECTORY_FSYNC");
    directoryFd = storage.openSync(dir, "r");
    storage.fsyncSync(directoryFd);
    notify("AFTER_DIRECTORY_FSYNC");
    storage.closeSync(directoryFd);
    directoryFd = null;
  } catch (error) {
    if (fd != null) {
      try { storage.closeSync(fd); } catch { /* cleanup only */ }
    }
    if (directoryFd != null) {
      try { storage.closeSync(directoryFd); } catch { /* cleanup only */ }
    }
    try { storage.unlinkSync(tmp); } catch { /* cleanup only */ }
    throw error;
  }
}

export function writeChecksummedJson<T>(filePath: string, payload: T, options: StorageOptions = {}): void {
  const storage = options.fileSystem || NODE_FILE_SYSTEM;
  if (storage.existsSync(filePath)) {
    atomicWriteFile(`${filePath}.bak`, storage.readFileSync(filePath, "utf8"), options);
  }
  const envelope: Envelope<T> = {
    schema_version: "1",
    checksum_sha256: sha256Json(payload),
    payload,
  };
  atomicWriteFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, options);
}

export function readChecksummedJson<T>(filePath: string, options: StorageOptions = {}): T {
  const storage = options.fileSystem || NODE_FILE_SYSTEM;
  const parsed = JSON.parse(storage.readFileSync(filePath, "utf8")) as Envelope<T>;
  if (parsed?.schema_version !== "1" || parsed?.payload == null) {
    throw new Error("unsupported or missing state envelope");
  }
  if (parsed.checksum_sha256 !== sha256Json(parsed.payload)) {
    throw new Error("state checksum mismatch");
  }
  return parsed.payload;
}

export function inspectChecksummedEnvelopeV2<T>(
  filePath: string,
  expected: {
    kind: string;
    experimentId: string;
    scopeKey?: string;
    validatePayload?: (payload: unknown) => payload is T;
  },
  options: StorageOptions = {}
): EnvelopeInspection<T> {
  const storage = options.fileSystem || NODE_FILE_SYSTEM;
  if (!storage.existsSync(filePath)) return { condition: "MISSING", diagnosticCode: "STATE_COPY_MISSING" };
  let raw: string;
  let parsed: any;
  try {
    raw = storage.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return { condition: "CORRUPT", diagnosticCode: "STATE_COPY_PARSE_FAILED" };
  }
  if (parsed?.schemaVersion !== 2) {
    return { condition: "UNSUPPORTED_VERSION", raw, diagnosticCode: "STATE_COPY_UNSUPPORTED_VERSION" };
  }
  if (parsed.kind !== expected.kind) {
    return { condition: "KIND_MISMATCH", raw, diagnosticCode: "STATE_COPY_KIND_MISMATCH" };
  }
  if (parsed.experimentId !== expected.experimentId) {
    return { condition: "EXPERIMENT_MISMATCH", raw, diagnosticCode: "STATE_COPY_EXPERIMENT_MISMATCH" };
  }
  if (expected.scopeKey != null && parsed.scopeKey !== expected.scopeKey) {
    return { condition: "SCOPE_MISMATCH", raw, diagnosticCode: "STATE_COPY_SCOPE_MISMATCH" };
  }
  const metadataValid =
    typeof parsed.scopeKey === "string" && parsed.scopeKey.length > 0 &&
    Number.isSafeInteger(parsed.storeGeneration) && parsed.storeGeneration > 0 &&
    (parsed.leaseGeneration === null || typeof parsed.leaseGeneration === "string") &&
    typeof parsed.createdAt === "string" && Number.isFinite(Date.parse(parsed.createdAt)) &&
    typeof parsed.writtenAt === "string" && Number.isFinite(Date.parse(parsed.writtenAt)) &&
    typeof parsed.payloadSha256 === "string" && /^[a-f0-9]{64}$/.test(parsed.payloadSha256) &&
    (parsed.previousEnvelopeSha256 === null || (typeof parsed.previousEnvelopeSha256 === "string" && /^[a-f0-9]{64}$/.test(parsed.previousEnvelopeSha256))) &&
    typeof parsed.envelopeSha256 === "string" && /^[a-f0-9]{64}$/.test(parsed.envelopeSha256) &&
    parsed.payload !== undefined;
  if (!metadataValid) return { condition: "CORRUPT", raw, diagnosticCode: "STATE_COPY_SCHEMA_INVALID" };
  if (Date.parse(parsed.writtenAt) < Date.parse(parsed.createdAt)) {
    return { condition: "CORRUPT", raw, diagnosticCode: "STATE_COPY_TIMESTAMP_ORDER_INVALID" };
  }
  try {
    if (parsed.payloadSha256 !== sha256Canonical(parsed.payload)) {
      return { condition: "CORRUPT", raw, diagnosticCode: "STATE_COPY_PAYLOAD_HASH_MISMATCH" };
    }
    const { envelopeSha256, ...withoutHash } = parsed;
    if (envelopeSha256 !== sha256Canonical(withoutHash)) {
      return { condition: "CORRUPT", raw, diagnosticCode: "STATE_COPY_ENVELOPE_HASH_MISMATCH" };
    }
  } catch {
    return { condition: "CORRUPT", raw, diagnosticCode: "STATE_COPY_CANONICALIZATION_FAILED" };
  }
  if (expected.validatePayload && !expected.validatePayload(parsed.payload)) {
    return { condition: "CORRUPT", raw, diagnosticCode: "STATE_COPY_PAYLOAD_SCHEMA_INVALID" };
  }
  return { condition: "VALID", envelope: parsed as ChecksummedEnvelopeV2<T>, raw };
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
