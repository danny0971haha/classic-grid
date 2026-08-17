import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteFile,
  createChecksummedEnvelopeV2,
  inspectChecksummedEnvelopeV2,
  serializeChecksummedEnvelopeV2,
  type ChecksummedEnvelopeV2,
} from "./experimentStorage.js";

export interface RuntimeLeaseRecordV2 {
  schemaVersion: 2;
  experimentId: string;
  scopeKey: string;
  leaseId: string;
  generation: number;
  pid: number;
  hostname: string;
  processBootId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  socketPath: string;
}

export interface RuntimeLease {
  readonly leaseId: string;
  readonly generation: number;
  readonly scopeKey: string;
  readonly metadataPath: string;
  readonly socketPath: string;
  assertCurrent(): void;
  heartbeat(): Promise<void>;
  isCurrent(): boolean;
  release(): Promise<void>;
}

export type RuntimeLeaseOptions = {
  experimentDir: string;
  experimentId: string;
  scopeKey: string;
  heartbeatIntervalMs?: number;
  expiryMs?: number;
  now?: () => Date;
  pid?: number;
  hostname?: string;
  processBootId?: string;
};

export type RuntimeLeaseHeartbeat = {
  stop(): void;
  readonly stopped: boolean;
};

const PROCESS_BOOT_ID = crypto.randomUUID();
const LEASE_KIND = "runtime-lease-generation";
const METADATA_FILE = "runtime.lease.json";
const SOCKET_FILE = "runtime.lease.sock";
const GENERATION_FILE = "runtime-lease-generation.json";

function nowIso(options: RuntimeLeaseOptions): string {
  return (options.now?.() || new Date()).toISOString();
}

function readRecord(metadataPath: string): RuntimeLeaseRecordV2 | null {
  try {
    const row = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as RuntimeLeaseRecordV2;
    if (
      row?.schemaVersion !== 2 ||
      typeof row.experimentId !== "string" ||
      typeof row.scopeKey !== "string" ||
      typeof row.leaseId !== "string" ||
      !Number.isSafeInteger(row.generation) || row.generation < 1 ||
      !Number.isSafeInteger(row.pid) || row.pid < 1 ||
      typeof row.hostname !== "string" ||
      typeof row.processBootId !== "string" ||
      !Number.isFinite(Date.parse(row.acquiredAt)) ||
      !Number.isFinite(Date.parse(row.heartbeatAt)) ||
      !Number.isFinite(Date.parse(row.expiresAt)) ||
      Date.parse(row.expiresAt) < Date.parse(row.heartbeatAt) ||
      typeof row.socketPath !== "string"
    ) return null;
    return row;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function probeSocket(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(active);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function leaseSocketPath(options: RuntimeLeaseOptions): string {
  const local = path.join(options.experimentDir, SOCKET_FILE);
  if (Buffer.byteLength(local) <= 103) return local;
  // Darwin's sockaddr_un path is limited to 104 bytes. The hash keeps the
  // fallback deterministic without exposing account/scope text in /tmp.
  const identity = crypto
    .createHash("sha256")
    .update(`${path.resolve(options.experimentDir)}\0${options.experimentId}\0${options.scopeKey}`)
    .digest("hex")
    .slice(0, 32);
  return path.join(os.tmpdir(), `classic-grid-${identity}.sock`);
}

async function quarantineStaleSocket(
  socketPath: string,
  metadataPath: string,
  options: RuntimeLeaseOptions
): Promise<void> {
  if (await probeSocket(socketPath)) throw new Error("RUNTIME_LEASE_ACTIVE_SOCKET");
  const record = readRecord(metadataPath);
  if (record) {
    if (record.experimentId !== options.experimentId || record.scopeKey !== options.scopeKey) {
      throw new Error("RUNTIME_LEASE_SCOPE_MISMATCH");
    }
    if (record.socketPath !== socketPath) throw new Error("RUNTIME_LEASE_SOCKET_IDENTITY_MISMATCH");
    const sameHost = record.hostname === (options.hostname || os.hostname());
    if (!sameHost) throw new Error("RUNTIME_LEASE_CROSS_HOST_UNSUPPORTED");
    if ((options.now?.() || new Date()).getTime() <= Date.parse(record.expiresAt)) {
      throw new Error("RUNTIME_LEASE_HEARTBEAT_FRESH");
    }
    if (sameHost && isPidAlive(record.pid)) throw new Error("RUNTIME_LEASE_OWNER_PROCESS_ALIVE");
  }
  const quarantine = `${socketPath}.stale.${crypto.randomUUID()}`;
  try {
    fs.renameSync(socketPath, quarantine);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try { fs.unlinkSync(quarantine); } catch { /* isolated stale inode is harmless */ }
}

async function listenOnLeaseSocket(
  socketPath: string,
  metadataPath: string,
  options: RuntimeLeaseOptions
): Promise<net.Server> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const server = net.createServer((socket) => socket.end());
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
      });
      return server;
    } catch (error: any) {
      try { server.close(); } catch { /* not listening */ }
      if (error?.code !== "EADDRINUSE") throw error;
      await quarantineStaleSocket(socketPath, metadataPath, options);
    }
  }
  throw new Error("RUNTIME_LEASE_ACQUIRE_RACE");
}

type GenerationPayload = { generation: number };

function validGenerationPayload(value: unknown): value is GenerationPayload {
  const row = value as GenerationPayload | null;
  return Boolean(row && Number.isSafeInteger(row.generation) && row.generation >= 1);
}

function inspectGenerationCopy(filePath: string, options: RuntimeLeaseOptions) {
  const inspected = inspectChecksummedEnvelopeV2<GenerationPayload>(filePath, {
    kind: LEASE_KIND,
    experimentId: options.experimentId,
    scopeKey: options.scopeKey,
    validatePayload: validGenerationPayload,
  });
  if (
    inspected.condition === "VALID" &&
    inspected.envelope &&
    inspected.envelope.payload.generation !== inspected.envelope.storeGeneration
  ) {
    return { condition: "CORRUPT" as const, raw: inspected.raw, diagnosticCode: "RUNTIME_LEASE_GENERATION_IDENTITY_MISMATCH" };
  }
  return inspected;
}

function validateGenerationPair(
  primary: ChecksummedEnvelopeV2<GenerationPayload>,
  backup: ChecksummedEnvelopeV2<GenerationPayload>
): void {
  if (backup.storeGeneration > primary.storeGeneration) throw new Error("RUNTIME_LEASE_GENERATION_BACKUP_NEWER");
  if (backup.storeGeneration === primary.storeGeneration) {
    if (backup.envelopeSha256 !== primary.envelopeSha256) throw new Error("RUNTIME_LEASE_GENERATION_HASH_CONFLICT");
    return;
  }
  if (
    backup.storeGeneration !== primary.storeGeneration - 1 ||
    primary.previousEnvelopeSha256 !== backup.envelopeSha256
  ) throw new Error("RUNTIME_LEASE_GENERATION_CHAIN_INVALID");
}

function allocateGeneration(options: RuntimeLeaseOptions): number {
  const primaryPath = path.join(options.experimentDir, GENERATION_FILE);
  const backupPath = `${primaryPath}.bak`;
  const primary = inspectGenerationCopy(primaryPath, options);
  const backup = inspectGenerationCopy(backupPath, options);
  let predecessor: ChecksummedEnvelopeV2<GenerationPayload> | null = null;
  if (primary.condition === "VALID" && primary.envelope && primary.raw) {
    if (backup.condition === "VALID" && backup.envelope) validateGenerationPair(primary.envelope, backup.envelope);
    else if (backup.condition !== "MISSING" && backup.condition !== "CORRUPT") throw new Error("RUNTIME_LEASE_GENERATION_BACKUP_UNPROVEN");
    atomicWriteFile(backupPath, primary.raw);
    predecessor = primary.envelope;
  } else if (backup.condition === "VALID" && backup.envelope) {
    predecessor = backup.envelope;
  } else if (primary.condition !== "MISSING" || backup.condition !== "MISSING") {
    throw new Error("RUNTIME_LEASE_GENERATION_UNPROVEN");
  }

  const generation = (predecessor?.payload.generation || 0) + 1;
  const writtenAt = nowIso(options);
  const next = createChecksummedEnvelopeV2({
    kind: LEASE_KIND,
    experimentId: options.experimentId,
    scopeKey: options.scopeKey,
    storeGeneration: (predecessor?.storeGeneration || 0) + 1,
    leaseGeneration: null,
    createdAt: predecessor?.createdAt || writtenAt,
    writtenAt,
    previousEnvelopeSha256: predecessor?.envelopeSha256 || null,
    payload: { generation },
  });
  atomicWriteFile(primaryPath, serializeChecksummedEnvelopeV2(next));
  const verified = inspectGenerationCopy(primaryPath, options);
  if (verified.condition !== "VALID" || verified.envelope?.payload.generation !== generation || !verified.raw) {
    throw new Error("RUNTIME_LEASE_GENERATION_VERIFY_FAILED");
  }
  if (!predecessor) atomicWriteFile(backupPath, verified.raw);
  return generation;
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function acquireRuntimeLease(options: RuntimeLeaseOptions): Promise<RuntimeLease> {
  fs.mkdirSync(options.experimentDir, { recursive: true });
  const metadataPath = path.join(options.experimentDir, METADATA_FILE);
  const socketPath = leaseSocketPath(options);
  if (!fs.existsSync(socketPath) && fs.existsSync(metadataPath)) {
    const existing = readRecord(metadataPath);
    if (!existing) throw new Error("RUNTIME_LEASE_METADATA_UNPROVEN");
    if (existing.experimentId !== options.experimentId || existing.scopeKey !== options.scopeKey) {
      throw new Error("RUNTIME_LEASE_SCOPE_MISMATCH");
    }
    if (existing.socketPath !== socketPath) throw new Error("RUNTIME_LEASE_SOCKET_IDENTITY_MISMATCH");
    if (existing.hostname !== (options.hostname || os.hostname())) {
      throw new Error("RUNTIME_LEASE_CROSS_HOST_UNSUPPORTED");
    }
    if ((options.now?.() || new Date()).getTime() <= Date.parse(existing.expiresAt)) {
      throw new Error("RUNTIME_LEASE_HEARTBEAT_FRESH");
    }
    if (isPidAlive(existing.pid)) throw new Error("RUNTIME_LEASE_OWNER_PROCESS_ALIVE");
  }
  const server = await listenOnLeaseSocket(socketPath, metadataPath, options);
  let socketInode: bigint | number | null = null;
  let released = false;
  let lost = false;
  try {
    fs.chmodSync(socketPath, 0o600);
    socketInode = fs.statSync(socketPath, { bigint: true }).ino;
    const generation = allocateGeneration(options);
    const acquiredAt = nowIso(options);
    const expiresAt = new Date(Date.parse(acquiredAt) + (options.expiryMs ?? 5_000)).toISOString();
    const record: RuntimeLeaseRecordV2 = {
      schemaVersion: 2,
      experimentId: options.experimentId,
      scopeKey: options.scopeKey,
      leaseId: crypto.randomUUID(),
      generation,
      pid: options.pid || process.pid,
      hostname: options.hostname || os.hostname(),
      processBootId: options.processBootId || PROCESS_BOOT_ID,
      acquiredAt,
      heartbeatAt: acquiredAt,
      expiresAt,
      socketPath,
    };
    atomicWriteFile(metadataPath, `${JSON.stringify(record, null, 2)}\n`);

    const assertCurrent = (): void => {
      if (released || lost || !server.listening) throw new Error("RUNTIME_LEASE_LOST");
      const current = readRecord(metadataPath);
      if (
        !current ||
        current.leaseId !== record.leaseId ||
        current.generation !== record.generation ||
        current.scopeKey !== record.scopeKey ||
        current.processBootId !== record.processBootId
      ) {
        lost = true;
        throw new Error("RUNTIME_LEASE_GENERATION_MISMATCH");
      }
      try {
        if (fs.statSync(socketPath, { bigint: true }).ino !== socketInode) throw new Error("socket inode mismatch");
      } catch {
        lost = true;
        throw new Error("RUNTIME_LEASE_SOCKET_LOST");
      }
    };

    const lease: RuntimeLease = {
      leaseId: record.leaseId,
      generation: record.generation,
      scopeKey: record.scopeKey,
      metadataPath,
      socketPath,
      assertCurrent,
      async heartbeat() {
        assertCurrent();
        record.heartbeatAt = nowIso(options);
        record.expiresAt = new Date(Date.parse(record.heartbeatAt) + (options.expiryMs ?? 5_000)).toISOString();
        atomicWriteFile(metadataPath, `${JSON.stringify(record, null, 2)}\n`);
        assertCurrent();
      },
      isCurrent() {
        try { assertCurrent(); return true; }
        catch { return false; }
      },
      async release() {
        if (released) return;
        const current = readRecord(metadataPath);
        const owned = Boolean(current && current.leaseId === record.leaseId && current.generation === record.generation);
        released = true;
        await closeServer(server);
        try {
          if (fs.statSync(socketPath, { bigint: true }).ino === socketInode) fs.unlinkSync(socketPath);
        } catch { /* never unlink an inode we cannot prove is ours */ }
        if (owned) {
          const afterClose = readRecord(metadataPath);
          if (afterClose?.leaseId === record.leaseId && afterClose.generation === record.generation) {
            try { fs.unlinkSync(metadataPath); } catch { /* cleanup is best effort */ }
          }
        }
      },
    };
    server.on("error", () => { lost = true; });
    return lease;
  } catch (error) {
    await closeServer(server);
    try {
      if (socketInode != null && fs.statSync(socketPath, { bigint: true }).ino === socketInode) fs.unlinkSync(socketPath);
    } catch { /* cleanup only */ }
    throw error;
  }
}

export function startRuntimeLeaseHeartbeat(p: {
  lease: RuntimeLease;
  intervalMs?: number;
  signal?: AbortSignal;
  onLost?: (error: unknown) => void;
}): RuntimeLeaseHeartbeat {
  let stopped = false;
  let running = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    p.signal?.removeEventListener("abort", stop);
  };
  const beat = async () => {
    if (stopped || running) return;
    running = true;
    try { await p.lease.heartbeat(); }
    catch (error) { stop(); p.onLost?.(error); }
    finally { running = false; }
  };
  const timer = setInterval(() => void beat(), Math.max(10, p.intervalMs ?? 1_000));
  timer.unref();
  p.signal?.addEventListener("abort", stop, { once: true });
  return {
    stop,
    get stopped() { return stopped; },
  };
}

export async function withLeaseFence<T>(lease: RuntimeLease, operation: () => Promise<T>): Promise<T> {
  lease.assertCurrent();
  return operation();
}
