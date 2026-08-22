import assert from "node:assert/strict";
import { test } from "node:test";
import { ExtendedExecutor } from "../src/venues/extended.js";
import { ExtendedAccountStreamState } from "../src/venues/extendedAccountStream.js";
import { ExtendedObservationBarrier } from "../src/venues/extendedObservation.js";
import {
  ExtendedStrictApi,
  type ExtendedStrictExchangeFacade,
} from "../src/venues/extendedStrictApi.js";

const EPOCH = 1_700_000_000_000;

function makeClock(): () => number {
  let value = EPOCH;
  return () => value++;
}

function initialMessage(type: "BALANCE" | "POSITION" | "ORDER", data: object) {
  return { type, data, ts: EPOCH, seq: 1 };
}

function initializedState(now = makeClock()): ExtendedAccountStreamState {
  const state = new ExtendedAccountStreamState(now);
  state.ingest(initialMessage("BALANCE", { balance: { equity: "50" } }));
  state.ingest(initialMessage("POSITION", { positions: [] }));
  state.ingest(initialMessage("ORDER", { orders: [] }));
  assert.equal(state.checkpoint().initialized, true);
  return state;
}

type MethodName = keyof ExtendedStrictExchangeFacade;

function makeFacade(fail?: MethodName): ExtendedStrictExchangeFacade {
  const call = <T>(name: MethodName, value: T): Promise<T> =>
    fail === name ? Promise.reject(new Error(`FAIL_${name}`)) : Promise.resolve(value);
  return {
    strictReadAccountDetails: () =>
      call("strictReadAccountDetails", { accountId: "3017", l2Vault: "8", status: "ACTIVE" }),
    strictReadBalance: () =>
      call("strictReadBalance", {
        accountId: "3017",
        balance: "50",
        equity: "50",
        availableForTrade: "35",
        updatedTime: EPOCH,
      }),
    strictReadPositions: (market) =>
      call("strictReadPositions", [
        {
          accountId: "3017",
          market,
          side: "LONG",
          size: "0.001",
          markPrice: "100000",
          openPrice: "99000",
          unrealisedPnl: "1",
          liquidationPrice: "90000",
          updatedAt: EPOCH,
        },
      ]),
    strictReadOpenOrders: (market) =>
      call("strictReadOpenOrders", [
        {
          id: "9223372036854775808",
          externalId: "grid-1",
          accountId: "3017",
          market,
          side: "BUY",
          price: "97000",
          qty: "0.001",
          filledQty: "0",
          status: "NEW",
          updatedTime: EPOCH,
        },
      ]),
    strictReadLeverage: (market) =>
      call("strictReadLeverage", { accountId: "3017", market, leverage: "10" }),
    strictReadMarkPrice: (market) =>
      call("strictReadMarkPrice", { market, markPrice: "100000", updatedAt: EPOCH }),
  };
}

test("strict REST facade never restamps or returns a cached success after a failed refresh", async () => {
  const cases: Array<{
    method: MethodName;
    read: (api: ExtendedStrictApi) => Promise<{ ok: boolean; lastSuccessfulAt?: string; sourceUpdatedAt?: string }>;
  }> = [
    { method: "strictReadAccountDetails", read: (api) => api.account() },
    { method: "strictReadBalance", read: (api) => api.balance() },
    { method: "strictReadPositions", read: (api) => api.positions("BTC-USD") },
    { method: "strictReadOpenOrders", read: (api) => api.openOrders("BTC-USD") },
    { method: "strictReadLeverage", read: (api) => api.leverage("BTC-USD") },
    { method: "strictReadMarkPrice", read: (api) => api.markPrice("BTC-USD") },
  ];

  for (const scenario of cases) {
    const clock = makeClock();
    const facade = makeFacade();
    const api = new ExtendedStrictApi(facade, clock);
    const success = await scenario.read(api);
    assert.equal(success.ok, true);
    const failing = makeFacade(scenario.method);
    Object.assign(facade, failing);
    const failure = await scenario.read(api);
    assert.equal(failure.ok, false, scenario.method);
    assert.equal(failure.lastSuccessfulAt, success.lastSuccessfulAt, scenario.method);
    assert.equal(failure.sourceUpdatedAt, undefined, scenario.method);
  }
});

test("cold account-stream state cannot produce zero-position or empty-order success", async () => {
  const clock = makeClock();
  const result = await new ExtendedObservationBarrier(
    new ExtendedStrictApi(makeFacade(), clock),
    new ExtendedAccountStreamState(clock),
    clock
  ).observe({ market: "BTC-USD", leaseGeneration: 7 });
  assert.deepEqual(result.ok, false);
  if (result.ok) assert.fail("cold stream unexpectedly succeeded");
  assert.equal(result.reasonCode, "WS_NOT_INITIALIZED");
});

test("account stream sequence 1 followed by 3 is invalid and requires reconnect", () => {
  const state = initializedState();
  assert.throws(
    () =>
      state.ingest({
        type: "POSITION",
        data: { positions: [] },
        ts: EPOCH + 1,
        seq: 3,
      }),
    /EXTENDED_WS_SEQUENCE_GAP/
  );
  assert.equal(state.checkpoint().valid, false);
  assert.equal(state.checkpoint().errorCode, "EXTENDED_WS_SEQUENCE_GAP");
});

test("relevant WS update inside REST window forces a clean retry", async () => {
  const clock = makeClock();
  const state = initializedState(clock);
  const facade = makeFacade();
  let accountReads = 0;
  const original = facade.strictReadAccountDetails;
  facade.strictReadAccountDetails = async () => {
    accountReads += 1;
    if (accountReads === 1) {
      state.ingest({
        type: "BALANCE",
        data: { balance: { equity: "49" } },
        ts: EPOCH + 10,
        seq: 2,
      });
    }
    return original();
  };
  const result = await new ExtendedObservationBarrier(
    new ExtendedStrictApi(facade, clock),
    state,
    clock
  ).observe({ market: "BTC-USD", leaseGeneration: 11, maxAttempts: 2 });
  assert.equal(result.ok, true);
  assert.equal(accountReads, 2);
  if (!result.ok) assert.fail("observation retry unexpectedly failed");
  assert.equal(result.snapshot.generation.leaseGeneration, 11);
  assert.ok(result.snapshot.generation.sourceGeneration.includes(result.snapshot.generation.observationId));
  assert.ok(result.snapshot.generation.sourceGeneration.includes("11"));
  assert.equal(result.snapshot.generation.wsSeqStart, 2);
  assert.equal(result.snapshot.generation.wsSeqEnd, 2);
  assert.equal(result.snapshot.generation.relevantWsEventsDuringWindow, 0);
});

test("persistent REST/WS race fails closed instead of mixing generations", async () => {
  const clock = makeClock();
  const state = initializedState(clock);
  const facade = makeFacade();
  let seq = 1;
  const original = facade.strictReadBalance;
  facade.strictReadBalance = async () => {
    seq += 1;
    state.ingest({
      type: "BALANCE",
      data: { balance: { equity: "48" } },
      ts: EPOCH + seq,
      seq,
    });
    return original();
  };
  const result = await new ExtendedObservationBarrier(
    new ExtendedStrictApi(facade, clock),
    state,
    clock
  ).observe({ market: "BTC-USD", leaseGeneration: 12, maxAttempts: 2 });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("racy observation unexpectedly succeeded");
  assert.equal(result.reasonCode, "OBSERVATION_RACE");
});

test("account identity disagreement across sources fails closed", async () => {
  const clock = makeClock();
  const state = initializedState(clock);
  const facade = makeFacade();
  facade.strictReadPositions = async (market) => [
    { accountId: "different-account", market, side: "LONG", size: "0.001" },
  ];
  const result = await new ExtendedObservationBarrier(
    new ExtendedStrictApi(facade, clock),
    state,
    clock
  ).observe({ market: "BTC-USD", leaseGeneration: 13 });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("account mismatch unexpectedly succeeded");
  assert.equal(result.reasonCode, "ACCOUNT_MISMATCH");
});

test("stale official source timestamp and unavailable price have distinct failures", async () => {
  const staleClock = makeClock();
  const staleState = initializedState(staleClock);
  const staleFacade = makeFacade();
  const staleApi = new ExtendedStrictApi(staleFacade, staleClock);
  const readBalance = staleApi.balance.bind(staleApi);
  staleApi.balance = async () => ({
    ...(await readBalance()),
    responseCompletedAt: new Date(EPOCH - 60_000).toISOString(),
    lastSuccessfulAt: new Date(EPOCH - 60_000).toISOString(),
  });
  const stale = await new ExtendedObservationBarrier(
    staleApi,
    staleState,
    staleClock
  ).observe({ market: "BTC-USD", leaseGeneration: 14, maxSourceAgeMs: 30_000 });
  assert.equal(stale.ok, false);
  if (stale.ok) assert.fail("stale source unexpectedly succeeded");
  assert.equal(stale.reasonCode, "SOURCE_STALE");
  assert.deepEqual(stale.failedSources, ["EXTENDED_REST_BALANCE"]);

  const priceClock = makeClock();
  const priceState = initializedState(priceClock);
  const priceFacade = makeFacade();
  priceFacade.strictReadMarkPrice = async (market) => ({ market, markPrice: "0" });
  const unavailable = await new ExtendedObservationBarrier(
    new ExtendedStrictApi(priceFacade, priceClock),
    priceState,
    priceClock
  ).observe({ market: "BTC-USD", leaseGeneration: 15 });
  assert.equal(unavailable.ok, false);
  if (unavailable.ok) assert.fail("zero mark price unexpectedly succeeded");
  assert.equal(unavailable.reasonCode, "PRICE_UNAVAILABLE");
});

test("authoritative API failure cannot be converted into a cached flat snapshot", async () => {
  const executor = new ExtendedExecutor(false);
  (executor as unknown as { observation: { observe(): Promise<unknown> } }).observation = {
    observe: async () => ({
      ok: false,
      observationId: "failed-observation",
      failedSources: ["EXTENDED_REST_POSITIONS"],
      reasonCode: "REST_FAILURE",
    }),
  };
  await assert.rejects(
    executor.snapshot("BTC"),
    /EXTENDED_STRICT_SNAPSHOT_REST_FAILURE:EXTENDED_REST_POSITIONS/
  );
});
