import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { acquireExperimentLease, readChecksummedJson, writeChecksummedJson } from "../src/experimentStorage.js";

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
});
