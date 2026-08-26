import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anchorGrid,
  assertLiveAllowed,
  formatExperimentBanner,
  loadRuntimeConfig,
  parseExperimentConfig,
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

const V02_DRIFT_ENV: Record<string, string> = {
  EXPERIMENT_CAPITAL_USD: "50",
  EXPERIMENT_LEVERAGE: "10",
  EXPERIMENT_MARGIN_FRAC: "0.7",
  EXPERIMENT_GRID_COUNT: "12",
  EXPERIMENT_HALF_BAND_PCT: "0.045",
  EXPERIMENT_MAX_GROSS_NOTIONAL_USD: "999",
  EXPERIMENT_DAILY_LOSS_USD: "2.5",
  EXPERIMENT_MAX_DRAWDOWN_USD: "5",
  EXPERIMENT_BOUNDARY_BUFFER_PCT: "0.05",
  TICK_MS: "1000",
};

function loadV02() {
  return withEnv(
    {
      EXPERIMENT_MODE: "1",
      EXPERIMENT_SPEC_VERSION: "0.2.0",
      EXPERIMENT_ID: "classic-v02-dryrun",
      ...VENUE_LEVERAGE_ENV,
      ...V02_DRIFT_ENV,
      GRID_MARGIN_FRAC: "0.7",
      POPDEX_EQUITY_USD: "800",
      POPDEX_GRID_COUNT: "80",
      DECIBEL_EQUITY_USD: "800",
      N1_EQUITY_USD: "800",
    },
    () => loadRuntimeConfig()
  );
}

describe("Checkpoint A versioned v0.2 configuration", () => {
  it("A1: v0.2 resolves 100U capital and ignores env drift", () => {
    const cfg = loadV02();
    assert.equal(cfg.experiment.specVersion, "0.2.0");
    assert.equal(cfg.experiment.capitalUsd, 100);
    for (const venue of ALL_VENUES) {
      assert.equal(cfg.grids[venue].equityUsd, 100, `${venue} equity`);
    }
  });

  it("A2: v0.2 resolves 5x leverage for every experiment grid", () => {
    const cfg = loadV02();
    assert.equal(cfg.experiment.leverage, 5);
    for (const venue of ALL_VENUES) {
      assert.equal(cfg.grids[venue].leverage, 5, `${venue} leverage`);
    }
  });

  it("A3: v0.2 resolves 0.30 margin fraction and exact 30U margin budget", () => {
    const cfg = loadV02();
    assert.equal(cfg.experiment.marginFraction, 0.3);
    assert.equal(cfg.experiment.marginBudgetUsd, 30);
    assert.equal(cfg.experiment.capitalUsd * cfg.experiment.marginFraction, 30);
    assert.equal(cfg.experiment.capitalUsd * cfg.experiment.marginFraction * cfg.experiment.leverage, 150);
    for (const venue of ALL_VENUES) {
      assert.equal(cfg.grids[venue].marginFraction, 0.3, `${venue} margin`);
    }
  });

  it("A4: v0.2 resolves 10 grid levels", () => {
    const cfg = loadV02();
    assert.equal(cfg.experiment.gridCount, 10);
    for (const venue of ALL_VENUES) {
      assert.equal(cfg.grids[venue].gridCount, 10, `${venue} gridCount`);
    }
  });

  it("A5: v0.2 resolves 0.03 / ±3% half-band", () => {
    const cfg = loadV02();
    assert.equal(cfg.experiment.halfBandPct, 0.03);
    const mid = 100_000;
    const anchored = anchorGrid(cfg.grids.extended, mid);
    assert.ok(Math.abs(anchored.halfBand - mid * 0.03) < 1e-6);
    assert.ok(Math.abs(anchored.lower - mid * 0.97) < 1e-6);
    assert.ok(Math.abs(anchored.upper - mid * 1.03) < 1e-6);
  });

  it("A6: v0.2 resolves 150U max gross notional", () => {
    const cfg = loadV02();
    assert.equal(cfg.experiment.maxGrossNotionalUsd, 150);
  });

  it("A7: v0.2 resolves 5U daily-loss threshold", () => {
    const cfg = loadV02();
    assert.equal(cfg.experiment.dailyLossUsd, 5);
  });

  it("A8: v0.2 resolves 10U drawdown threshold", () => {
    const cfg = loadV02();
    assert.equal(cfg.experiment.maxDrawdownUsd, 10);
  });

  it("A9: v0.2 resolves 0.01 boundary buffer", () => {
    const cfg = loadV02();
    assert.equal(cfg.experiment.boundaryBufferPct, 0.01);
  });

  it("A10: unsupported or malformed spec version fails closed and does not fall back to v0.2", () => {
    for (const version of ["0.3.0", "0.2", "v0.2.0", "0.2.0-beta", "0.1.0,0.2.0", "latest"]) {
      withEnv(
        { EXPERIMENT_MODE: "1", EXPERIMENT_SPEC_VERSION: version },
        () => {
          assert.throws(
            () => parseExperimentConfig(),
            /EXPERIMENT_SPEC_VERSION_UNSUPPORTED/,
            version
          );
          assert.throws(
            () => loadRuntimeConfig(),
            /EXPERIMENT_SPEC_VERSION_UNSUPPORTED/,
            version
          );
        }
      );
    }
  });

  it("A11: historical v0.1 values remain unchanged for absent and explicit 0.1.0", () => {
    const absent = withEnv(
      { EXPERIMENT_MODE: "1", EXPERIMENT_SPEC_VERSION: undefined, EXPERIMENT_ID: "classic-dryrun-001" },
      () => loadRuntimeConfig()
    );
    const explicit = withEnv(
      { EXPERIMENT_MODE: "1", EXPERIMENT_SPEC_VERSION: "0.1.0", EXPERIMENT_ID: "classic-dryrun-001" },
      () => loadRuntimeConfig()
    );
    for (const cfg of [absent, explicit]) {
      assert.equal(cfg.experiment.specVersion, "0.1.0");
      assert.equal(cfg.experiment.capitalUsd, 50);
      assert.equal(cfg.experiment.leverage, 10);
      assert.equal(cfg.experiment.marginFraction, 0.3);
      assert.equal(cfg.experiment.marginBudgetUsd, 15);
      assert.equal(cfg.experiment.gridCount, 12);
      assert.equal(cfg.experiment.halfBandPct, 0.03);
      assert.equal(cfg.experiment.maxGrossNotionalUsd, 150);
      assert.equal(cfg.experiment.dailyLossUsd, 2.5);
      assert.equal(cfg.experiment.maxDrawdownUsd, 5);
      assert.equal(cfg.experiment.boundaryBufferPct, 0.01);
      assert.equal(cfg.grids.extended.leverage, 10);
      assert.equal(cfg.grids.extended.equityUsd, 50);
      assert.equal(cfg.grids.extended.gridCount, 12);
    }
  });

  it("A12: non-experiment defaults remain unchanged even if v0.2 version is set", () => {
    const cfg = withEnv(
      {
        EXPERIMENT_MODE: undefined,
        EXPERIMENT_SPEC_VERSION: "0.2.0",
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
    assert.equal(cfg.grids.extended.marginFraction, 0.7);
  });

  it("A13: v0.2 DRY_RUN=0 + LIVE_CONFIRM=YES is still rejected", () => {
    withEnv(
      {
        EXPERIMENT_MODE: "1",
        EXPERIMENT_SPEC_VERSION: "0.2.0",
        DRY_RUN: "0",
        LIVE_CONFIRM: "YES",
        VENUES: "extended",
        MARKETS: "BTC",
        EXPERIMENT_ID: "grid-ab-v0.1-classic-live",
        EXPERIMENT_ACCOUNT_SCOPE: "research-1",
      },
      () => {
        const cfg = loadRuntimeConfig();
        assert.equal(cfg.dryRun, false);
        assert.equal(cfg.liveConfirm, true);
        assert.equal(cfg.experiment.specVersion, "0.2.0");
        assert.throws(() => assertLiveAllowed(cfg), /EXPERIMENT_V02_LIVE_FORBIDDEN|尚未授权 live/);
      }
    );
  });

  it("A14: single venue / single market restriction remains enforced", () => {
    withEnv(
      {
        EXPERIMENT_MODE: "1",
        EXPERIMENT_SPEC_VERSION: "0.1.0",
        DRY_RUN: "0",
        LIVE_CONFIRM: "YES",
        VENUES: "extended,risex",
        MARKETS: "BTC",
      },
      () => assert.throws(() => assertLiveAllowed(loadRuntimeConfig()), /恰好 1 个 venue/)
    );
    withEnv(
      {
        EXPERIMENT_MODE: "1",
        EXPERIMENT_SPEC_VERSION: "0.2.0",
        DRY_RUN: "0",
        LIVE_CONFIRM: "YES",
        VENUES: "extended,risex",
        MARKETS: "BTC,ETH",
      },
      () => assert.throws(() => assertLiveAllowed(loadRuntimeConfig()), /EXPERIMENT_V02_LIVE_FORBIDDEN|尚未授权 live|恰好 1 个/)
    );
    const cfg = loadV02();
    assert.equal(cfg.tickMs, 15_000);
    const banner = formatExperimentBanner(cfg);
    assert.match(banner, /capital=100U/);
    assert.match(banner, /leverage=5x/);
    assert.match(banner, /marginBudget=30U/);
    assert.match(banner, /gridCount=10/);
    assert.equal(cfg.experiment.specVersion, "0.2.0");
  });

  it("A15: v0.2 full-grid sizing arithmetic cannot exceed 150U", () => {
    const cfg = loadV02();
    const mid = 100_000;
    const anchored = anchorGrid(cfg.grids.extended, mid);
    const built = buildGrid({
      lower: anchored.lower,
      upper: anchored.upper,
      gridCount: anchored.gridCount,
    });
    const risk = computeRisk(built, anchored, mid);
    const planned = anchored.equityUsd * anchored.marginFraction * anchored.leverage;
    assert.equal(planned, 150);
    assert.ok(risk.notional <= 150 + 1e-6, `notional=${risk.notional}`);
    assert.ok(planned <= cfg.experiment.maxGrossNotionalUsd + 1e-6);
    const fee = assertFeeOk(risk.spacingPct, anchored.feeRate);
    assert.equal(fee.ok, true, fee.message);
    const margin = assertMarginOk(risk, anchored.equityUsd, anchored.marginFraction);
    assert.equal(margin.ok, true, margin.message);
  });
});
