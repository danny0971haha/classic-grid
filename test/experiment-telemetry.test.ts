import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createExperimentTelemetry,
  type ExperimentManifest,
} from "../src/experimentTelemetry.js";

describe("experiment telemetry", () => {
  it("writes a valid manifest and JSONL event without secrets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-exp-"));
    const tel = createExperimentTelemetry({
      experimentId: "classic-dryrun-001",
      bot: "classic-grid",
      mode: "dry-run",
      venue: "extended",
      symbol: "BTC",
      commitSha: "abc123deadbeef",
      baseDir: dir,
      manifestFields: {
        experiment_spec_version: "0.1.0",
        starting_capital_usd: 50,
        leverage: 10,
        max_margin_budget_usd: 15,
        max_planned_gross_notional_usd: 150,
        grid_half_band_pct: 3.0,
        grid_level_count: 12,
        daily_loss_limit_usd: 2.5,
        max_drawdown_usd: 5.0,
        boundary_buffer_pct: 1.0,
      },
    });

    const manifestPath = tel.manifestPath;
    const eventsPath = tel.eventsPath;
    assert.equal(fs.existsSync(manifestPath), true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExperimentManifest;
    assert.equal(manifest.experiment_spec_version, "0.1.0");
    assert.equal(manifest.experiment_id, "classic-dryrun-001");
    assert.equal(manifest.bot, "classic-grid");
    assert.equal(manifest.commit_sha, "abc123deadbeef");
    assert.equal(manifest.mode, "dry-run");
    assert.equal(manifest.starting_capital_usd, 50);
    assert.equal(manifest.leverage, 10);
    assert.equal(manifest.max_margin_budget_usd, 15);
    assert.equal(manifest.max_planned_gross_notional_usd, 150);
    assert.equal(manifest.grid_level_count, 12);
    assert.equal(manifest.grid_half_band_pct, 3.0);

    tel.emit("SNAPSHOT", { mid: 100_000, leverage: 10, planned_gross_notional_usd: 150 });
    tel.emit("RISK_HALT", {
      error_message: "daily loss",
      risk_flags: ["DAILY_LOSS"],
    });
    const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const snap = JSON.parse(lines[0]!);
    const halt = JSON.parse(lines[1]!);
    assert.equal(snap.schema_version, "2.0");
    assert.equal(snap.run_id, manifest.run_id);
    assert.equal(typeof snap.event_id, "string");
    assert.equal(snap.event, "SNAPSHOT");
    assert.equal(snap.experiment_id, "classic-dryrun-001");
    assert.equal(snap.commit_sha, "abc123deadbeef");
    assert.equal(snap.leverage, 10);
    assert.equal(halt.event, "RISK_HALT");
    assert.deepEqual(halt.risk_flags, ["DAILY_LOSS"]);
    const dumped = JSON.stringify(manifest) + fs.readFileSync(eventsPath, "utf8");
    assert.equal(/api[_-]?key|secret|private[_-]?key|token/i.test(dumped), false);
  });

  it("never throws or leaks a canary when event append fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classic-exp-fail-"));
    const tel = createExperimentTelemetry({
      experimentId: "classic-dryrun-fail",
      mode: "dry-run",
      venue: "extended",
      symbol: "BTC",
      commitSha: "abc",
      baseDir: dir,
      manifestFields: {
        experiment_spec_version: "0.1.0", starting_capital_usd: 50, leverage: 10,
        max_margin_budget_usd: 15, max_planned_gross_notional_usd: 150,
        grid_half_band_pct: 3, grid_level_count: 12, daily_loss_limit_usd: 2.5,
        max_drawdown_usd: 5, boundary_buffer_pct: 1,
      },
    });
    fs.unlinkSync(tel.eventsPath);
    fs.mkdirSync(tel.eventsPath);
    assert.doesNotThrow(() => tel.emit("ERROR", { error_message: "CANARY_SUPER_SECRET_123" }));
    assert.equal(tel.droppedEvents(), 1);
  });
});
