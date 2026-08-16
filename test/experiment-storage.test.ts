import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  acquireExperimentLease,
  atomicWriteFile,
  canonicalJson,
  createChecksummedEnvelopeV2,
  inspectChecksummedEnvelopeV2,
  readChecksummedJson,
  serializeChecksummedEnvelopeV2,
  writeChecksummedJson,
  type AtomicWriteStep,
} from "../src/experimentStorage.js";

describe("experiment storage and singleton fencing", () => {
  it("round-trips a checksummed atomic file and rejects tampering", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-storage-"));
    const file = path.join(dir, "state.json");
    writeChecksummedJson(file, { value: 7 });
    assert.deepEqual(readChecksummedJson(file), { value: 7 });
    const row = JSON.parse(fs.readFileSync(file, "utf8"));
    row.payload.value = 8;
    fs.writeFileSync(file, JSON.stringify(row), "utf8");
    assert.throws(() => readChecksummedJson(file), /checksum/);
  });

  it("rejects a second process owner and uses generation-checked release", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-lease-"));
    const first = acquireExperimentLease({ experimentDir: dir, scopeKey: "extended:BTC" });
    assert.throws(
      () => acquireExperimentLease({ experimentDir: dir, scopeKey: "extended:BTC" }),
      /already locked/
    );
    first.release();
    const second = acquireExperimentLease({ experimentDir: dir, scopeKey: "extended:BTC" });
    assert.notEqual(first.generation, second.generation);
    second.release();
  });

  it("canonicalizes V2 payloads independently of object insertion order", () => {
    assert.equal(
      canonicalJson({ z: 1, nested: { b: 2, a: [3, true] } }),
      canonicalJson({ nested: { a: [3, true], b: 2 }, z: 1 })
    );
    assert.throws(() => canonicalJson({ bad: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalJson({ bad: undefined }), /unsupported/);
  });

  it("strictly inspects V2 schema, identity, scope, kind, and hashes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-v2-inspect-"));
    const file = path.join(dir, "risk-state.json");
    const envelope = createChecksummedEnvelopeV2({
      kind: "experiment-risk-state",
      experimentId: "exp-1",
      scopeKey: "extended:BTC",
      storeGeneration: 1,
      leaseGeneration: "lease-1",
      createdAt: "2026-08-16T00:00:00.000Z",
      writtenAt: "2026-08-16T00:00:00.000Z",
      previousEnvelopeSha256: null,
      payload: { halted: true },
    });
    atomicWriteFile(file, serializeChecksummedEnvelopeV2(envelope));
    const expected = { kind: "experiment-risk-state", experimentId: "exp-1", scopeKey: "extended:BTC" };
    assert.equal(inspectChecksummedEnvelopeV2(file, expected).condition, "VALID");
    assert.equal(inspectChecksummedEnvelopeV2(file, { ...expected, scopeKey: "other" }).condition, "SCOPE_MISMATCH");
    assert.equal(inspectChecksummedEnvelopeV2(file, { ...expected, kind: "other" }).condition, "KIND_MISMATCH");
    assert.equal(inspectChecksummedEnvelopeV2(file, { ...expected, experimentId: "exp-2" }).condition, "EXPERIMENT_MISMATCH");

    const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
    tampered.payload.halted = false;
    fs.writeFileSync(file, JSON.stringify(tampered), "utf8");
    assert.equal(inspectChecksummedEnvelopeV2(file, expected).condition, "CORRUPT");
    tampered.schemaVersion = 999;
    fs.writeFileSync(file, JSON.stringify(tampered), "utf8");
    assert.equal(inspectChecksummedEnvelopeV2(file, expected).condition, "UNSUPPORTED_VERSION");
  });

  it("uses mode 0600 and propagates every injected atomic-write failure", () => {
    const steps: AtomicWriteStep[] = [
      "BEFORE_TEMP_OPEN",
      "AFTER_TEMP_OPEN",
      "AFTER_WRITE",
      "AFTER_FILE_FSYNC",
      "BEFORE_RENAME",
      "AFTER_RENAME",
      "BEFORE_DIRECTORY_FSYNC",
      "AFTER_DIRECTORY_FSYNC",
    ];
    for (const step of steps) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-atomic-fault-"));
      const file = path.join(dir, "state.json");
      assert.throws(() => atomicWriteFile(file, "safe", {
        onAtomicWriteStep(actual) {
          if (actual === step) throw new Error(`fault:${step}`);
        },
      }), new RegExp(`fault:${step}`));
      if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, "utf8"), "safe");
      assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-atomic-mode-"));
    const file = path.join(dir, "state.json");
    atomicWriteFile(file, "safe");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("cleans up a deterministically injected partial write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-atomic-partial-"));
    const file = path.join(dir, "state.json");
    const partialFs = {
      closeSync: fs.closeSync,
      existsSync: fs.existsSync,
      fsyncSync: fs.fsyncSync,
      mkdirSync: fs.mkdirSync,
      openSync: fs.openSync,
      readFileSync: fs.readFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync(fd: number, contents: string) {
        fs.writeFileSync(fd, contents.slice(0, 3), "utf8");
        throw new Error("partial write injected");
      },
    } as any;
    assert.throws(() => atomicWriteFile(file, "complete", { fileSystem: partialFs }), /partial write injected/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
  });
});
