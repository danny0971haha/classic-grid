import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActiveLeaseAuthority, ExperimentRiskState, HaltStatus } from "../../src/experimentRisk.js";
import { emptyRiskState } from "../../src/experimentRisk.js";

export const SCOPE = "extended:BTC";

export function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `classic-g0c1-${label}-`));
}

export function liveLease(generation = "lease-1", scopeKey = SCOPE): ActiveLeaseAuthority {
  return {
    generation,
    scopeKey,
    assertCurrent() { /* held for the duration of the in-process test */ },
  };
}

export function halted(partial: Partial<ExperimentRiskState> = {}): ExperimentRiskState {
  return {
    ...emptyRiskState(partial.scopeKey ?? SCOPE),
    halted: true,
    haltStatus: (partial.haltStatus as HaltStatus) || "HALTED_FLAT",
    haltId: Object.prototype.hasOwnProperty.call(partial, "haltId") ? (partial.haltId as string | null) : "halt-H1",
    haltReasons: partial.haltReasons ?? ["DAILY_LOSS"],
    leaseGeneration: Object.prototype.hasOwnProperty.call(partial, "leaseGeneration")
      ? (partial.leaseGeneration as string | null)
      : "lease-1",
    acknowledged: false,
    updatedAt: partial.updatedAt ?? "2026-08-22T00:00:00.000Z",
    startingEquityUsd: partial.startingEquityUsd ?? 50,
    highWaterMarkUsd: partial.highWaterMarkUsd ?? 50,
  };
}

export function diskDisposition(experimentDir: string): {
  primaryExists: boolean;
  backupExists: boolean;
  sessionExists: boolean;
  sessionBackupExists: boolean;
  primaryParse: "VALID" | "MISSING" | "CORRUPT";
  backupParse: "VALID" | "MISSING" | "CORRUPT";
  sessionParse: "VALID" | "MISSING" | "CORRUPT";
  primaryHaltStatus: string | null;
  primaryHaltId: string | null;
  primaryLease: string | null;
  primaryAckHaltId: string | null;
  sessionStatus: string | null;
} {
  const primary = path.join(experimentDir, "risk-state.json");
  const backup = `${primary}.bak`;
  const session = path.join(experimentDir, "runtime-session.json");
  const read = (file: string): { parse: "VALID" | "MISSING" | "CORRUPT"; row: any } => {
    if (!fs.existsSync(file)) return { parse: "MISSING", row: null };
    try {
      return { parse: "VALID", row: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      return { parse: "CORRUPT", row: null };
    }
  };
  const p = read(primary);
  const b = read(backup);
  const s = read(session);
  return {
    primaryExists: fs.existsSync(primary),
    backupExists: fs.existsSync(backup),
    sessionExists: fs.existsSync(session),
    sessionBackupExists: fs.existsSync(`${session}.bak`),
    primaryParse: p.parse,
    backupParse: b.parse,
    sessionParse: s.parse,
    primaryHaltStatus: p.row?.payload?.haltStatus ?? null,
    primaryHaltId: p.row?.payload?.haltId ?? null,
    primaryLease: p.row?.payload?.leaseGeneration ?? null,
    primaryAckHaltId: p.row?.payload?.lastAcknowledgement?.haltId ?? null,
    sessionStatus: s.row?.payload?.status ?? null,
  };
}
