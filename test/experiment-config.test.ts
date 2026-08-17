import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anchorGrid,
  assertLiveAllowed,
  loadRuntimeConfig,
} from "../src/config.js";
import { assertFeeOk, assertMarginOk, buildGrid, computeRisk } from "../src/grid.js";
import { withEnv } from "./helpers/env.js";

const ALL_VENUES = [
  "extended",
  "risex",
  "decibel",
  "n1",
  "phoenix",
  "phoenix2",
  "nado",
  "popdex",
] as const;

const VENUE_LEVERAGE_ENV: Record<string, string> = {
  GRID_LEVERAGE: "30",
  EXTENDED_LEVERAGE: "30",
  RISEX_LEVERAGE: "25",
  RISE_LEVERAGE: "25",
  PHOENIX_LEVERAGE: "40",
  PHOENIX2_LEVERAGE: "40",
  DECIBEL_LEVERAGE: "30",
  N1_LEVERAGE: "30",
  NADO_LEVERAGE: "30",
  POPDEX_LEVERAGE: "20",
};

function loadExperimentConfig() {
  return withEnv(
    {
      EXPERIMENT_MODE: "1",
      EXPERIMENT_ID: "classic-dryrun-001",
      ...VENUE_LEVERAGE_ENV,
      GRID_MARGIN_FRAC: "0.7",
      POPDEX_EQUITY_USD: "800",
      POPDEX_GRID_COUNT: "80",
      DECIBEL_EQUITY_USD: "800",
      N1_EQUITY_USD: "800",
    },
    () => loadRuntimeConfig()
  );
}

describe("experiment config precedence", () => {
  it("resolves leverage=10 for every venue despite venue-specific env defaults", () => {
    const cfg = loadExperimentConfig();
    assert.equal(cfg.experiment.enabled, true);
    assert.equal(cfg.experiment.leverage, 10);
    for (const venue of ALL_VENUES) {
      assert.equal(cfg.grids[venue].leverage, 10, `${venue} leverage`);
    }
  });

  it("resolves equity=50 and marginFraction=0.30 for every venue", () => {
    const cfg = loadExperimentConfig();
    assert.equal(cfg.experiment.capitalUsd, 50);
    assert.equal(cfg.experiment.marginFraction, 0.3);
    for (const venue of ALL_VENUES) {
      assert.equal(cfg.grids[venue].equityUsd, 50, `${venue} equity`);
      assert.equal(cfg.grids[venue].marginFraction, 0.3, `${venue} margin`);
    }
  });

  it("resolves gridCount=12 and overrides 80/46/venue defaults", () => {
    const cfg = loadExperimentConfig();
    assert.equal(cfg.experiment.gridCount, 12);
    for (const venue of ALL_VENUES) {
      assert.equal(cfg.grids[venue].gridCount, 12, `${venue} gridCount`);
      assert.ok(cfg.grids[venue].maxWritesPerTick >= 12, `${venue} writes`);
    }
  });

  it("derives a 3% half-band from the live anchor", () => {
    const cfg = loadExperimentConfig();
    const mid = 100_000;
    const anchored = anchorGrid(cfg.grids.extended, mid);
    assert.ok(Math.abs(anchored.halfBand - mid * 0.03) < 1e-6);
    assert.ok(Math.abs(anchored.lower - mid * 0.97) < 1e-6);
    assert.ok(Math.abs(anchored.upper - mid * 1.03) < 1e-6);
    assert.equal(cfg.experiment.halfBandPct, 0.03);
  });

  it("keeps full-grid planned gross notional at or below 150U", () => {
    const cfg = loadExperimentConfig();
    const mid = 100_000;
    const anchored = anchorGrid(cfg.grids.risex, mid);
    const built = buildGrid({
      lower: anchored.lower,
      upper: anchored.upper,
      gridCount: anchored.gridCount,
    });
    const risk = computeRisk(built, anchored, mid);
    assert.ok(risk.notional <= 150 + 1e-6, `notional=${risk.notional}`);
    assert.ok(
      anchored.equityUsd * anchored.marginFraction * anchored.leverage <= 150 + 1e-6
    );
    const fee = assertFeeOk(risk.spacingPct, anchored.feeRate);
    assert.equal(fee.ok, true, fee.message);
    const margin = assertMarginOk(risk, anchored.equityUsd, anchored.marginFraction);
    assert.equal(margin.ok, true, margin.message);
  });

  it("refuses live mode without LIVE_CONFIRM=YES", () => {
    withEnv(
      {
        EXPERIMENT_MODE: "1",
        DRY_RUN: "0",
        LIVE_CONFIRM: "",
      },
      () => {
        const cfg = loadRuntimeConfig();
        assert.equal(cfg.dryRun, false);
        assert.throws(() => assertLiveAllowed(cfg), /LIVE_CONFIRM/);
      }
    );
  });

  it("refuses multi-venue live experiments and any drift from the frozen envelope", () => {
    withEnv(
      { EXPERIMENT_MODE: "1", DRY_RUN: "0", LIVE_CONFIRM: "YES", VENUES: "extended,risex", MARKETS: "BTC" },
      () => assert.throws(() => assertLiveAllowed(loadRuntimeConfig()), /恰好 1 个 venue/)
    );
    withEnv(
      { EXPERIMENT_MODE: "1", DRY_RUN: "0", LIVE_CONFIRM: "YES", VENUES: "extended", MARKETS: "BTC", EXPERIMENT_LEVERAGE: "11" },
      () => assert.throws(() => assertLiveAllowed(loadRuntimeConfig()), /冻结值/)
    );
    withEnv(
      { EXPERIMENT_MODE: "1", DRY_RUN: "0", LIVE_CONFIRM: "YES", VENUES: "extended", MARKETS: "BTC", EXPERIMENT_ACCOUNT_SCOPE: "" },
      () => assert.throws(() => assertLiveAllowed(loadRuntimeConfig()), /EXPERIMENT_ACCOUNT_SCOPE/)
    );
    withEnv(
      { EXPERIMENT_MODE: "1", DRY_RUN: "0", LIVE_CONFIRM: "YES", VENUES: "extended", MARKETS: "BTC", EXPERIMENT_ACCOUNT_SCOPE: "research-1", EXPERIMENT_ID: "not-allowed" },
      () => assert.throws(() => assertLiveAllowed(loadRuntimeConfig()), /allowlist/)
    );
  });

  it("prints the frozen experiment envelope", async () => {
    const { formatExperimentBanner } = await import("../src/config.js");
    const cfg = loadExperimentConfig();
    const banner = formatExperimentBanner(cfg);
    assert.match(banner, /EXPERIMENT MODE/);
    assert.match(banner, /capital=50U/);
    assert.match(banner, /leverage=10x/);
    assert.match(banner, /marginBudget=15U/);
    assert.match(banner, /maxGrossNotional=150U/);
    assert.match(banner, /gridCount=12/);
    assert.match(banner, /halfBand=3%/);
    assert.match(banner, /dailyLossLimit=2\.5U/);
    assert.match(banner, /maxDrawdown=5U/);
  });

  it("leaves legacy venue leverage in place when experiment mode is off", () => {
    const cfg = withEnv(
      {
        EXPERIMENT_MODE: undefined,
        ...VENUE_LEVERAGE_ENV,
      },
      () => loadRuntimeConfig()
    );
    assert.equal(cfg.experiment.enabled, false);
    assert.equal(cfg.grids.extended.leverage, 30);
    assert.equal(cfg.grids.risex.leverage, 25);
    assert.equal(cfg.grids.phoenix.leverage, 40);
    assert.equal(cfg.grids.extended.equityUsd, 800);
    assert.equal(cfg.grids.extended.gridCount, 80);
    assert.equal(cfg.grids.risex.gridCount, 46);
  });
});
