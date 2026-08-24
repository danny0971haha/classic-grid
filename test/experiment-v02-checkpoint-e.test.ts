import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertLiveAllowed,
  formatExperimentBanner,
  loadRuntimeConfig,
  parseExperimentConfig,
} from "../src/config.js";
import {
  createExperimentTelemetry,
  publishExecutionJournal,
  resolveExecutionCursorPath,
} from "../src/experimentTelemetry.js";
import {
  CHECKPOINT_E_CASE_IDS,
  DEFAULT_EVIDENCE_COMMAND,
  DEFAULT_PRECHECK_COMMAND,
  EvidenceError,
  MIN_PROJECT_SUITE_TOTAL,
  collectFileHashes,
  defaultProjectTapCommand,
  generateEvidenceFromRun,
  parseCheckpointETap,
  renderCheckpointETap,
  renderProjectTap,
} from "../tools/checkpoint-e-evidence.js";
import {
  emptyRiskState,
  evaluateExperimentRisk,
  initializeRiskStateStore,
  loadRiskState,
  persistRiskState,
  type ExperimentRiskState,
} from "../src/experimentRisk.js";
import {
  experimentAllowsReseed,
  runActualNotionalHardHalt,
} from "../src/experimentReduction.js";
import { runExperimentKillSwitch } from "../src/experimentKillSwitch.js";
import { applyPlannerIntentGate, expectedOwnedClientOrderId, planFromFillsAndSeed } from "../src/grid.js";
import { ExtendedAccountStreamState } from "../src/venues/extendedAccountStream.js";
import { ExtendedExecutor } from "../src/venues/extended.js";
import type { Intent, LiveOrder } from "../src/types.js";
import { withEnv } from "./helpers/env.js";
import {
  MARKET,
  SCOPE,
  freshSnapshot,
  ownedOrder,
  scriptedTransport,
} from "./helpers/reduction.js";

const HERE = fileURLToPath(import.meta.url);
const WORKER = fileURLToPath(new URL("./fixtures/checkpoint-e-worker.ts", import.meta.url));
const PREFIX = "cg:test:";
const EPOCH = 42;
const LEVELS = [99_000, 100_000, 101_000];
const SIZE = 0.001;
const V02_LIMITS = {
  maxGrossNotionalUsd: 150,
  dailyLossUsd: 5,
  maxDrawdownUsd: 10,
  boundaryBufferPct: 0.01,
};

function cid(side: "buy" | "sell", level: number): string {
  return expectedOwnedClientOrderId(PREFIX, EPOCH, side, level);
}

function live(p: {
  id: string;
  side?: "buy" | "sell";
  level?: number;
  price?: number;
  size?: number;
  market?: string;
  clientOrderId?: string;
  exchangeOrderId?: string;
}): LiveOrder {
  const side = p.side ?? "buy";
  const level = p.level ?? 0;
  return {
    id: p.id,
    market: p.market ?? "BTC",
    side,
    price: p.price ?? LEVELS[level]!,
    size: p.size ?? SIZE,
    level,
    clientOrderId: p.clientOrderId === undefined ? cid(side, level) : p.clientOrderId,
    ...(p.exchangeOrderId !== undefined ? { exchangeOrderId: p.exchangeOrderId } : {}),
  };
}

function plan(openOrders: LiveOrder[], extra: Record<string, unknown> = {}) {
  return planFromFillsAndSeed({
    market: "BTC",
    mid: 100_000,
    levels: LEVELS,
    spacing: 1_000,
    mode: "neutral",
    sizeBase: SIZE,
    openOrders,
    prevActive: new Map(),
    maxWrites: 10,
    seeded: true,
    ownershipPrefix: PREFIX,
    anchorEpoch: EPOCH,
    ...extra,
  });
}

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `classic-e-${label}-`));
}

function spawnWorker(env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", WORKER], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function lastJson(stdout: string): any {
  const line = String(stdout || "").trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, stdout);
  return JSON.parse(line);
}

type DurableCursor = {
  publishedDedupeKeys: string[];
  pendingAuthoritative: Array<{
    exchangeTradeId?: string;
    dedupeKey?: string;
    source?: string;
    authoritative?: boolean;
  }>;
};

function readDurableCursor(cursorPath: string): DurableCursor {
  assert.equal(fs.existsSync(cursorPath), true, `missing durable cursor ${cursorPath}`);
  const parsed = JSON.parse(fs.readFileSync(cursorPath, "utf8")) as Partial<DurableCursor>;
  assert.equal(Array.isArray(parsed.publishedDedupeKeys), true);
  assert.equal(Array.isArray(parsed.pendingAuthoritative), true);
  return {
    publishedDedupeKeys: parsed.publishedDedupeKeys as string[],
    pendingAuthoritative: parsed.pendingAuthoritative as DurableCursor["pendingAuthoritative"],
  };
}

function spawnJournalReplay(p: {
  cursorPath: string;
  experimentId: string;
  tradeId: string;
  acknowledge: boolean;
}) {
  const child = spawnWorker({
    CLASSIC_E_ACTION: "journal-replay",
    CLASSIC_E_CURSOR_PATH: p.cursorPath,
    CLASSIC_E_EXPERIMENT_ID: p.experimentId,
    CLASSIC_E_TRADE_ID: p.tradeId,
    CLASSIC_E_ACK: p.acknowledge ? "1" : "0",
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const replayed = lastJson(child.stdout) as {
    pid: number;
    blocked: boolean;
    publishedKeys: string[];
    authoritativeFills: Array<{
      exchangeTradeId: string | null;
      dedupeKey: string;
      source: string;
      authoritative: boolean;
    }>;
    durablePublishedDedupeKeys: string[];
    durablePending: Array<{
      exchangeTradeId: string | null;
      dedupeKey: string | null;
      source: string | null;
      authoritative: boolean;
    }>;
  };
  assert.equal(typeof replayed.pid, "number");
  assert.notEqual(replayed.pid, process.pid);
  return replayed;
}

function seedRunning(id: string, dir: string, leaseGeneration = "lease-1"): ExperimentRiskState {
  initializeRiskStateStore({
    experimentId: id,
    baseDir: dir,
    scopeKey: SCOPE,
    leaseGeneration,
  });
  persistRiskState(id, { ...emptyRiskState(SCOPE), leaseGeneration }, dir);
  const loaded = loadRiskState(id, dir, SCOPE);
  assert.equal(loaded.haltStatus, "RUNNING");
  return loaded;
}

function loadV02() {
  return withEnv(
    {
      EXPERIMENT_MODE: "1",
      EXPERIMENT_SPEC_VERSION: "0.2.0",
      EXPERIMENT_ID: "classic-v02-dryrun",
      EXPERIMENT_CAPITAL_USD: "50",
      EXPERIMENT_LEVERAGE: "10",
    },
    () => loadRuntimeConfig()
  );
}

function initializedJournal(cursorPath?: string, experimentId = "classic-e-journal") {
  const now = (() => {
    let value = 1_700_000_000_000;
    return () => value++;
  })();
  const state = new ExtendedAccountStreamState(now, cursorPath ? {
    cursorPath,
    cursorIdentity: { experimentId, scopeKey: "dry-run:extended:BTC", venue: "extended", market: "BTC" },
  } : undefined);
  const ts = 1_700_000_000_000;
  state.ingest({ type: "BALANCE", data: { balance: { equity: "100" } }, ts, seq: 1 });
  state.ingest({ type: "POSITION", data: { positions: [] }, ts, seq: 1 });
  state.ingest({ type: "ORDER", data: { orders: [] }, ts, seq: 1 });
  return state;
}

function trade(partial: Record<string, unknown> = {}) {
  return {
    type: "TRADE" as const,
    ts: 1_700_000_000_002,
    seq: 2,
    data: {
      trades: [{
        id: "tr-1",
        market: "BTC-USD",
        side: "BUY",
        price: "100000",
        qty: "0.001",
        orderId: "ord-1",
        externalId: "cg:1-buy-3",
        filledQty: "0.001",
        remainingQty: "0",
        timestamp: 1_700_000_000_002,
        ...partial,
      }],
    },
  };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) out.push([items[i]!, ...perm]);
  }
  return out;
}

function riskInput(partial: Record<string, unknown> = {}) {
  return {
    mid: 100_000,
    equityUsd: 100,
    dailyPnlUsd: 0,
    positionQty: 0,
    positionNotionalUsd: 0,
    plannedGrossNotionalUsd: 150,
    gridLower: 97_000,
    gridUpper: 103_000,
    ...partial,
  };
}

describe("Checkpoint E integrated dry-run and fault campaign", () => {
  it("E-01 frozen v0.2 dry-run banner", () => {
    const cfg = loadV02();
    const banner = formatExperimentBanner(cfg);
    assert.match(banner, /EXPERIMENT MODE/);
    assert.match(banner, /capital=100U/);
    assert.match(banner, /leverage=5x/);
    assert.match(banner, /marginBudget=30U/);
    assert.match(banner, /maxGrossNotional=150U/);
    assert.match(banner, /gridCount=10/);
    assert.match(banner, /halfBand=3%/);
    assert.match(banner, /dailyLossLimit=5U/);
    assert.match(banner, /maxDrawdown=10U/);
    assert.equal(cfg.experiment.specVersion, "0.2.0");
    assert.equal(cfg.dryRun, true);
    assert.equal(cfg.experiment.capitalUsd * cfg.experiment.marginFraction * cfg.experiment.leverage, 150);
  });

  it("E-02 zero live/network mutation", async () => {
    const cfg = loadV02();
    assert.doesNotThrow(() => assertLiveAllowed(cfg));
    withEnv(
      {
        EXPERIMENT_MODE: "1",
        EXPERIMENT_SPEC_VERSION: "0.2.0",
        DRY_RUN: "0",
        LIVE_CONFIRM: "YES",
        VENUES: "extended",
        MARKETS: "BTC",
        EXPERIMENT_ID: "classic-v02-dryrun",
      },
      () => {
        assert.throws(() => assertLiveAllowed(loadRuntimeConfig()), /EXPERIMENT_V02_LIVE_FORBIDDEN|尚未授权 live/);
      }
    );
    const gridSrc = fs.readFileSync(new URL("../src/grid.ts", import.meta.url), "utf8");
    assert.doesNotMatch(gridSrc, /\bfetch\s*\(/);
    const executor = new ExtendedExecutor(true);
    await executor.connect();
    const applied = await executor.apply([
      { type: "cancel", orderId: "dry", market: "BTC" },
    ]);
    assert.equal(applied.failed, 0);
    assert.equal(executor.drainExecutionJournal?.().executions.length ?? 0, 0);
    executor.disconnect();
  });

  it("E-03 planner duplicate permutation campaign", () => {
    const orders = [
      live({ id: "id-c", exchangeOrderId: "ex-c", side: "buy", level: 0 }),
      live({ id: "id-a", exchangeOrderId: "ex-a", side: "buy", level: 0 }),
      live({ id: "id-b", exchangeOrderId: "ex-b", side: "buy", level: 0 }),
    ];
    const serialized = new Set<string>();
    for (const openOrders of permutations(orders)) {
      const result = plan(openOrders);
      assert.deepEqual(result.filled, []);
      assert.equal(result.completedRungs, 0);
      assert.deepEqual([...result.nextActive.keys()], ["id-a"]);
      serialized.add(JSON.stringify({
        intents: result.intents,
        nextActive: [...result.nextActive.entries()],
        plannerDisposition: result.plannerDisposition,
      }));
    }
    assert.equal(serialized.size, 1);
  });

  it("E-04 cancel capacity not released early", () => {
    const keep = live({ id: "a", exchangeOrderId: "a", side: "buy", level: 0 });
    const drop = live({ id: "m", exchangeOrderId: "m", side: "buy", level: 0 });
    const first = plan([keep, drop], { maxOpenOrders: 2 });
    assert.equal(first.currentSnapshotVenueCount, 2);
    assert.equal(first.capacityAfterAuthoritativeSnapshot, 0);
    assert.equal(first.intents.some((i) => i.type === "place"), false);
    const child = spawnWorker({
      CLASSIC_E_ACTION: "plan",
      CLASSIC_E_ORDERS: JSON.stringify([keep, drop]),
      CLASSIC_E_PLAN_EXTRA: JSON.stringify({ maxOpenOrders: 2 }),
    });
    assert.equal(child.status, 0, child.stderr);
    const replayed = lastJson(child.stdout);
    assert.equal(replayed.capacityAfterAuthoritativeSnapshot, 0);
    assert.equal(replayed.intents.some((i: Intent) => i.type === "place"), false);
    const afterAbsence = plan([keep], { maxOpenOrders: 2 });
    assert.equal(afterAbsence.capacityAfterAuthoritativeSnapshot, 1);
  });

  it("E-05 cross-market and unlocatable ambiguity block place globally", () => {
    const eth = live({ id: "eth", exchangeOrderId: "eth", side: "buy", level: 0, market: "ETH" });
    const owned = live({ id: "btc", exchangeOrderId: "btc", side: "sell", level: 2 });
    const cross = applyPlannerIntentGate(plan([eth, owned]));
    assert.equal(cross.plannerDisposition, "RISK_INCREASE_BLOCKED");
    assert.equal(cross.intents.some((i) => i.type === "place"), false);
    assert.equal(cross.intents.some((i) => i.type === "cancel" && i.orderId === "eth"), false);
    const ambiguous = plan([live({ id: "", price: 50_000, clientOrderId: `${PREFIX}zzzz` })]);
    assert.equal(ambiguous.plannerDisposition, "RISK_INCREASE_BLOCKED");
    assert.equal(ambiguous.intents.some((i) => i.type === "place"), false);
    const unowned = plan([live({ id: "manual", side: "buy", level: 0, clientOrderId: "manual-bot" })]);
    assert.equal(unowned.intents.some((i) => i.type === "cancel"), false);
    assert.equal(unowned.nextActive.has("manual"), false);
  });

  it("E-06 authoritative full execution", () => {
    const state = initializedJournal();
    state.ingest(trade());
    const drain = state.drainJournal();
    assert.equal(drain.authoritativeExecutions.length, 1);
    assert.equal(drain.authoritativeExecutions[0]!.source, "exchange");
    assert.equal(drain.authoritativeExecutions[0]!.authoritative, true);
    const events: string[] = [];
    publishExecutionJournal((event) => {
      events.push(event);
      return true;
    }, drain);
    assert.deepEqual(events, ["FILL"]);
    const gone = plan([], {
      prevActive: new Map([["gone", { levelIndex: 2, side: "sell", price: 101_000, size: SIZE }]]),
    });
    assert.deepEqual(gone.filled, []);
  });

  it("E-07 partial execution", () => {
    const state = initializedJournal();
    state.ingest(trade({ qty: "0.0004", filledQty: "0.0004", remainingQty: "0.0006" }));
    const row = state.journalSnapshot().executions[0]!;
    assert.equal(row.quantity, 0.0004);
    assert.equal(row.cumulativeFilledQuantity, 0.0004);
    assert.equal(row.remainingQuantity, 0.0006);
    assert.equal(row.authoritative, true);
  });

  it("E-08 cursor pre-publication crash", () => {
    const dir = tmpDir("e08");
    const experimentId = "classic-e08";
    const cursorPath = resolveExecutionCursorPath({
      experimentId,
      scopeKey: "dry-run:extended:BTC",
      venue: "extended",
      market: "BTC",
      baseDir: dir,
    });
    const now = (() => {
      let value = 1_700_000_000_000;
      return () => value++;
    })();
    const state = new ExtendedAccountStreamState(now, {
      cursorPath,
      cursorIdentity: { experimentId, scopeKey: "dry-run:extended:BTC", venue: "extended", market: "BTC" },
      onCursorPersistStep(step) {
        if (step === "BEFORE_MEMORY_COMMIT") throw new Error("E08_PRE_PUBLICATION");
      },
    });
    const ts = 1_700_000_000_000;
    state.ingest({ type: "BALANCE", data: { balance: { equity: "100" } }, ts, seq: 1 });
    state.ingest({ type: "POSITION", data: { positions: [] }, ts, seq: 1 });
    state.ingest({ type: "ORDER", data: { orders: [] }, ts, seq: 1 });
    try {
      state.ingest(trade({ id: "tr-e08" }));
    } catch (error) {
      assert.match(String((error as Error).message), /E08_PRE_PUBLICATION|CURSOR/);
    }
    assert.equal(state.cursorPersistenceBlocked() || state.journalSnapshot().authoritativeCount === 0, true);
    const drain = state.drainJournal();
    const fills: string[] = [];
    publishExecutionJournal((event, fields) => {
      if (event === "FILL") fills.push(String(fields?.exchange_trade_id ?? ""));
      return true;
    }, drain);
    assert.equal(drain.authoritativeExecutions.length, 0);
    assert.deepEqual(fills, []);
  });

  it("E-09 watermark failure at-least-once replay", () => {
    const dir = tmpDir("e09");
    const experimentId = "classic-e09";
    const tradeId = "tr-e09-stable";
    const dedupeKey = `extended|BTC-USD|trade|${tradeId}`;
    const cursorPath = resolveExecutionCursorPath({
      experimentId,
      scopeKey: "dry-run:extended:BTC",
      venue: "extended",
      market: "BTC",
      baseDir: dir,
    });
    let persistCalls = 0;
    const now = (() => {
      let value = 1_700_000_000_000;
      return () => value++;
    })();
    const state = new ExtendedAccountStreamState(now, {
      cursorPath,
      cursorIdentity: { experimentId, scopeKey: "dry-run:extended:BTC", venue: "extended", market: "BTC" },
      onCursorPersistStep(step) {
        if (step !== "BEFORE_TEMP_OPEN") return;
        persistCalls += 1;
        if (persistCalls >= 2) throw new Error("CURSOR_WATERMARK_PERSIST_FAIL");
      },
    });
    const ts = 1_700_000_000_000;
    state.ingest({ type: "BALANCE", data: { balance: { equity: "100" } }, ts, seq: 1 });
    state.ingest({ type: "POSITION", data: { positions: [] }, ts, seq: 1 });
    state.ingest({ type: "ORDER", data: { orders: [] }, ts, seq: 1 });
    state.ingest(trade({ id: tradeId }));
    const tel = createExperimentTelemetry({
      experimentId,
      mode: "dry-run",
      venue: "extended",
      symbol: "BTC",
      commitSha: "abc",
      baseDir: tmpDir("e09-tel"),
      manifestFields: {
        experiment_spec_version: "0.2.0",
        starting_capital_usd: 100,
        leverage: 5,
        max_margin_budget_usd: 30,
        max_planned_gross_notional_usd: 150,
        grid_half_band_pct: 3,
        grid_level_count: 10,
        daily_loss_limit_usd: 5,
        max_drawdown_usd: 10,
        boundary_buffer_pct: 1,
      },
    });
    const drain = state.drainJournal();
    assert.equal(drain.authoritativeExecutions.length, 1);
    assert.equal(drain.authoritativeExecutions[0]!.exchangeTradeId, tradeId);
    assert.equal(drain.authoritativeExecutions[0]!.dedupeKey, dedupeKey);
    assert.equal(drain.authoritativeExecutions[0]!.source, "exchange");
    assert.equal(drain.authoritativeExecutions[0]!.authoritative, true);
    const publishedTradeIds: string[] = [];
    const keys = publishExecutionJournal((event, fields) => {
      if (event === "FILL") publishedTradeIds.push(String(fields?.exchange_trade_id ?? ""));
      return true;
    }, drain);
    assert.deepEqual(keys, [dedupeKey]);
    assert.deepEqual(publishedTradeIds, [tradeId]);
    state.acknowledgeJournal(keys);
    assert.equal(state.cursorPersistenceBlocked(), true);
    const durableAfterFailedAck = readDurableCursor(cursorPath);
    assert.equal(durableAfterFailedAck.publishedDedupeKeys.includes(dedupeKey), false);
    assert.deepEqual(durableAfterFailedAck.pendingAuthoritative.map((row) => row.dedupeKey), [dedupeKey]);
    assert.deepEqual(durableAfterFailedAck.pendingAuthoritative.map((row) => row.exchangeTradeId), [tradeId]);
    assert.equal(durableAfterFailedAck.pendingAuthoritative[0]!.source, "exchange");
    assert.equal(durableAfterFailedAck.pendingAuthoritative[0]!.authoritative, true);

    const replayed = spawnJournalReplay({ cursorPath, experimentId, tradeId, acknowledge: true });
    assert.equal(replayed.blocked, false);
    assert.equal(replayed.authoritativeFills.length, 1);
    assert.equal(replayed.authoritativeFills[0]!.exchangeTradeId, tradeId);
    assert.equal(replayed.authoritativeFills[0]!.dedupeKey, dedupeKey);
    assert.equal(replayed.authoritativeFills[0]!.source, "exchange");
    assert.equal(replayed.authoritativeFills[0]!.authoritative, true);
    assert.deepEqual(replayed.publishedKeys, [dedupeKey]);
    assert.deepEqual(replayed.durablePublishedDedupeKeys, [dedupeKey]);
    assert.deepEqual(replayed.durablePending, []);

    const afterAck = spawnJournalReplay({ cursorPath, experimentId, tradeId, acknowledge: false });
    assert.equal(afterAck.blocked, false);
    assert.deepEqual(afterAck.authoritativeFills, []);
    assert.deepEqual(afterAck.publishedKeys, []);
    assert.deepEqual(afterAck.durablePublishedDedupeKeys, [dedupeKey]);
    assert.deepEqual(afterAck.durablePending, []);
  });

  it("E-10 actual notional active flatten", async () => {
    const dir = tmpDir("e10");
    const id = "classic-e10";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 151, positionQty: 0.00151 }),
      V02_LIMITS,
      running
    );
    assert.ok(evaluated.decision.reasons.includes("ACTUAL_NOTIONAL_CAP"));
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: (n) => freshSnapshot({
        positionQty: n === 1 ? 0.00151 : 0,
        openOrders: [],
        observationId: `e10-${n}`,
        sourceGeneration: `g-e10-${n}`,
      }),
    });
    const result = await runActualNotionalHardHalt({
      experimentId: id,
      market: MARKET,
      ownershipPrefix: "cg:classic-v02-dryrun:",
      positionQty: 0.00151,
      openOrders: [ownedOrder({ side: "buy" })],
      reasons: ["ACTUAL_NOTIONAL_CAP"],
      transport,
      assertLeaseCurrent: () => undefined,
      leaseGeneration: "lease-1",
      baseDir: dir,
      scopeKey: SCOPE,
      state: evaluated.next,
    });
    assert.ok(transport.flattenCalls >= 1);
    assert.notEqual(result.state.haltStatus, "RUNNING");
    assert.equal(experimentAllowsReseed(result.state), false);
  });

  it("E-11 daily-loss halt", () => {
    const { decision, next } = evaluateExperimentRisk(
      riskInput({ dailyPnlUsd: -5 }),
      V02_LIMITS,
      emptyRiskState(SCOPE)
    );
    assert.equal(decision.halt, true);
    assert.ok(decision.reasons.includes("DAILY_LOSS"));
    assert.equal(next.halted, true);
  });

  it("E-12 drawdown halt", () => {
    const first = evaluateExperimentRisk(riskInput({ equityUsd: 100 }), V02_LIMITS, emptyRiskState(SCOPE));
    const { decision, next } = evaluateExperimentRisk(
      riskInput({ equityUsd: 90 }),
      V02_LIMITS,
      first.next
    );
    assert.equal(decision.halt, true);
    assert.ok(decision.reasons.includes("DRAWDOWN_FROM_START"));
    assert.equal(next.drawdownFromStartUsd, 10);
  });

  it("E-13 long boundary halt", () => {
    const { decision } = evaluateExperimentRisk(
      riskInput({ mid: 97_000 * 0.99 - 1, positionQty: 0.001, positionNotionalUsd: 100 }),
      V02_LIMITS,
      emptyRiskState(SCOPE)
    );
    assert.equal(decision.halt, true);
    assert.ok(decision.reasons.includes("RISK_BOUNDARY_BREACH"));
  });

  it("E-14 short boundary halt", () => {
    const { decision } = evaluateExperimentRisk(
      riskInput({ mid: 103_000 * 1.01 + 1, positionQty: -0.001, positionNotionalUsd: 100 }),
      V02_LIMITS,
      emptyRiskState(SCOPE)
    );
    assert.equal(decision.halt, true);
    assert.ok(decision.reasons.includes("RISK_BOUNDARY_BREACH"));
  });

  it("E-15 stale inputs fail closed", () => {
    const missing = evaluateExperimentRisk(
      riskInput({ equityUsd: null, dailyPnlUsd: null, requireFreshInputs: true, snapshotAgeMs: 0, pnlAgeMs: 0 }),
      V02_LIMITS,
      emptyRiskState(SCOPE)
    );
    assert.equal(missing.decision.halt, true);
    const stale = evaluateExperimentRisk(
      riskInput({ requireFreshInputs: true, snapshotAgeMs: 120_001, pnlAgeMs: 120_001 }),
      V02_LIMITS,
      emptyRiskState(SCOPE)
    );
    assert.equal(stale.decision.halt, true);
    assert.ok(stale.decision.reasons.includes("SNAPSHOT_STALE"));
  });

  it("E-16 cancel UNKNOWN", async () => {
    const dir = tmpDir("e16");
    const id = "classic-e16";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      V02_LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "UNKNOWN",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0.0018, openOrders: [ownedOrder({ side: "buy" })] }),
    });
    const result = await runActualNotionalHardHalt({
      experimentId: id,
      market: MARKET,
      ownershipPrefix: "cg:classic-v02-dryrun:",
      positionQty: 0.0018,
      openOrders: [ownedOrder({ side: "buy" })],
      reasons: ["ACTUAL_NOTIONAL_CAP"],
      transport,
      assertLeaseCurrent: () => undefined,
      leaseGeneration: "lease-1",
      baseDir: dir,
      scopeKey: SCOPE,
      state: evaluated.next,
    });
    assert.notEqual(result.state.haltStatus, "RUNNING");
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.ok(transport.snapshotCalls >= 1);
  });

  it("E-17 flatten UNKNOWN", async () => {
    const dir = tmpDir("e17");
    const id = "classic-e17";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      V02_LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "UNKNOWN",
      snapshots: () => freshSnapshot({ positionQty: 0.0018 }),
    });
    const result = await runActualNotionalHardHalt({
      experimentId: id,
      market: MARKET,
      ownershipPrefix: "cg:classic-v02-dryrun:",
      positionQty: 0.0018,
      openOrders: [],
      reasons: ["ACTUAL_NOTIONAL_CAP"],
      transport,
      assertLeaseCurrent: () => undefined,
      leaseGeneration: "lease-1",
      baseDir: dir,
      scopeKey: SCOPE,
      state: evaluated.next,
    });
    assert.equal(result.flatten?.outcome, "UNKNOWN");
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
    assert.equal(experimentAllowsReseed(result.state), false);
  });

  it("E-18 lease loss before mutation", async () => {
    const dir = tmpDir("e18");
    const id = "classic-e18";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      V02_LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "ACK",
      snapshots: () => freshSnapshot({ positionQty: 0 }),
    });
    const result = await runActualNotionalHardHalt({
      experimentId: id,
      market: MARKET,
      ownershipPrefix: "cg:classic-v02-dryrun:",
      positionQty: 0.0018,
      openOrders: [ownedOrder({ side: "buy" })],
      reasons: ["ACTUAL_NOTIONAL_CAP"],
      transport,
      assertLeaseCurrent: () => {
        throw new Error("RUNTIME_LEASE_LOST");
      },
      leaseGeneration: "lease-1",
      baseDir: dir,
      scopeKey: SCOPE,
      state: evaluated.next,
    });
    assert.equal(transport.flattenCalls, 0);
    assert.notEqual(result.state.haltStatus, "HALTED_FLAT");
  });

  it("E-19 restart during HALTING", () => {
    const dir = tmpDir("e19");
    const id = "classic-e19";
    seedRunning(id, dir);
    persistRiskState(id, {
      ...emptyRiskState(SCOPE),
      halted: true,
      haltStatus: "HALTING",
      haltId: "halt-e19",
      haltReasons: ["ACTUAL_NOTIONAL_CAP"],
      leaseGeneration: "lease-1",
      acknowledged: false,
      updatedAt: "2026-08-24T00:00:00.000Z",
    }, dir);
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/experiment-reduction-restart-worker.ts", import.meta.url))], {
      env: { ...process.env, CLASSIC_RISK_ID: id, CLASSIC_RISK_DIR: dir, CLASSIC_RISK_SCOPE: SCOPE },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const replayed = lastJson(child.stdout);
    assert.equal(replayed.durableHalted, true);
    assert.equal(replayed.reseedAllowedFromDurable, false);
    assert.notEqual(replayed.nextHaltStatus, "RUNNING");
  });

  it("E-20 restart after flatten submit", async () => {
    const dir = tmpDir("e20");
    const id = "classic-e20";
    const running = seedRunning(id, dir);
    const evaluated = evaluateExperimentRisk(
      riskInput({ positionNotionalUsd: 180, positionQty: 0.0018 }),
      V02_LIMITS,
      running
    );
    const transport = scriptedTransport({
      cancel: "ACK",
      flatten: "UNKNOWN",
      snapshots: () => freshSnapshot({ positionQty: 0.0018 }),
    });
    const result = await runActualNotionalHardHalt({
      experimentId: id,
      market: MARKET,
      ownershipPrefix: "cg:classic-v02-dryrun:",
      positionQty: 0.0018,
      openOrders: [],
      reasons: ["ACTUAL_NOTIONAL_CAP"],
      transport,
      assertLeaseCurrent: () => undefined,
      leaseGeneration: "lease-1",
      baseDir: dir,
      scopeKey: SCOPE,
      state: evaluated.next,
    });
    assert.ok(transport.flattenCalls >= 1);
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/experiment-reduction-restart-worker.ts", import.meta.url))], {
      env: { ...process.env, CLASSIC_RISK_ID: id, CLASSIC_RISK_DIR: dir, CLASSIC_RISK_SCOPE: SCOPE },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const replayed = lastJson(child.stdout);
    assert.equal(replayed.durableHalted, true);
    assert.equal(replayed.reseedAllowedFromDurable, false);
    assert.notEqual(result.state.haltStatus, "RUNNING");
  });

  it("E-21 restart during ACK", () => {
    const dir = tmpDir("e21");
    const id = "classic-e21";
    seedRunning(id, dir);
    persistRiskState(id, {
      ...emptyRiskState(SCOPE),
      halted: true,
      haltStatus: "HALTED_FLAT",
      haltId: "halt-e21",
      haltReasons: ["ACTUAL_NOTIONAL_CAP"],
      leaseGeneration: "lease-1",
      acknowledged: false,
      updatedAt: "2026-08-24T00:00:00.000Z",
    }, dir);
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/experiment-reduction-restart-worker.ts", import.meta.url))], {
      env: { ...process.env, CLASSIC_RISK_ID: id, CLASSIC_RISK_DIR: dir, CLASSIC_RISK_SCOPE: SCOPE },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const replayed = lastJson(child.stdout);
    assert.equal(replayed.durableHaltId, "halt-e21");
    assert.equal(replayed.reseedAllowedFromDurable, false);
    persistRiskState(id, {
      ...loadRiskState(id, dir, SCOPE),
      haltId: "halt-e21-newer",
      haltStatus: "HALTED_UNFLAT",
      haltReasons: ["DAILY_LOSS"],
      updatedAt: "2026-08-24T00:00:01.000Z",
    }, dir);
    const newer = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/experiment-reduction-restart-worker.ts", import.meta.url))], {
      env: { ...process.env, CLASSIC_RISK_ID: id, CLASSIC_RISK_DIR: dir, CLASSIC_RISK_SCOPE: SCOPE },
      encoding: "utf8",
    });
    assert.equal(lastJson(newer.stdout).durableHaltId, "halt-e21-newer");
  });

  it("E-22 telemetry failure during normal operation", () => {
    const dir = tmpDir("e22");
    const tel = createExperimentTelemetry({
      experimentId: "classic-e22",
      mode: "dry-run",
      venue: "extended",
      symbol: "BTC",
      commitSha: "abc",
      baseDir: dir,
      manifestFields: {
        experiment_spec_version: "0.2.0",
        starting_capital_usd: 100,
        leverage: 5,
        max_margin_budget_usd: 30,
        max_planned_gross_notional_usd: 150,
        grid_half_band_pct: 3,
        grid_level_count: 10,
        daily_loss_limit_usd: 5,
        max_drawdown_usd: 10,
        boundary_buffer_pct: 1,
      },
    });
    fs.unlinkSync(tel.eventsPath);
    fs.mkdirSync(tel.eventsPath);
    assert.equal(tel.emit("SNAPSHOT", { mid: 100_000 }), false);
    const { decision, next } = evaluateExperimentRisk(riskInput(), V02_LIMITS, emptyRiskState(SCOPE));
    assert.equal(decision.halt, false);
    assert.equal(next.haltStatus, "RUNNING");
    assert.equal(experimentAllowsReseed(next), true);
  });

  it("E-23 telemetry failure during halt", async () => {
    const dir = tmpDir("e23");
    let position = 0.01;
    let orders = 1;
    const result = await runExperimentKillSwitch({
      ex: {
        async cancelAll() { orders = 0; },
        async closePosition() { position = 0; },
        async snapshot(market: string) {
          return {
            venue: "extended" as const,
            market,
            mid: 100_000,
            position,
            openOrders: orders ? [{ id: "x", market, side: "buy" as const, price: 1, size: 1, level: 1 }] : [],
          };
        },
      },
      market: "BTC",
      reasons: ["DAILY_LOSS"],
      experimentId: "classic-e23",
      baseDir: dir,
      retryDelayMs: 0,
      onEvent() { throw new Error("disk full"); },
    });
    assert.equal(result.status, "HALTED_FLAT");
    assert.ok(result.state.haltId);
    assert.equal(loadRiskState("classic-e23", dir).haltId, result.state.haltId);
    assert.equal(experimentAllowsReseed(result.state), false);
  });

  it("E-24 fatal uncaught exception", () => {
    const marker = path.join(tmpDir("e24"), "marker.txt");
    const child = spawnWorker({ CLASSIC_E_ACTION: "uncaught", CLASSIC_E_MARKER: marker });
    assert.notEqual(child.status, 0);
    assert.match(String(child.stderr || child.stdout), /E24_UNCAUGHT/);
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "not-placed");
    const opened = spawnWorker({
      CLASSIC_E_ACTION: "session-open",
      CLASSIC_E_EXPERIMENT_ID: "classic-e24",
      CLASSIC_E_BASE_DIR: tmpDir("e24-open"),
    });
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(lastJson(opened.stdout).allowsTrading, true);
  });

  it("E-25 fatal unhandled rejection", () => {
    const marker = path.join(tmpDir("e25"), "marker.txt");
    const child = spawnWorker({ CLASSIC_E_ACTION: "rejection", CLASSIC_E_MARKER: marker });
    assert.notEqual(child.status, 0);
    assert.match(String(child.stderr || child.stdout), /E25_UNHANDLED/);
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "not-placed");
    const dir = tmpDir("e25-session");
    const opened = spawnWorker({
      CLASSIC_E_ACTION: "session-open",
      CLASSIC_E_EXPERIMENT_ID: "classic-e25",
      CLASSIC_E_BASE_DIR: dir,
    });
    assert.equal(lastJson(opened.stdout).allowsTrading, true);
    const resumed = spawnWorker({
      CLASSIC_E_ACTION: "session-resume",
      CLASSIC_E_EXPERIMENT_ID: "classic-e25",
      CLASSIC_E_BASE_DIR: dir,
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const again = lastJson(resumed.stdout);
    assert.equal(again.allowsTrading, false);
    assert.match(String(again.reasonCode), /RECONCILIATION_REQUIRED/);
  });

  it("E-26 evidence results are derived from TAP outcomes", () => {
    const tap = renderCheckpointETap({
      cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id, title: `${id} fixture` })),
    });
    const parsed = parseCheckpointETap(tap);
    assert.equal(parsed.cases.length, 30);
    assert.deepEqual(parsed.cases.map((row) => row.caseId), [...CHECKPOINT_E_CASE_IDS]);
    assert.equal(parsed.cases[0]!.outcome, "PASS");
    assert.equal(parsed.cases[25]!.caseId, "E-26");
    assert.equal(parsed.cases[25]!.outcome, "PASS");
    const fixtureSha = "0123456789abcdef0123456789abcdef01234567";
    const fixtureTree = "89abcdef0123456789abcdef0123456789abcdef";
    const evidence = generateEvidenceFromRun({
      checkpointTap: tap,
      projectTap: renderProjectTap({ tests: MIN_PROJECT_SUITE_TOTAL, pass: MIN_PROJECT_SUITE_TOTAL }),
      meta: {
        branch: "experiment/classic-v0.2-100u-safety",
        identity: {
          sourceHeadSha: fixtureSha,
          sourceHeadTreeSha: fixtureTree,
          testedCheckoutSha: fixtureSha,
          testedCheckoutTreeSha: fixtureTree,
          baseSha: "fedcba9876543210fedcba9876543210fedcba98",
          githubEventName: "local",
          githubRunId: "local",
          githubRunAttempt: "0",
          githubJobId: "local",
        },
        toolchain: { nodeVersion: process.version, npmVersion: "10.9.8" },
        checkpoint: { command: DEFAULT_EVIDENCE_COMMAND, processExitCode: 0 },
        project: {
          command: defaultProjectTapCommand(),
          processExitCode: 0,
          preCheck: { command: DEFAULT_PRECHECK_COMMAND, processExitCode: 0 },
        },
        generatedAt: "2026-08-24T00:00:00.000Z",
        fileHashes: collectFileHashes(),
      },
    });
    assert.equal(evidence.checkpointSuite.testCases[25]!.caseId, "E-26");
    assert.equal(evidence.checkpointSuite.testCases[25]!.result, parsed.cases[25]!.outcome);
    assert.equal(evidence.checkpointSuite.pass, 30);
    assert.equal(evidence.checkpointSuite.fail, 0);
    assert.notEqual(evidence.projectSuite.total, 30);
    assert.equal(evidence.safety.liveExchangeWrite, false);
    const failedTap = renderCheckpointETap({
      cases: CHECKPOINT_E_CASE_IDS.map((id) => ({ id, ok: id !== "E-26", title: `${id} fixture` })),
    });
    const failedParsed = parseCheckpointETap(failedTap);
    assert.equal(failedParsed.cases[25]!.outcome, "FAIL");
    let failedCode: string | null = null;
    try {
      generateEvidenceFromRun({
        checkpointTap: failedTap,
        projectTap: renderProjectTap({ tests: MIN_PROJECT_SUITE_TOTAL, pass: MIN_PROJECT_SUITE_TOTAL }),
        meta: {
          branch: "experiment/classic-v0.2-100u-safety",
          identity: {
            sourceHeadSha: fixtureSha,
            sourceHeadTreeSha: fixtureTree,
            testedCheckoutSha: fixtureSha,
            testedCheckoutTreeSha: fixtureTree,
            baseSha: "fedcba9876543210fedcba9876543210fedcba98",
            githubEventName: "local",
            githubRunId: "local",
            githubRunAttempt: "0",
            githubJobId: "local",
          },
          toolchain: { nodeVersion: process.version, npmVersion: "10.9.8" },
          checkpoint: { command: DEFAULT_EVIDENCE_COMMAND, processExitCode: 1 },
          project: {
            command: defaultProjectTapCommand(),
            processExitCode: 0,
            preCheck: { command: DEFAULT_PRECHECK_COMMAND, processExitCode: 0 },
          },
          fileHashes: collectFileHashes(),
        },
      });
    } catch (error) {
      if (error instanceof EvidenceError) failedCode = error.code;
      else throw error;
    }
    assert.equal(failedCode, "CASE_FAILED");
  });

  it("E-27 no secrets", () => {
    const dir = tmpDir("e27");
    const tel = createExperimentTelemetry({
      experimentId: "classic-e27",
      mode: "dry-run",
      venue: "extended",
      symbol: "BTC",
      commitSha: "abc123deadbeefabc123deadbeefabc123deadbe",
      baseDir: dir,
      manifestFields: {
        experiment_spec_version: "0.2.0",
        starting_capital_usd: 100,
        leverage: 5,
        max_margin_budget_usd: 30,
        max_planned_gross_notional_usd: 150,
        grid_half_band_pct: 3,
        grid_level_count: 10,
        daily_loss_limit_usd: 5,
        max_drawdown_usd: 10,
        boundary_buffer_pct: 1,
      },
    });
    tel.emit("ERROR", {
      error_message: "api_key=SUPER_SECRET private_key=KEEP_OUT API_SECRET=nope",
    } as never);
    const dumped = JSON.stringify(tel.manifest) + fs.readFileSync(tel.eventsPath, "utf8");
    assert.doesNotMatch(dumped, /SUPER_SECRET|KEEP_OUT|API_SECRET=nope/);
    assert.match(dumped, /diagnostic omitted/);
    assert.doesNotMatch(HERE, /LIVE_CONFIRM=YES|API_SECRET|PRIVATE_KEY/);
  });

  it("E-28 prior-suite registration and source-integrity check", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const testScript = String(pkg.scripts.test);
    const registered = [
      "test/grid.test.ts",
      "test/experiment-v02-config.test.ts",
      "test/experiment-v02-reduction.test.ts",
      "test/experiment-v02-execution.test.ts",
      "test/experiment-v02-planner-dedup.test.ts",
      "test/experiment-v02-planner-dedup-corrective-1.test.ts",
      "test/experiment-v02-checkpoint-e.test.ts",
      "test/experiment-v02-checkpoint-e-evidence.test.ts",
    ];
    for (const file of registered) {
      assert.ok(testScript.includes(file), file);
    }
    const sources = [
      fs.readFileSync(new URL("./experiment-v02-execution.test.ts", import.meta.url), "utf8"),
      fs.readFileSync(new URL("./experiment-v02-planner-dedup.test.ts", import.meta.url), "utf8"),
      fs.readFileSync(new URL("./experiment-v02-planner-dedup-corrective-1.test.ts", import.meta.url), "utf8"),
      fs.readFileSync(new URL("./experiment-v02-checkpoint-e.test.ts", import.meta.url), "utf8"),
      fs.readFileSync(new URL("./experiment-v02-checkpoint-e-evidence.test.ts", import.meta.url), "utf8"),
    ];
    const joined = sources.join("\n");
    assert.doesNotMatch(joined, /\bit\.skip\s*\(/);
    assert.doesNotMatch(joined, /\bit\.todo\s*\(/);
    assert.doesNotMatch(joined, /\bdescribe\.skip\s*\(/);
    const execution = sources[0]!;
    for (const name of ["C-C18", "C-C19", "C-C20", "C-C21"]) {
      assert.match(execution, new RegExp(`it\\("${name} `));
    }
    const prior = sources[1]!;
    for (let i = 1; i <= 21; i++) {
      assert.match(prior, new RegExp(`it\\("D-${String(i).padStart(2, "0")} `));
    }
    const corrective = sources[2]!;
    for (let i = 1; i <= 12; i++) {
      assert.match(corrective, new RegExp(`it\\("D-C1-${String(i).padStart(2, "0")} `));
    }
  });

  it("E-29 dependency audit inventory unchanged", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.version, "0.2.0");
    assert.equal(pkg.dependencies.tsx, "^4.19.2");
    assert.equal(pkg.dependencies.undici, "^6.21.0");
    assert.equal(pkg.devDependencies.typescript, "^5.7.2");
    const lock = fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");
    assert.ok(lock.includes("\"name\": \"classic-grid-master\""));
  });

  it("E-30 engineering-ready remains not live-authorized", () => {
    withEnv(
      {
        EXPERIMENT_MODE: "1",
        EXPERIMENT_SPEC_VERSION: "0.2.0",
        DRY_RUN: "0",
        LIVE_CONFIRM: "YES",
        VENUES: "extended",
        MARKETS: "BTC",
        EXPERIMENT_ID: "classic-v02-dryrun",
      },
      () => {
        assert.throws(() => assertLiveAllowed(loadRuntimeConfig()), /EXPERIMENT_V02_LIVE_FORBIDDEN|尚未授权 live/);
      }
    );
    withEnv(
      { EXPERIMENT_MODE: "1", EXPERIMENT_SPEC_VERSION: "0.3.0" },
      () => assert.throws(() => parseExperimentConfig(), /EXPERIMENT_SPEC_VERSION_UNSUPPORTED/)
    );
    const docs = [
      fs.readFileSync(new URL("../docs/classic-v0.2-implementation-contract.md", import.meta.url), "utf8"),
      fs.readFileSync(new URL("../docs/classic-v0.2-checkpoint-d-corrective-1.md", import.meta.url), "utf8"),
    ].join("\n");
    assert.doesNotMatch(docs, /LIVE_EXCHANGE_WRITE_AUTHORIZED=YES/);
    assert.match(docs, /LIVE_EXCHANGE_WRITE_AUTHORIZED=NO/);
  });
});
