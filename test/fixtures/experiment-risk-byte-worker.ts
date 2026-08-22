import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

const experimentId = required("CLASSIC_RISK_ID");
const baseDir = required("CLASSIC_RISK_DIR");
const primary = path.join(baseDir, experimentId, "risk-state.json");
const backup = `${primary}.bak`;
const primaryRaw = fs.readFileSync(primary, "utf8");
const backupRaw = fs.readFileSync(backup, "utf8");
const envelope = JSON.parse(primaryRaw) as {
  storeGeneration: number;
  envelopeSha256: string;
  payload: { haltStatus: string; haltId: string | null; leaseGeneration: string | null };
};

process.stdout.write(`${JSON.stringify({
  primarySha256: crypto.createHash("sha256").update(primaryRaw, "utf8").digest("hex"),
  backupSha256: crypto.createHash("sha256").update(backupRaw, "utf8").digest("hex"),
  storeGeneration: envelope.storeGeneration,
  envelopeSha256: envelope.envelopeSha256,
  haltStatus: envelope.payload.haltStatus,
  haltId: envelope.payload.haltId,
  leaseGeneration: envelope.payload.leaseGeneration,
})}\n`);
