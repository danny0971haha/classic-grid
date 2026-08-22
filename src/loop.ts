import {
  anchorGrid,
  assertLiveAllowed,
  formatExperimentBanner,
  gridFor,
  loadRuntimeConfig,
  type RuntimeConfig,
} from "./config.js";
import { runExperimentKillSwitch } from "./experimentKillSwitch.js";
import {
  acknowledgeHaltIfRequested,
  combineDailyPnl,
  emptyRiskState,
  evaluateExperimentRisk,
  filterRiskIncreasingIntents,
  isForcedHaltInMemoryOnly,
  latchForcedHaltInMemory,
  worstCaseGrossNotionalUsd,
  experimentDir,
  loadRiskState,
  persistRiskState,
  type ExperimentRiskState,
} from "./experimentRisk.js";
import {
  createExperimentTelemetry,
  type ExperimentEventName,
} from "./experimentTelemetry.js";
import { loadSoftResumeAnchors, persistSoftResumeAnchor } from "./softResume.js";
import {
  acquireRuntimeLease,
  startRuntimeLeaseHeartbeat,
  type RuntimeLease,
  type RuntimeLeaseHeartbeat,
} from "./runtimeLease.js";
import {
  setDashboardMeta,
  setDashboardOfficial,
  startDashboardServer,
  upsertDashboardVenue,
  getDashboardSnapshot,
} from "./dashboard.js";
import { isBotPaused, loadBotPauseState } from "./botControl.js";
import {
  assertFeeOk,
  assertMarginOk,
  buildGrid,
  computeRisk,
  planFromFillsAndSeed,
  type BuiltGrid,
} from "./grid.js";
import { loadVenueSessionCounters } from "./ledger.js";
import { getOfficialCache, refreshOfficialStats } from "./officialStats.js";
import { createExecutor, type VenueExecutor } from "./venues/index.js";
import type { GridParams, Side, VenueId, VenueSnapshot } from "./types.js";
import {
  classifyTrade,
  tgBoot,
  tgClose,
  tgDailyOverview,
  tgError,
  isSoftPlaceError,
  tgOpen,
} from "./telegram.js";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function emitExp(event: ExperimentEventName, fields: Record<string, unknown> = {}): void {
  try { experimentTelemetry?.emit(event, fields as never); }
  catch { /* telemetry is deliberately outside the trading control path */ }
}

async function applyExperimentGuards(p: {
  rt: VenueRuntime;
  market: string;
  cfg: RuntimeConfig;
  snap: VenueSnapshot;
}): Promise<"halt" | "reduce" | "ok"> {
  const { rt, market, cfg, snap } = p;
  const g = rt.params;
  if (!cfg.experiment.enabled || !g) return "ok";
  const off = getOfficialCache()?.venues?.[rt.ex.id];
  const planned = worstCaseGrossNotionalUsd({
    positionQty: snap.position,
    mid: snap.mid,
    openOrders: snap.openOrders,
  });
  const pnlUpdatedAt = off?.updatedAt ? Date.parse(off.updatedAt) : Number.NaN;
  const snapUpdatedAt = snap.observedAt ? Date.parse(snap.observedAt) : Date.now();
  const { decision, next } = evaluateExperimentRisk(
    {
      mid: snap.mid,
      equityUsd: snap.equityUsd ?? null,
      dailyPnlUsd: combineDailyPnl({
        realizedPnlUsd: off?.realizedPnl,
        feesUsd: off?.fees,
      }),
      positionQty: snap.position,
      positionNotionalUsd: Math.abs(snap.position) * snap.mid,
      plannedGrossNotionalUsd: planned,
      gridLower: g.lower,
      gridUpper: g.upper,
      requireFreshInputs: !cfg.dryRun,
      snapshotAgeMs: Number.isFinite(snapUpdatedAt) ? Date.now() - snapUpdatedAt : null,
      pnlAgeMs: Number.isFinite(pnlUpdatedAt) ? Date.now() - pnlUpdatedAt : null,
    },
    {
      maxGrossNotionalUsd: cfg.experiment.maxGrossNotionalUsd,
      dailyLossUsd: cfg.experiment.dailyLossUsd,
      maxDrawdownUsd: cfg.experiment.maxDrawdownUsd,
      boundaryBufferPct: cfg.experiment.boundaryBufferPct,
    },
    experimentRiskState
  );
  experimentRiskState = next;
  let persistenceFailed = isForcedHaltInMemoryOnly(cfg.experiment.id);
  if (persistenceFailed && !experimentRiskState.halted) {
    experimentRiskState = latchForcedHaltInMemory(cfg.experiment.id, experimentRiskState, "FORCED_HALT_IN_MEMORY_ONLY");
  }
  try {
    if (!persistenceFailed) persistRiskState(cfg.experiment.id, experimentRiskState);
  } catch (error: any) {
    persistenceFailed = true;
    experimentRiskState = latchForcedHaltInMemory(cfg.experiment.id, experimentRiskState, "RISK_STATE_PERSIST_FAILED");
    console.error(`[experiment] risk-state persist failed: ${String(error?.message || error).slice(0, 160)}`);
  }
  emitExp("SNAPSHOT", {
    venue: rt.ex.id,
    symbol: market,
    mid: snap.mid,
    anchor: rt.anchorMid,
    grid_lower: g.lower,
    grid_upper: g.upper,
    leverage: g.leverage,
    position_qty: snap.position,
    position_notional_usd: Math.abs(snap.position) * snap.mid,
    planned_gross_notional_usd: planned,
    equity_usd: snap.equityUsd ?? null,
    open_order_count: snap.openOrders.length,
    unrealized_pnl_usd: snap.unrealizedPnl ?? null,
    realized_pnl_usd: off?.realizedPnl ?? null,
    fee_usd: off?.fees ?? null,
    risk_flags: decision.reasons,
    restart_count: experimentRestartCount,
  });
  if (decision.halt || persistenceFailed) {
    const haltReasons = persistenceFailed
      ? Array.from(new Set([...decision.reasons, "RISK_STATE_PERSIST_FAILED"]))
      : decision.reasons;
    console.warn(
      `[${rt.ex.id}] RISK HALT ${haltReasons.join(",")} — cancelAll → closePosition`
    );
    const kill = await runExperimentKillSwitch({
      ex: {
        cancelAll: async (killMarket) => {
          assertExperimentLeaseCurrent(cfg);
          await rt.ex.cancelAll(killMarket);
        },
        closePosition: async (killMarket) => {
          assertExperimentLeaseCurrent(cfg);
          await rt.ex.closePosition(killMarket);
        },
        snapshot: (killMarket) => rt.ex.snapshot(killMarket),
      },
      market,
      reasons: haltReasons,
      experimentId: cfg.experiment.id,
      scopeKey: experimentScopeKey,
      onEvent: (event, fields) => emitExp(event, { venue: rt.ex.id, ...fields }),
    });
    experimentRiskState = kill.state;
    return "halt";
  }
  if (decision.reduceOnly) return "reduce";
  return "ok";
}

/** 读侧瞬时网络/SDK 抖动：不标面板异常、不刷仓位归零 */
function isTransientReadError(msg: string): boolean {
  return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|UND_ERR|internal assertion violation|network|getaddrinfo|429|Too Many|rate.?limit/i.test(
    msg
  );
}

let softResumeAnchors: Partial<
  Record<VenueId, { anchorMid: number; gridCount: number; anchorEpoch: number }>
> = {};
let experimentTelemetry: ReturnType<typeof createExperimentTelemetry> | null = null;
let experimentRiskState: ExperimentRiskState = emptyRiskState();
let experimentRestartCount = 0;
let experimentScopeKey = "";
let experimentLease: RuntimeLease | null = null;
let experimentOwnershipPrefix = "";

function assertExperimentLeaseCurrent(cfg: RuntimeConfig): void {
  if (!cfg.experiment.enabled) return;
  if (!experimentLease) throw new Error("RUNTIME_LEASE_MISSING");
  experimentLease.assertCurrent();
}

type Tracked = { levelIndex: number; side: Side; price: number; size: number };

type VenueRuntime = {
  ex: VenueExecutor;
  seeded: boolean;
  active: Map<string, Tracked>;
  completedRungs: number;
  gridProfit: number;
  built: BuiltGrid | null;
  params: GridParams | null;
  anchorMid: number;
  anchorEpoch: number;
  lastError?: string;
  /** 本地 inventory：上一次仓位与成本名义 */
  lastPosition: number | null;
  invCost: number;
  unrealizedPnl: number;
};

async function verifyLiveExperimentExecutor(
  rt: VenueRuntime,
  cfg: RuntimeConfig
): Promise<void> {
  if (!cfg.experiment.enabled || cfg.dryRun) return;
  const caps = rt.ex.experimentCapabilities;
  if (!caps?.deterministicClientOrderId || !caps.leverageReadback || !rt.ex.verifyExperimentPreflight) {
    throw new Error(`[${rt.ex.id}] venue lacks experiment ownership/leverage safety capabilities`);
  }
  assertExperimentLeaseCurrent(cfg);
  const market = cfg.markets[0]!;
  await rt.ex.verifyExperimentPreflight(market, cfg.experiment.leverage);
  const recovery = await rt.ex.snapshot(market);
  if (recovery.openOrders.length && !softResumeAnchors[rt.ex.id]) {
    throw new Error(`[${rt.ex.id}] open orders exist but no valid recovery checkpoint was loaded`);
  }
  const unowned = recovery.openOrders.filter(
    (o) => !String(o.clientOrderId || "").startsWith(experimentOwnershipPrefix)
  );
  if (unowned.length) {
    throw new Error(`[${rt.ex.id}] reconciliation found ${unowned.length} unowned open orders`);
  }
}

/** 用 mid 变动维护本地均价，估浮盈亏（所方无 entry 时兜底） */
function syncInventory(rt: VenueRuntime, position: number, mid: number): number {
  if (!(mid > 0)) {
    rt.unrealizedPnl = 0;
    return 0;
  }
  if (rt.lastPosition == null) {
    rt.lastPosition = position;
    rt.invCost = position * mid;
    rt.unrealizedPnl = 0;
    return 0;
  }
  const prev = rt.lastPosition;
  const d = position - prev;
  if (Math.abs(d) > 1e-12) {
    if (prev === 0) {
      rt.invCost = position * mid;
    } else if (Math.sign(position) !== Math.sign(prev) && Math.abs(position) > 1e-12) {
      // 翻向：剩余新方向按现价建仓
      rt.invCost = position * mid;
    } else if (Math.abs(position) > Math.abs(prev) + 1e-12) {
      // 加仓
      rt.invCost += d * mid;
    } else {
      // 减仓：保留均价
      const avg = prev !== 0 ? rt.invCost / prev : mid;
      rt.invCost = position * avg;
    }
  }
  rt.lastPosition = position;
  rt.unrealizedPnl = position * mid - rt.invCost;
  if (Math.abs(position) < 1e-12) {
    rt.invCost = 0;
    rt.unrealizedPnl = 0;
  }
  return rt.unrealizedPnl;
}

async function ensureAnchored(
  rt: VenueRuntime,
  market: string,
  cfg: RuntimeConfig,
  midHint?: number
): Promise<{ mid: number; snap: Awaited<ReturnType<VenueExecutor["snapshot"]>> }> {
  const snap = await rt.ex.snapshot(market);
  const mid = midHint && midHint > 0 ? midHint : snap.mid;
  if (rt.built && rt.params) return { mid: snap.mid, snap };

  const base = gridFor(cfg, rt.ex.id);
  const resume = softResumeAnchors[rt.ex.id];
  const midForAnchor =
    resume && resume.anchorMid > 0 ? resume.anchorMid : mid;
  if (resume && resume.anchorMid > 0 && Math.abs(midForAnchor - mid) > 1) {
    console.log(
      `[${rt.ex.id}] soft-resume anchorMid=${midForAnchor.toFixed(2)} (live mid=${mid.toFixed(2)})`
    );
  }
  const anchored = anchorGrid(base, midForAnchor);
  const built = buildGrid({
    lower: anchored.lower,
    upper: anchored.upper,
    gridCount: anchored.gridCount,
  });
  const risk = computeRisk(built, anchored, midForAnchor);
  const fee = assertFeeOk(risk.spacingPct, anchored.feeRate);
  const margin = assertMarginOk(risk, anchored.equityUsd, anchored.marginFraction);
  const eachSide = anchored.gridCount / 2;
  console.log(
    `[${rt.ex.id}] anchor mid=${midForAnchor.toFixed(2)} → [${anchored.lower.toFixed(2)},${anchored.upper.toFixed(2)}] ≈上下各${eachSide} 共${anchored.gridCount} spacing=${built.spacing} size=${anchored.sizeBase} lev=${anchored.leverage}x`
  );
  console.log(
    `[${rt.ex.id}] risk notional≈${risk.notional}U margin≈${risk.requiredMargin}U perRung≈${risk.perRungProfit}U spacing=${risk.spacingPct}%`
  );
  console.log(`[${rt.ex.id}] fee: ${fee.message}`);
  console.log(`[${rt.ex.id}] margin: ${margin.message}`);
  if (!fee.ok) throw new Error(`[${rt.ex.id}] ${fee.message}`);
  if (!margin.ok) throw new Error(`[${rt.ex.id}] ${margin.message}`);
  if (
    cfg.experiment.enabled &&
    risk.notional > cfg.experiment.maxGrossNotionalUsd + 1e-6
  ) {
    throw new Error(
      `[${rt.ex.id}] planned notional ${risk.notional}U > ${cfg.experiment.maxGrossNotionalUsd}U`
    );
  }

  rt.built = built;
  rt.params = anchored;
  rt.anchorMid = midForAnchor;
  rt.anchorEpoch = resume?.anchorEpoch || Date.now();
  // 软启：有旧锚点则视为已铺过，只补漏档、不整表重铺
  if (resume && resume.anchorMid > 0) {
    rt.seeded = true;
  }
  cfg.grids[rt.ex.id] = anchored;
  if (cfg.experiment.enabled && experimentLease) {
    experimentLease.assertCurrent();
    persistSoftResumeAnchor({
      experimentId: cfg.experiment.id,
      scopeKey: experimentScopeKey,
      leaseGeneration: String(experimentLease.generation),
      venue: rt.ex.id,
      anchor: { anchorMid: midForAnchor, gridCount: anchored.gridCount, anchorEpoch: rt.anchorEpoch },
    });
  }
  return { mid: snap.mid, snap };
}

async function tickOne(
  rt: VenueRuntime,
  market: string,
  cfg: RuntimeConfig
): Promise<void> {
  assertExperimentLeaseCurrent(cfg);
  // Pause suppresses strategy writes, but hard-risk evaluation and kill remain active.
  if (isBotPaused()) {
    if (!rt.params || !rt.built) {
      try {
        await ensureAnchored(rt, market, cfg);
      } catch (e: any) {
        console.warn(
          `[${rt.ex.id}] PAUSED ensureAnchored: ${String(e?.message || e).slice(0, 120)}`
        );
      }
    }
    const snap = await rt.ex.snapshot(market);
    const pausedGuard = await applyExperimentGuards({ rt, market, cfg, snap });
    if (pausedGuard === "halt") return;
    syncInventory(rt, snap.position, snap.mid);
    const upnlOfficial =
      snap.unrealizedPnl != null && Number.isFinite(Number(snap.unrealizedPnl))
        ? Number(snap.unrealizedPnl)
        : null;
    rt.unrealizedPnl = upnlOfficial ?? 0;
    const g = rt.params;
    const built = rt.built;
    const off = getOfficialCache()?.venues?.[rt.ex.id];
    upsertDashboardVenue({
      venue: rt.ex.id,
      market,
      mid: snap.mid,
      anchorMid: rt.anchorMid || 0,
      lower: g?.lower || 0,
      upper: g?.upper || 0,
      spacing: built?.spacing || 0,
      sizeBase: g?.sizeBase || 0,
      gridCount: g?.gridCount || gridFor(cfg, rt.ex.id).gridCount,
      position: snap.position,
      openOrders: snap.openOrders.length,
      seeded: rt.seeded,
      completedRungs: rt.completedRungs,
      gridProfit: Number(rt.gridProfit.toFixed(4)),
      unrealizedPnl:
        upnlOfficial != null ? Number(upnlOfficial.toFixed(4)) : undefined,
      equityUsd:
        snap.equityUsd != null && Number.isFinite(snap.equityUsd)
          ? Number(snap.equityUsd.toFixed(4))
          : undefined,
      orders: snap.openOrders.slice(0, 120).map((o) => ({
        side: o.side,
        price: Number(o.price),
      })),
      officialVolume: off?.source === "official" ? off.volume : null,
      officialFees: off?.source === "official" ? off.fees : null,
      officialRealizedPnl: off?.source === "official" ? off.realizedPnl : null,
      officialSource: off?.source === "official" ? "official" : "local",
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    });
    console.log(
      `[${rt.ex.id}] PAUSED mid=${snap.mid.toFixed(2)} pos=${snap.position} oo=${snap.openOrders.length}`
    );
    return;
  }

  const { mid, snap } = await ensureAnchored(rt, market, cfg);
  const g = rt.params!;
  const built = rt.built!;
  const posBefore = rt.lastPosition ?? snap.position;
  // 仅维护仓位变化跟踪（开平仓 TG）；浮盈亏看板一律用所方官方字段
  syncInventory(rt, snap.position, snap.mid);
  const upnlOfficial =
    snap.unrealizedPnl != null && Number.isFinite(Number(snap.unrealizedPnl))
      ? Number(snap.unrealizedPnl)
      : null;
  rt.unrealizedPnl = upnlOfficial ?? 0;
  const guard = await applyExperimentGuards({ rt, market, cfg, snap });
  if (guard === "halt") {
    const offHalt = getOfficialCache()?.venues?.[rt.ex.id];
    upsertDashboardVenue({
      venue: rt.ex.id,
      market,
      mid: snap.mid,
      anchorMid: rt.anchorMid,
      lower: g.lower,
      upper: g.upper,
      spacing: built.spacing,
      sizeBase: g.sizeBase,
      gridCount: g.gridCount,
      position: snap.position,
      openOrders: snap.openOrders.length,
      seeded: rt.seeded,
      completedRungs: rt.completedRungs,
      gridProfit: Number(rt.gridProfit.toFixed(4)),
      unrealizedPnl:
        upnlOfficial != null ? Number(upnlOfficial.toFixed(4)) : undefined,
      equityUsd:
        snap.equityUsd != null && Number.isFinite(snap.equityUsd)
          ? Number(snap.equityUsd.toFixed(4))
          : undefined,
      officialVolume: offHalt?.source === "official" ? offHalt.volume : null,
      officialFees: offHalt?.source === "official" ? offHalt.fees : null,
      officialRealizedPnl: offHalt?.source === "official" ? offHalt.realizedPnl : null,
      officialSource: offHalt?.source === "official" ? "official" : "local",
      lastError: `HALTED ${experimentRiskState.haltReasons.join(",")}`,
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  const plan = planFromFillsAndSeed({
    market,
    mid,
    levels: built.levels,
    spacing: built.spacing,
    mode: g.mode,
    sizeBase: g.sizeBase,
    openOrders: snap.openOrders,
    prevActive: rt.active,
    maxWrites: g.maxWritesPerTick,
    seeded: rt.seeded,
    maxOpenOrders: g.maxOpenOrders,
    skipBand: g.skipBand,
    ownershipPrefix: cfg.experiment.enabled ? experimentOwnershipPrefix : undefined,
    anchorEpoch: rt.anchorEpoch,
  });
  if (cfg.experiment.enabled) {
    const worstAfterBatch = worstCaseGrossNotionalUsd({
      positionQty: snap.position,
      mid: snap.mid,
      openOrders: snap.openOrders,
      intents: plan.intents,
    });
    if (worstAfterBatch > cfg.experiment.maxGrossNotionalUsd + 1e-9) {
      plan.intents = filterRiskIncreasingIntents(plan.intents, {
        halt: false,
        reduceOnly: true,
        reasons: ["POST_BATCH_NOTIONAL_CAP"],
      });
      for (const order of snap.openOrders) {
        if (plan.intents.length >= g.maxWritesPerTick) break;
        if (!String(order.clientOrderId || "").startsWith(experimentOwnershipPrefix)) continue;
        if (!plan.intents.some((i) => i.type === "cancel" && i.orderId === order.id)) {
          plan.intents.push({ type: "cancel", orderId: order.id, market });
        }
      }
    }
  }
  if (guard === "reduce") {
    plan.intents = filterRiskIncreasingIntents(plan.intents, {
      halt: false,
      reduceOnly: true,
      reasons: ["ACTUAL_NOTIONAL_CAP"],
    });
  }

  // TG / 完成格：按交易所真实仓位变化，不按「挂单 ID 消失」推断（撤补会误报吃格）
  {
    const size = g.sizeBase;
    const perRung = built.spacing * size;
    const posNow = snap.position;
    const thresh = size * 0.35;
    if (size > 0 && Number.isFinite(posBefore) && Math.abs(posNow - posBefore) >= thresh) {
      let sim = posBefore;
      for (let step = 0; step < 40 && Math.abs(posNow - sim) >= thresh; step++) {
        const side: Side = posNow > sim ? "buy" : "sell";
        const { kind, posAfter } = classifyTrade(sim, side, size);
        if (side === "buy" && posAfter > posNow + size * 0.1) break;
        if (side === "sell" && posAfter < posNow - size * 0.1) break;
        sim = posAfter;
        const displayPos = Math.abs(posNow - sim) < thresh ? posNow : sim;
        if (kind === "开多" || kind === "开空") {
          void tgOpen({
            venue: rt.ex.id,
            kind,
            posAfter: displayPos,
            mid: snap.mid,
            fillBase: size,
            openOrders: snap.openOrders,
          });
        } else {
          rt.completedRungs += 1;
          rt.gridProfit += perRung;
          void tgClose({
            venue: rt.ex.id,
            kind,
            posAfter: displayPos,
            mid: snap.mid,
            fillBase: size,
            openOrders: snap.openOrders,
            pnlUsd: perRung,
          });
        }
      }
    }
  }

  console.log(
    `[${rt.ex.id}] mid=${snap.mid.toFixed(2)} pos=${snap.position} oo=${snap.openOrders.length} count=${g.gridCount} spacing=${built.spacing} size=${g.sizeBase} fills=${plan.filled.length} intents=${plan.intents.length} rungs=${rt.completedRungs} profit≈${rt.gridProfit.toFixed(4)} upnl≈${upnlOfficial != null ? upnlOfficial.toFixed(4) : "n/a"}`
  );

  let applyErr: string | undefined;
  let applyReliable = true;
  if (plan.intents.length) {
    for (const intent of plan.intents) {
      if (intent.type === "place") {
        emitExp("ORDER_SUBMIT", {
          venue: rt.ex.id,
          symbol: market,
          side: intent.order.side,
          order_price: intent.order.price,
          order_qty: intent.order.size,
          grid_level: intent.order.level,
          client_order_id: intent.order.clientOrderId,
          intent_id: intent.order.clientOrderId,
          anchor_epoch: rt.anchorEpoch,
        });
      } else {
        emitExp("CANCEL", {
          venue: rt.ex.id,
          symbol: market,
          order_id: intent.orderId,
        });
      }
    }
    assertExperimentLeaseCurrent(cfg);
    const result = await rt.ex.apply(plan.intents);
    if (result.placed) {
      emitExp("ORDER_ACK", {
        venue: rt.ex.id,
        symbol: market,
        open_order_count: snap.openOrders.length + result.placed - result.cancelled,
      });
    }
    if (result.failed || result.errors.length || result.ambiguous) {
      applyReliable = false;
      console.log(
        `[${rt.ex.id}] apply placed=${result.placed} cancelled=${result.cancelled} failed=${result.failed} ${result.errors.join("; ")}`
      );
      const raw =
        result.errors.slice(0, 2).join("; ") || `failed=${result.failed}`;
      void tgError(rt.ex.id, raw);
      // 穿价/post-only 类：不提醒也不挂看板红字（下轮会重试）
      if (!isSoftPlaceError(rt.ex.id, raw)) applyErr = raw;
      emitExp("ERROR", {
        venue: rt.ex.id,
        symbol: market,
        error_message: raw,
        error_code: "APPLY_FAILED",
      });
    }
    if (result.failed || result.errors.length || result.ambiguous) {
      // Do not advance local intent state after a partial/ambiguous apply. A fresh
      // exchange read is required before the next planner pass.
      try { await rt.ex.snapshot(market); } catch { /* next tick remains unseeded */ }
    }
  }
  for (const f of plan.filled) {
    emitExp("FILL", {
      venue: rt.ex.id,
      symbol: market,
      side: f.side,
      order_price: f.price,
      grid_level: f.levelIndex,
    });
  }

  if (applyReliable) {
    rt.active = plan.nextActive;
    rt.seeded = true;
  }
  rt.lastError = applyErr;

  const off = getOfficialCache()?.venues?.[rt.ex.id];
  upsertDashboardVenue({
    venue: rt.ex.id,
    market,
    mid: snap.mid,
    anchorMid: rt.anchorMid,
    lower: g.lower,
    upper: g.upper,
    spacing: built.spacing,
    sizeBase: g.sizeBase,
    gridCount: g.gridCount,
    position: snap.position,
    openOrders: snap.openOrders.length,
    seeded: rt.seeded,
    completedRungs: rt.completedRungs,
    gridProfit: Number(rt.gridProfit.toFixed(4)),
    unrealizedPnl:
      upnlOfficial != null ? Number(upnlOfficial.toFixed(4)) : undefined,
    equityUsd:
      snap.equityUsd != null && Number.isFinite(snap.equityUsd)
        ? Number(snap.equityUsd.toFixed(4))
        : undefined,
    orders: snap.openOrders.slice(0, 120).map((o) => ({
      side: o.side,
      price: Number(o.price),
    })),
    officialVolume: off?.source === "official" ? off.volume : null,
    officialFees: off?.source === "official" ? off.fees : null,
    officialRealizedPnl: off?.source === "official" ? off.realizedPnl : null,
    officialSource: off?.source === "official" ? "official" : "local",
    lastError: applyErr,
    updatedAt: new Date().toISOString(),
  });
}

export type RunLoopLifecycleFaultPoint =
  | "BEFORE_TELEMETRY"
  | "BEFORE_RISK_LOAD"
  | "AFTER_CHECKPOINT"
  | "BEFORE_EXECUTOR_CREATE"
  | "BEFORE_CONNECT"
  | "BEFORE_OFFICIAL_REFRESH";

export async function runLoop(opts?: {
  once?: boolean;
  /** Offline fault-injection seam. It can only force a fail-closed startup error. */
  lifecycleFaultAt?: RunLoopLifecycleFaultPoint;
}): Promise<void> {
  const cfg = loadRuntimeConfig();
  assertLiveAllowed(cfg);
  const accountScope = String(process.env.EXPERIMENT_ACCOUNT_SCOPE || (cfg.dryRun ? "dry-run" : "")).trim();
  experimentScopeKey = `${accountScope}:${cfg.venues.join("+")}:${cfg.markets.join("+")}`;
  experimentOwnershipPrefix = `cg:${cfg.experiment.id}:`;
  const abortController = new AbortController();
  let leaseHeartbeat: RuntimeLeaseHeartbeat | null = null;
  let leaseLossError: unknown = null;
  let dash: ReturnType<typeof startDashboardServer> | null = null;
  const runtimes: VenueRuntime[] = [];
  const requestStop = () => abortController.abort();
  const injectLifecycleFault = (point: RunLoopLifecycleFaultPoint) => {
    if (opts?.lifecycleFaultAt === point) throw new Error(`INJECTED_LIFECYCLE_FAULT:${point}`);
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
  if (cfg.experiment.enabled) {
    if (process.env.SOFT_RESUME == null || String(process.env.SOFT_RESUME).trim() === "") {
      process.env.SOFT_RESUME = "1";
    }
    console.log(formatExperimentBanner(cfg));
    experimentLease = await acquireRuntimeLease({
      experimentDir: experimentDir(cfg.experiment.id),
      experimentId: cfg.experiment.id,
      scopeKey: experimentScopeKey,
    });
    leaseHeartbeat = startRuntimeLeaseHeartbeat({
      lease: experimentLease,
      signal: abortController.signal,
      onLost(error) {
        leaseLossError = error;
        abortController.abort();
      },
    });
    injectLifecycleFault("BEFORE_TELEMETRY");
    experimentTelemetry = createExperimentTelemetry({
      experimentId: cfg.experiment.id,
      mode: cfg.dryRun ? "dry-run" : "live",
      venue: cfg.venues[0] || "extended",
      symbol: cfg.markets[0] || "BTC",
      scopeKey: experimentScopeKey,
      leaseGeneration: String(experimentLease.generation),
      manifestFields: {
        experiment_spec_version: cfg.experiment.specVersion,
        starting_capital_usd: cfg.experiment.capitalUsd,
        leverage: cfg.experiment.leverage,
        max_margin_budget_usd: cfg.experiment.capitalUsd * cfg.experiment.marginFraction,
        max_planned_gross_notional_usd: cfg.experiment.maxGrossNotionalUsd,
        grid_half_band_pct: Number((cfg.experiment.halfBandPct * 100).toFixed(6)),
        grid_level_count: cfg.experiment.gridCount,
        daily_loss_limit_usd: cfg.experiment.dailyLossUsd,
        max_drawdown_usd: cfg.experiment.maxDrawdownUsd,
        boundary_buffer_pct: Number((cfg.experiment.boundaryBufferPct * 100).toFixed(6)),
      },
    });
    injectLifecycleFault("BEFORE_RISK_LOAD");
    experimentRiskState = acknowledgeHaltIfRequested(
      cfg.experiment.id,
      loadRiskState(cfg.experiment.id, undefined, experimentScopeKey)
    );
    experimentRiskState = {
      ...experimentRiskState,
      scopeKey: experimentScopeKey,
      leaseGeneration: String(experimentLease.generation),
    };
    experimentLease.assertCurrent();
    if (!isForcedHaltInMemoryOnly(cfg.experiment.id)) {
      try {
        persistRiskState(cfg.experiment.id, experimentRiskState);
      } catch (error: any) {
        experimentRiskState = latchForcedHaltInMemory(
          cfg.experiment.id,
          experimentRiskState,
          "RISK_STATE_PERSIST_FAILED"
        );
        console.error(`[experiment] startup risk-state persist failed: ${String(error?.message || error).slice(0, 160)}`);
      }
    }
    if (experimentRiskState.halted) {
      console.warn(
        `[experiment] HALTED ${experimentRiskState.haltStatus} reasons=${experimentRiskState.haltReasons.join(",")}; set EXPERIMENT_HALT_ACK=${experimentRiskState.haltId} once to resume`
      );
    }
  }
  softResumeAnchors = loadSoftResumeAnchors({
    experimentId: cfg.experiment.id,
    scopeKey: experimentScopeKey,
  });
  injectLifecycleFault("AFTER_CHECKPOINT");
  if (cfg.experiment.enabled && Object.keys(softResumeAnchors).length) {
    experimentRestartCount = 1;
    emitExp("RESTART", { restart_count: experimentRestartCount, risk_flags: ["SOFT_RESUME"] });
  }
  loadBotPauseState();
  if (isBotPaused()) {
    console.warn("[bot-control] starting in PAUSED mode（data/bot-paused.json）");
  }

  console.log(
    `classic-grid start dryRun=${cfg.dryRun} venues=${cfg.venues.join(",")} markets=${cfg.markets.join(",")} tickMs=${cfg.tickMs}`
  );
  const gridSummary = cfg.venues
    .map((id) => {
      const g = cfg.grids[id];
      return `${id}=${g.gridCount}g/${g.leverage}x`;
    })
    .join(" ");
  void tgBoot(
    `dryRun=${cfg.dryRun}\nvenues=${cfg.venues.join(",")}\nmarkets=${cfg.markets.join(",")}\n` +
      `tickMs=${cfg.tickMs}\nmarginFrac=${cfg.grids[cfg.venues[0]]?.marginFraction ?? ""}\n` +
      gridSummary
  );

  setDashboardMeta({ dryRun: cfg.dryRun });
  dash = startDashboardServer(cfg.dashboardPort, {
    allowMutations: cfg.dryRun,
    authToken: cfg.dryRun ? process.env.DASHBOARD_AUTH_TOKEN : undefined,
  });

  let lastHourlyKey = "";
  let lastOfficialDashAt = 0;
  const maybeHourlyTg = async () => {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (key === lastHourlyKey) return;
    // 整点后 2 分钟内触发，避免刚启动连发
    if (now.getMinutes() > 5 && lastHourlyKey !== "") return;
    if (now.getMinutes() > 5 && lastHourlyKey === "") {
      // 启动不在整点：跳过，等下一整点
      lastHourlyKey = key;
      return;
    }
    try {
      const bundle = await refreshOfficialStats({ force: true, minIntervalMs: 0 });
      setDashboardOfficial(bundle);
      const snap = getDashboardSnapshot();
      const venues = snap.venues || [];
      const equitySum = venues.reduce((s, v) => s + (Number(v.equityUsd) || 0), 0);
      const oo = venues.reduce((s, v) => s + (Number(v.openOrders) || 0), 0);
      const expectOo = venues.reduce((s, v) => {
        const gc = Number(v.gridCount) || 0;
        return s + (gc > 0 ? gc : 0);
      }, 0);
      const healthy = venues.filter((v) => !v.lastError && v.seeded).length;
      let vol = 0;
      let fees = 0;
      let vn = 0;
      let fn = 0;
      for (const id of Object.keys(bundle.venues || {}) as VenueId[]) {
        const o = bundle.venues?.[id];
        if (!o || o.source !== "official") continue;
        if (o.volume != null && Number.isFinite(o.volume)) {
          vol += o.volume;
          vn++;
        }
        if (o.fees != null && Number.isFinite(o.fees)) {
          fees += o.fees;
          fn++;
        }
      }
      const cal = snap.ledger?.calendar || [];
      const todayRow =
        cal.find((r) => r.day === snap.ledger?.dayKey) || cal[0];
      const dayProfit =
        todayRow != null && Number.isFinite(Number(todayRow.dayProfit))
          ? Number(todayRow.dayProfit)
          : null;
      lastHourlyKey = key;
      await tgDailyOverview({
        dayKey: snap.ledger?.dayKey || bundle.dayKey || key,
        dayProfit,
        equity: equitySum > 0 ? equitySum : null,
        volume: vn > 0 ? vol : null,
        fees: fn > 0 ? fees : null,
        openOrders: oo,
        expectOrders: expectOo,
        healthy,
        totalVenues: venues.length || 5,
      });
    } catch (e: any) {
      console.error(`[tg-hourly] ${String(e?.message || e).slice(0, 160)}`);
    }
  };

  injectLifecycleFault("BEFORE_EXECUTOR_CREATE");
  const saved = loadVenueSessionCounters();
  for (const venue of cfg.venues) {
    const prev = saved[venue];
    if (prev && (prev.completedRungs > 0 || prev.gridProfit > 0)) {
      console.log(
        `[${venue}] restore ledger rungs=${prev.completedRungs} profit≈${prev.gridProfit.toFixed(4)}`
      );
    }
    const ex = createExecutor(venue, cfg.dryRun);
    if (cfg.experiment.enabled && experimentLease) {
      ex.setLeaseGeneration?.(experimentLease.generation);
    }
    runtimes.push({
      ex,
      seeded: false,
      active: new Map(),
      completedRungs: prev?.completedRungs || 0,
      gridProfit: prev?.gridProfit || 0,
      built: null,
      params: null,
      anchorMid: 0,
      anchorEpoch: 0,
      lastPosition: null,
      invCost: 0,
      unrealizedPnl: 0,
    });
  }

  for (const rt of runtimes) {
    injectLifecycleFault("BEFORE_CONNECT");
    try {
      await rt.ex.connect();
      await verifyLiveExperimentExecutor(rt, cfg);
      console.log(`[${rt.ex.id}] connected`);
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 200);
      console.error(`[${rt.ex.id}] connect failed: ${msg}`);
      rt.lastError = msg;
      void tgError(rt.ex.id, `connect failed: ${msg}`);
      if (cfg.experiment.enabled && !cfg.dryRun) {
        throw e;
      }
      upsertDashboardVenue({
        venue: rt.ex.id,
        market: cfg.markets[0] || "BTC",
        mid: 0,
        anchorMid: 0,
        lower: 0,
        upper: 0,
        spacing: 0,
        sizeBase: 0,
        gridCount: gridFor(cfg, rt.ex.id).gridCount,
        position: 0,
        openOrders: 0,
        seeded: false,
        completedRungs: 0,
        gridProfit: 0,
        unrealizedPnl: 0,
        lastError: msg,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  injectLifecycleFault("BEFORE_OFFICIAL_REFRESH");
  // Read-only dashboard statistics remain non-blocking until Phase 4 adds the
  // strict official-risk startup barrier.
  void refreshOfficialStats({ force: true })
    .then((b) => setDashboardOfficial(b))
    .catch((e) => console.error(`[official] refresh failed: ${String(e?.message || e).slice(0, 160)}`));

  do {
    if (abortController.signal.aborted) break;
    for (const market of cfg.markets) {
      for (const rt of runtimes) {
        if (abortController.signal.aborted) break;
        try {
          // 首连失败（如 Ext 429）时每轮重试，避免整场卡死
          if (!rt.seeded && rt.lastError) {
            try {
              rt.ex.disconnect();
            } catch {
              /* ignore */
            }
            await rt.ex.connect();
            await verifyLiveExperimentExecutor(rt, cfg);
            console.log(`[${rt.ex.id}] reconnected`);
            rt.lastError = undefined;
            emitExp("RESTART", {
              venue: rt.ex.id,
              reconnect_count: 1,
              risk_flags: ["RECONNECT"],
            });
          }
          await tickOne(rt, market, cfg);
        } catch (e: any) {
          const msg = String(e?.message || e).slice(0, 200);
          if (/RUNTIME_LEASE_(?:LOST|MISSING|GENERATION_MISMATCH|SOCKET_LOST)/.test(msg)) {
            leaseLossError = e;
            abortController.abort();
            break;
          }
          const transient = isTransientReadError(msg);
          console.error(
            `[${rt.ex.id}] tick failed${transient ? " (transient)" : ""}: ${msg}`
          );
          emitExp("ERROR", {
            venue: rt.ex.id,
            symbol: market,
            error_message: msg,
            error_code: transient ? "TICK_TRANSIENT" : "TICK_FAILED",
          });
          // 瞬时读失败：保留上次看板，不标异常、不把仓位/挂单刷成 0（绝不因此撤单）
          if (!transient) {
            rt.lastError = msg;
            void tgError(rt.ex.id, `tick failed: ${msg}`);
          } else {
            rt.lastError = undefined;
            void tgError(rt.ex.id, `tick failed: ${msg}`);
          }
          const prev = getDashboardSnapshot().venues.find(
            (v) => v.venue === rt.ex.id
          );
          upsertDashboardVenue({
            venue: rt.ex.id,
            market,
            mid: transient && prev?.mid ? prev.mid : 0,
            anchorMid: rt.anchorMid || prev?.anchorMid || 0,
            lower: rt.params?.lower || prev?.lower || 0,
            upper: rt.params?.upper || prev?.upper || 0,
            spacing: rt.built?.spacing || prev?.spacing || 0,
            sizeBase: rt.params?.sizeBase || prev?.sizeBase || 0,
            gridCount:
              gridFor(cfg, rt.ex.id).gridCount || prev?.gridCount || 0,
            position:
              transient && prev && Number.isFinite(prev.position)
                ? prev.position
                : 0,
            openOrders:
              transient && prev && Number.isFinite(prev.openOrders)
                ? prev.openOrders
                : 0,
            seeded: rt.seeded,
            completedRungs: rt.completedRungs,
            gridProfit: Number(rt.gridProfit.toFixed(4)),
            unrealizedPnl: Number(rt.unrealizedPnl.toFixed(4)),
            equityUsd: transient ? prev?.equityUsd : undefined,
            orders: transient ? prev?.orders : undefined,
            officialVolume: prev?.officialVolume,
            officialFees: prev?.officialFees,
            officialRealizedPnl: prev?.officialRealizedPnl,
            officialSource: prev?.officialSource,
            lastError: transient ? undefined : msg,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    void maybeHourlyTg();
    // 看板官方统计：约 5 分钟一轮（过勤会堆内存，且 Extended 易与下单抢 429）
    if (Date.now() - lastOfficialDashAt > 300_000) {
      lastOfficialDashAt = Date.now();
      void refreshOfficialStats({ force: true, minIntervalMs: 240_000 })
        .then((b) => setDashboardOfficial(b))
        .catch(() => {});
    }
    if (opts?.once) break;
    await sleep(cfg.tickMs, abortController.signal);
  } while (true);
  if (leaseLossError) throw new Error("RUNTIME_LEASE_LOST_DURING_RUN", { cause: leaseLossError });
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    if (dash) {
      try { await new Promise<void>((resolve) => dash!.close(() => resolve())); }
      catch { /* cleanup only */ }
      dash = null;
    }
    for (const rt of runtimes) {
      try { rt.ex.disconnect(); } catch { /* cleanup only */ }
    }
    leaseHeartbeat?.stop();
    leaseHeartbeat = null;
    if (experimentLease) {
      await experimentLease.release();
      experimentLease = null;
    }
    abortController.abort();
  }
}

export async function runStatus(): Promise<void> {
  const cfg = loadRuntimeConfig();
  const dry = cfg.dryRun;
  if (dry) {
    console.log("status: DRY_RUN=1 → 假 snapshot（设 DRY_RUN=0 可读实盘，仍不下单）");
  }
  for (const venue of cfg.venues) {
    const ex = createExecutor(venue, dry);
    try {
      await ex.connect();
      for (const market of cfg.markets) {
        const snap = await ex.snapshot(market);
        const anchored = snap.mid > 0 ? anchorGrid(gridFor(cfg, venue), snap.mid) : gridFor(cfg, venue);
        console.log(
          JSON.stringify(
            {
              venue: snap.venue,
              market: snap.market,
              mid: snap.mid,
              position: snap.position,
              openOrders: snap.openOrders.length,
              grid: anchored,
              sample: snap.openOrders.slice(0, 3),
            },
            null,
            2
          )
        );
      }
    } catch (e: any) {
      console.error(`[${venue}] ${String(e?.message || e).slice(0, 300)}`);
    } finally {
      ex.disconnect();
    }
  }
}

export async function runFlat(): Promise<void> {
  const cfg = loadRuntimeConfig();
  assertLiveAllowed(cfg);
  if (cfg.dryRun) {
    console.log("flat: DRY_RUN=1 → 只打印，不撤单/清仓");
  }
  for (const venue of cfg.venues) {
    const ex = createExecutor(venue, cfg.dryRun);
    try {
      await ex.connect();
      for (const market of cfg.markets) {
        try {
          await ex.cancelAll(market);
          console.log(`[${venue}] cancelAll ${market} done`);
        } catch (e: any) {
          console.error(
            `[${venue}] cancelAll failed: ${String(e?.message || e).slice(0, 300)}`
          );
        }
        try {
          await ex.closePosition(market);
          console.log(`[${venue}] closePosition ${market} done`);
        } catch (e: any) {
          console.error(
            `[${venue}] closePosition failed: ${String(e?.message || e).slice(0, 300)}`
          );
        }
        try {
          const snap = await ex.snapshot(market);
          console.log(
            `[${venue}] after flat pos=${snap.position} oo=${snap.openOrders.length}`
          );
        } catch {
          /* ignore */
        }
      }
    } catch (e: any) {
      console.error(`[${venue}] flat failed: ${String(e?.message || e).slice(0, 300)}`);
    } finally {
      ex.disconnect();
    }
  }
}
