import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import {
  assertLiveAllowed,
  assertExecutionAllowed,
  loadRuntimeConfig,
} from "../src/config.js";
import {
  DRY_RUN_ALLOWED_VALUES,
  DRY_RUN_FALSE_VALUE,
  DRY_RUN_TRUE_VALUE,
  EXTENDED_NETWORK_PROFILES,
  LIVE_CONFIRM_ALLOWED_VALUES,
  LIVE_CONFIRM_VALUE,
  TESTNET_NETWORK_WRITE_AUTHORIZED,
  MAINNET_NETWORK_WRITE_AUTHORIZED,
  assertSandboxWriteAllowed,
  assertStateNetworkIdentity,
  bindNetworkScopeKey,
  effectiveRestUrl,
  effectiveWebsocketUrl,
  formatExtendedBoundaryDiagnostics,
  parseExecutionBoundary,
  qualifySandboxNetworkProfile,
  vendorRequestUrl,
  type ExtendedNetworkProfile,
} from "../src/extendedNetwork.js";
import { runFlat, runLoop, runStatus } from "../src/loop.js";
import { ExtendedExecutor } from "../src/venues/extended.js";
import type { VenueExecutor } from "../src/venues/types.js";
import { withEnv, withEnvAsync } from "./helpers/env.js";
import { installOfflineNetworkGuard } from "./helpers/offlineNetworkGuard.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER_MAINNET_KEY = "PLACEHOLDER_MAINNET_API_KEY_R2A";
const PLACEHOLDER_TESTNET_KEY = "PLACEHOLDER_TESTNET_API_KEY_R2A";
const PLACEHOLDER_TESTNET_PRIV = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01";

const SANDBOX_ENV = {
  EXECUTION_MODE: "sandbox",
  EXTENDED_NETWORK: "sepolia",
  SANDBOX_CONFIRM: "EXTENDED_SEPOLIA_TEST_ONLY",
  DRY_RUN: "0",
  LIVE_CONFIRM: "",
  EXPERIMENT_MODE: "1",
  EXPERIMENT_SPEC_VERSION: "0.2.0",
  VENUES: "extended",
  MARKETS: "BTC",
} as const;

const V01_LIVE_ENV = {
  EXPERIMENT_MODE: "1",
  EXPERIMENT_SPEC_VERSION: "0.1.0",
  DRY_RUN: "0",
  LIVE_CONFIRM: "YES",
  VENUES: "extended",
  MARKETS: "BTC",
  EXPERIMENT_ID: "grid-ab-v0.1-classic-live",
  EXPERIMENT_ACCOUNT_SCOPE: "research-1",
} as const;

const DRY_RUN_ACCEPTED_TRUE = [undefined, "", DRY_RUN_TRUE_VALUE] as const;
const DRY_RUN_REJECTED_VALUES = [
  "banana",
  "FALSEE",
  "TRUE",
  "00",
  "yesplease",
  "true",
  "True",
  "yes",
  "YES",
  "false",
  "FALSE",
  "False",
  " 0",
  "0 ",
  " 1",
  "1 ",
  "\t0",
  "0\n",
  "1.0",
  "01",
  "-0",
  "no",
  "off",
  "2",
] as const;
const LIVE_CONFIRM_REJECTED_VALUES = [
  "yes",
  "Yes",
  "true",
  "TRUE",
  "1",
  "banana",
  " YES",
  "YES ",
  "yesplease",
  "Y",
] as const;
const OFFLINE_ENV = {
  EXPERIMENT_MODE: "1",
  EXPERIMENT_SPEC_VERSION: "0.2.0",
  EXECUTION_MODE: "",
  EXTENDED_NETWORK: "",
  SANDBOX_CONFIRM: "",
  LIVE_CONFIRM: "",
  VENUES: "extended",
  MARKETS: "BTC",
} as const;
const FORBIDDEN_REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;
const MAINNET_REST_HOST = "api.starknet.extended.exchange";
const VENDOR_INDEX_HREF = pathToFileURL(path.join(ROOT, "vendor/extended/exchange/index.js")).href;
const LOOPBACK_PROXY = "http://127.0.0.1:9";
const REDIRECT_LOCATION_WITH_SECRET =
  "https://user:PLACEHOLDER_MAINNET_API_KEY_R2A@evil.example/steal?key=PLACEHOLDER_TESTNET_API_KEY_R2A";

type VendorExchange = {
  network: string;
  domain: { chainId: string };
  signingDomain: string;
  apiUrl: string;
  websocketBase: string;
  init: () => Promise<unknown>;
  _reqOnce: (
    method: string,
    path: string,
    body?: unknown,
    opts?: { full?: boolean },
  ) => Promise<unknown>;
};

type CreateExchange = (cfg: Record<string, unknown>) => VendorExchange;

type FetchCall = { url: string; init: RequestInit & { dispatcher?: unknown } };

function mixedProfile(overrides: Partial<ExtendedNetworkProfile>): ExtendedNetworkProfile {
  return { ...EXTENDED_NETWORK_PROFILES.sepolia, ...overrides };
}

function expectThrow(fn: () => unknown, pattern: RegExp, label: string): void {
  assert.throws(fn, pattern, label);
}

function envWithDryRun(
  base: Record<string, string>,
  dryRun: string | undefined,
): NodeJS.ProcessEnv {
  const env = { ...base } as NodeJS.ProcessEnv;
  if (dryRun === undefined) delete env.DRY_RUN;
  else env.DRY_RUN = dryRun;
  return env;
}

function trackingLoopBindings(): { calls: string[]; bindings: Parameters<typeof runLoop>[0] } {
  const calls: string[] = [];
  const executor: VenueExecutor = {
    id: "extended",
    async connect() {
      calls.push("connect");
    },
    disconnect() {
      calls.push("disconnect");
    },
    async snapshot(market) {
      calls.push("snapshot");
      return { venue: "extended", market, mid: 0, position: 0, openOrders: [] };
    },
    async apply() {
      calls.push("apply");
      return { placed: 0, cancelled: 0, failed: 0, errors: [] };
    },
    async cancelAll() {
      calls.push("cancelAll");
    },
    async closePosition() {
      calls.push("closePosition");
    },
  };
  return {
    calls,
    bindings: {
      createExecutor: () => {
        calls.push("create");
        return executor;
      },
      refreshOfficialStats: async () => {
        calls.push("stats");
        throw new Error("OFFICIAL_STATS_MUST_NOT_RUN");
      },
      getOfficialCache: () => {
        calls.push("cache");
        return null;
      },
    },
  };
}

function vendorProfileArgs(profile: ExtendedNetworkProfile): Record<string, string> {
  return {
    apiUrl: profile.restOrigin,
    network: profile.network,
    chainId: profile.chainId,
    signingDomain: profile.signingDomain,
    websocketBase: profile.websocketBase,
  };
}

async function loadCreateExchange(): Promise<CreateExchange> {
  const mod = await import(VENDOR_INDEX_HREF) as { createExchange: CreateExchange };
  return mod.createExchange;
}

function createMainnetVendor(createExchange: CreateExchange): VendorExchange {
  return createExchange({
    apiKey: PLACEHOLDER_MAINNET_KEY,
    vault: 424242,
    starkPrivateKey: PLACEHOLDER_TESTNET_PRIV,
    ...vendorProfileArgs(EXTENDED_NETWORK_PROFILES.mainnet),
  });
}

function instrumentBodyReads(response: Response): { bodyRead: () => boolean } {
  let bodyRead = false;
  const origJson = response.json.bind(response);
  const origText = response.text.bind(response);
  Object.defineProperty(response, "json", {
    configurable: true,
    value: async () => {
      bodyRead = true;
      return origJson();
    },
  });
  Object.defineProperty(response, "text", {
    configurable: true,
    value: async () => {
      bodyRead = true;
      return origText();
    },
  });
  return { bodyRead: () => bodyRead };
}

function installRedirectAwareFetchMock(
  handler: (url: string, init: FetchCall["init"]) => Response,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const prev = globalThis.fetch;
  const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const requestInit = (init ?? {}) as FetchCall["init"];
    calls.push({ url, init: requestInit });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("TEST_NETWORK_GUARD_FETCH");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== MAINNET_REST_HOST) {
      throw new Error("TEST_REDIRECT_TARGET_CONTACTED");
    }
    const response = handler(url, requestInit);
    const status = response.status;
    const redirectMode = requestInit.redirect ?? "follow";
    const isRedirect =
      status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
    if (isRedirect && redirectMode !== "manual" && redirectMode !== "error") {
      const location = response.headers.get("Location") || "";
      const next = new URL(location, url).href;
      return mock(next, requestInit);
    }
    return response;
  }) as typeof fetch;
  globalThis.fetch = mock;
  return {
    calls,
    restore: () => {
      globalThis.fetch = prev;
    },
  };
}

describe("R2-A Extended Sepolia sandbox boundary", () => {
  let restoreGuard: (() => void) | undefined;
  before(() => {
    restoreGuard = installOfflineNetworkGuard();
  });
  after(() => {
    restoreGuard?.();
  });

  it("N1: sandbox with missing explicit network is rejected", () => {
    withEnv({ ...SANDBOX_ENV, EXTENDED_NETWORK: "" }, () => {
      expectThrow(() => loadRuntimeConfig(), /EXTENDED_NETWORK_REQUIRED/, "N1");
    });
  });

  it("N2: sandbox with mainnet REST origin is rejected", () => {
    expectThrow(
      () =>
        qualifySandboxNetworkProfile(
          mixedProfile({ restOrigin: EXTENDED_NETWORK_PROFILES.mainnet.restOrigin }),
        ),
      /EXTENDED_SANDBOX_MAINNET_REST/,
      "N2",
    );
  });

  it("N3: sandbox with mainnet WebSocket origin is rejected", () => {
    expectThrow(
      () =>
        qualifySandboxNetworkProfile(
          mixedProfile({ websocketBase: EXTENDED_NETWORK_PROFILES.mainnet.websocketBase }),
        ),
      /EXTENDED_SANDBOX_MAINNET_WS/,
      "N3",
    );
  });

  it("N4: sandbox with SN_MAIN is rejected", () => {
    expectThrow(
      () => qualifySandboxNetworkProfile(mixedProfile({ chainId: "SN_MAIN" })),
      /EXTENDED_SANDBOX_SN_MAIN/,
      "N4",
    );
  });

  it("N5: sandbox with mainnet signing domain is rejected", () => {
    expectThrow(
      () =>
        qualifySandboxNetworkProfile(
          mixedProfile({ signingDomain: EXTENDED_NETWORK_PROFILES.mainnet.signingDomain }),
        ),
      /EXTENDED_SANDBOX_MAINNET_SIGNING_DOMAIN/,
      "N5",
    );
  });

  it("N6: sandbox with custom endpoint override is rejected", () => {
    withEnv(
      { ...SANDBOX_ENV, EXTENDED_API_URL: "https://api.starknet.sepolia.extended.exchange" },
      () => {
        expectThrow(() => loadRuntimeConfig(), /EXTENDED_SANDBOX_CUSTOM_ENDPOINT_FORBIDDEN/, "N6");
      },
    );
  });

  it("N7: sandbox with proxy enabled is rejected", () => {
    withEnv({ ...SANDBOX_ENV, EXTENDED_USE_PROXY: "1" }, () => {
      expectThrow(() => loadRuntimeConfig(), /EXTENDED_SANDBOX_PROXY_FORBIDDEN/, "N7");
    });
  });

  it("N8: sandbox never falls back to mainnet credentials", () => {
    withEnv({ ...SANDBOX_ENV, EXTENDED_API_KEY: PLACEHOLDER_MAINNET_KEY }, () => {
      expectThrow(
        () => loadRuntimeConfig(),
        /EXTENDED_SANDBOX_MAINNET_CREDENTIAL_FORBIDDEN/,
        "N8",
      );
    });
  });

  it("N9: sandbox with mixed mainnet and testnet credentials is rejected", () => {
    withEnv(
      {
        ...SANDBOX_ENV,
        EXTENDED_API_KEY: PLACEHOLDER_MAINNET_KEY,
        EXTENDED_TESTNET_API_KEY: PLACEHOLDER_TESTNET_KEY,
      },
      () => {
        expectThrow(() => loadRuntimeConfig(), /EXTENDED_SANDBOX_CREDENTIAL_MIXED/, "N9");
      },
    );
  });

  it("N10: live mode with Sepolia profile is rejected", () => {
    withEnv({ ...V01_LIVE_ENV, EXECUTION_MODE: "live", EXTENDED_NETWORK: "sepolia" }, () => {
      expectThrow(() => loadRuntimeConfig(), /EXTENDED_LIVE_SEPOLIA_FORBIDDEN/, "N10");
    });
  });

  it("N11: live and sandbox confirmations together are rejected", () => {
    withEnv(
      {
        DRY_RUN: "1",
        LIVE_CONFIRM: "YES",
        SANDBOX_CONFIRM: "EXTENDED_SEPOLIA_TEST_ONLY",
        EXPERIMENT_MODE: "1",
        EXPERIMENT_SPEC_VERSION: "0.2.0",
      },
      () => {
        expectThrow(() => loadRuntimeConfig(), /EXECUTION_CONFIRMATION_CONFLICT/, "N11");
      },
    );
  });

  it("N12: v0.2 live remains forbidden", () => {
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
        expectThrow(() => assertLiveAllowed(cfg), /EXPERIMENT_V02_LIVE_FORBIDDEN/, "N12-live");
        expectThrow(() => assertExecutionAllowed(cfg), /EXPERIMENT_V02_LIVE_FORBIDDEN/, "N12-exec");
      },
    );
  });

  it("N13: state/cursor/lease network mismatch fails closed", () => {
    const sepolia = bindNetworkScopeKey("research-1:extended:BTC", "sepolia");
    const mainnet = bindNetworkScopeKey("research-1:extended:BTC", "mainnet");
    expectThrow(
      () => assertStateNetworkIdentity(sepolia, "mainnet"),
      /EXTENDED_NETWORK_STATE_MISMATCH/,
      "N13-sepolia-as-mainnet",
    );
    expectThrow(
      () => assertStateNetworkIdentity(mainnet, "sepolia"),
      /EXTENDED_NETWORK_STATE_MISMATCH/,
      "N13-mainnet-as-sepolia",
    );
  });

  it("N14: legacy persisted state without network identity fails closed in sandbox", () => {
    expectThrow(
      () => assertStateNetworkIdentity("dry-run:extended:BTC", "sepolia"),
      /EXTENDED_NETWORK_IDENTITY_MISSING/,
      "N14",
    );
  });

  it("N15: attempted real fetch from a unit test is blocked", async () => {
    await assert.rejects(
      () => globalThis.fetch("https://api.starknet.sepolia.extended.exchange/api/v1/info/markets"),
      /TEST_NETWORK_GUARD_FETCH/,
    );
    withEnv(SANDBOX_ENV, () => {
      loadRuntimeConfig();
    });
  });

  it("N16: attempted real WebSocket from a unit test is blocked", async () => {
    const { default: WebSocket } = await import("ws");
    await assert.rejects(
      () =>
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("TEST_NETWORK_GUARD_DNS")), 2000);
          try {
            const socket = new WebSocket(
              "wss://starknet.sepolia.extended.exchange/stream.extended.exchange/v1/account",
            );
            socket.on("open", () => {
              clearTimeout(timer);
              reject(new Error("WS_OPENED"));
            });
            socket.on("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        }),
      /TEST_NETWORK_GUARD_DNS|TEST_NETWORK_GUARD_WEBSOCKET|TEST_NETWORK_GUARD_FETCH/,
    );
  });

  it("N17: secret values are absent from rendered diagnostics", () => {
    withEnv(
      {
        ...SANDBOX_ENV,
        EXTENDED_TESTNET_API_KEY: PLACEHOLDER_TESTNET_KEY,
        EXTENDED_TESTNET_STARK_PRIVATE_KEY: PLACEHOLDER_TESTNET_PRIV,
      },
      () => {
        const cfg = loadRuntimeConfig();
        const text = [
          formatExtendedBoundaryDiagnostics({
            executionTarget: cfg.executionTarget,
            dryRun: cfg.dryRun,
            liveConfirm: cfg.liveConfirm,
            sandboxConfirm: cfg.sandboxConfirm,
            extendedNetwork: cfg.extendedNetwork,
            extendedNetworkExplicit: cfg.extendedNetworkExplicit,
            profile: cfg.extendedProfile,
          }),
          JSON.stringify(cfg),
        ].join("\n");
        assert.equal(text.includes(PLACEHOLDER_TESTNET_KEY), false);
        assert.equal(text.includes(PLACEHOLDER_TESTNET_PRIV), false);
        assert.equal(text.includes(PLACEHOLDER_MAINNET_KEY), false);
      },
    );
    withEnv({ ...SANDBOX_ENV, EXTENDED_API_KEY: PLACEHOLDER_MAINNET_KEY }, () => {
      try {
        loadRuntimeConfig();
        assert.fail("expected credential rejection");
      } catch (error) {
        const message = String((error as Error).message);
        assert.equal(message.includes(PLACEHOLDER_MAINNET_KEY), false);
        assert.match(message, /EXTENDED_SANDBOX_MAINNET_CREDENTIAL_FORBIDDEN/);
      }
    });
  });

  it("N18: effective URL cannot double-append /api/v1", () => {
    const sepolia = EXTENDED_NETWORK_PROFILES.sepolia;
    const url = effectiveRestUrl(sepolia, "/info/markets");
    assert.equal(url, "https://api.starknet.sepolia.extended.exchange/api/v1/info/markets");
    assert.equal(url.match(/\/api\/v1/g)?.length, 1);
    assert.equal(
      vendorRequestUrl(sepolia.restOrigin, "/api/v1/info/markets"),
      url,
    );
    expectThrow(
      () => effectiveRestUrl(sepolia, "/api/v1/info/markets"),
      /EXTENDED_REST_PREFIX_DOUBLE/,
      "N18-resource-prefix",
    );
    expectThrow(
      () => vendorRequestUrl(`${sepolia.restOrigin}/api/v1`, "/api/v1/info/markets"),
      /EXTENDED_REST_PREFIX_DOUBLE/,
      "N18-origin-prefix",
    );
  });

  it("P1: historical dry-run behavior remains allowed", () => {
    withEnv(
      {
        EXPERIMENT_MODE: "1",
        EXPERIMENT_SPEC_VERSION: "0.2.0",
        DRY_RUN: "1",
      },
      () => {
        const cfg = loadRuntimeConfig();
        assert.equal(cfg.dryRun, true);
        assert.equal(cfg.executionTarget, "dry-run");
        assert.equal(cfg.extendedNetwork, null);
        assert.equal(cfg.extendedProfile, null);
        assertExecutionAllowed(cfg);
        assert.equal(bindNetworkScopeKey("dry-run:extended:BTC", null), "dry-run:extended:BTC");
      },
    );
  });

  it("P2: explicit Sepolia profile parses in offline sandbox mode", () => {
    withEnv(SANDBOX_ENV, () => {
      const cfg = loadRuntimeConfig();
      assert.equal(cfg.executionTarget, "sandbox");
      assert.equal(cfg.dryRun, false);
      assert.equal(cfg.extendedNetwork, "sepolia");
      assert.equal(cfg.sandboxConfirm, true);
      assert.equal(cfg.liveConfirm, false);
      assert.deepEqual(cfg.extendedProfile, EXTENDED_NETWORK_PROFILES.sepolia);
      assertExecutionAllowed(cfg);
      expectThrow(() => assertSandboxWriteAllowed(), /TESTNET_NETWORK_WRITE_UNAUTHORIZED/, "P2-write");
    });
  });

  it("P3: explicit mainnet profile parses in its existing authorized v0.1 context", () => {
    withEnv({ ...V01_LIVE_ENV, EXTENDED_NETWORK: "mainnet" }, () => {
      const cfg = loadRuntimeConfig();
      assert.equal(cfg.executionTarget, "live");
      assert.equal(cfg.extendedNetwork, "mainnet");
      assert.equal(cfg.extendedNetworkExplicit, true);
      assert.deepEqual(cfg.extendedProfile, EXTENDED_NETWORK_PROFILES.mainnet);
      assertLiveAllowed(cfg);
      assertExecutionAllowed(cfg);
    });
  });

  it("P4: official testnet REST, WebSocket, domain, and chain-ID tuple matches", () => {
    const sepolia = EXTENDED_NETWORK_PROFILES.sepolia;
    assert.equal(sepolia.network, "sepolia");
    assert.equal(sepolia.restOrigin, "https://api.starknet.sepolia.extended.exchange");
    assert.equal(sepolia.restApiPrefix, "/api/v1");
    assert.equal(
      sepolia.websocketBase,
      "wss://starknet.sepolia.extended.exchange/stream.extended.exchange/v1",
    );
    assert.equal(sepolia.signingDomain, "starknet.sepolia.extended.exchange");
    assert.equal(sepolia.chainId, "SN_SEPOLIA");
    assert.equal(
      effectiveWebsocketUrl(sepolia, "account"),
      "wss://starknet.sepolia.extended.exchange/stream.extended.exchange/v1/account",
    );
    const mainnet = EXTENDED_NETWORK_PROFILES.mainnet;
    assert.equal(mainnet.restOrigin, "https://api.starknet.extended.exchange");
    assert.equal(
      mainnet.websocketBase,
      "wss://api.starknet.extended.exchange/stream.extended.exchange/v1",
    );
    assert.equal(mainnet.signingDomain, "extended.exchange");
    assert.equal(mainnet.chainId, "SN_MAIN");
  });

  it("P5: state identities differ between mainnet and Sepolia", () => {
    const base = "research-1:extended:BTC";
    const mainnet = bindNetworkScopeKey(base, "mainnet");
    const sepolia = bindNetworkScopeKey(base, "sepolia");
    assert.notEqual(mainnet, sepolia);
    assert.notEqual(mainnet, base);
    assert.notEqual(sepolia, base);
    assertStateNetworkIdentity(sepolia, "sepolia");
    assertStateNetworkIdentity(mainnet, "mainnet");
  });

  it("P6: ordinary non-secret configuration diagnostics remain usable", () => {
    withEnv(SANDBOX_ENV, () => {
      const boundary = parseExecutionBoundary();
      const text = formatExtendedBoundaryDiagnostics(boundary);
      assert.match(text, /executionTarget=sandbox/);
      assert.match(text, /extendedNetwork=sepolia/);
      assert.match(text, /chainId=SN_SEPOLIA/);
      assert.match(text, /signingDomain=starknet\.sepolia\.extended\.exchange/);
      assert.match(text, /testnetWriteAuthorized=no/);
      assert.match(text, /mainnetWriteAuthorized=no/);
    });
  });

  it("does not infer sandbox from a Sepolia API URL during dry-run", () => {
    withEnv(
      {
        DRY_RUN: "1",
        EXTENDED_API_URL: "https://api.starknet.sepolia.extended.exchange",
        EXPERIMENT_MODE: "1",
        EXPERIMENT_SPEC_VERSION: "0.2.0",
      },
      () => {
        const cfg = loadRuntimeConfig();
        assert.equal(cfg.executionTarget, "dry-run");
        assert.equal(cfg.dryRun, true);
      },
    );
  });

  it("does not convert DRY_RUN=0 into sandbox", () => {
    withEnv(
      {
        DRY_RUN: "0",
        LIVE_CONFIRM: "YES",
        EXPERIMENT_MODE: "1",
        EXPERIMENT_SPEC_VERSION: "0.1.0",
        VENUES: "extended",
        MARKETS: "BTC",
        EXPERIMENT_ID: "grid-ab-v0.1-classic-live",
        EXPERIMENT_ACCOUNT_SCOPE: "research-1",
      },
      () => {
        const cfg = loadRuntimeConfig();
        assert.equal(cfg.executionTarget, "live");
        assert.notEqual(cfg.executionTarget, "sandbox");
        assertLiveAllowed(cfg);
      },
    );
  });

  it("rejects plaintext, embedded credentials, and unexpected ports", () => {
    expectThrow(
      () =>
        qualifySandboxNetworkProfile(
          mixedProfile({ restOrigin: "http://api.starknet.sepolia.extended.exchange" }),
        ),
      /EXTENDED_ENDPOINT_PLAINTEXT/,
      "plaintext",
    );
    expectThrow(
      () =>
        qualifySandboxNetworkProfile(
          mixedProfile({
            restOrigin: "https://user:pass@api.starknet.sepolia.extended.exchange",
          }),
        ),
      /EXTENDED_ENDPOINT_EMBEDDED_CREDENTIAL/,
      "embedded",
    );
    expectThrow(
      () =>
        qualifySandboxNetworkProfile(
          mixedProfile({ restOrigin: "https://api.starknet.sepolia.extended.exchange:8443" }),
        ),
      /EXTENDED_ENDPOINT_UNEXPECTED_PORT/,
      "port",
    );
  });

  it("vendor no longer unconditionally assigns mainnet network/domain", async () => {
    const vendor = fs.readFileSync(path.join(ROOT, "vendor/extended/exchange/extended.js"), "utf8");
    assert.equal(vendor.includes("this.network = 'mainnet'"), false);
    assert.equal(vendor.includes("this.domain = DOMAINS.mainnet"), false);
    assert.match(vendor, /redirect: 'manual'/);
    assert.match(vendor, /EXTENDED_WEBSOCKET_BASE_REQUIRED/);
    assert.equal(vendor.includes("assertSameOriginResponse"), false);
    const sepolia = EXTENDED_NETWORK_PROFILES.sepolia;
    const href = VENDOR_INDEX_HREF;
    const { createExchange } = await import(href) as {
      createExchange: (cfg: Record<string, unknown>) => {
        network: string;
        domain: { chainId: string };
        signingDomain: string;
        apiUrl: string;
        init: () => Promise<unknown>;
      };
    };
    const ex = createExchange({
      apiKey: "placeholder-vendor-key",
      vault: 1,
      starkPrivateKey: "0x1",
      apiUrl: sepolia.restOrigin,
      network: sepolia.network,
      chainId: sepolia.chainId,
      signingDomain: sepolia.signingDomain,
      websocketBase: sepolia.websocketBase,
    });
    assert.equal(ex.network, "sepolia");
    assert.equal(ex.domain.chainId, "SN_SEPOLIA");
    assert.equal(ex.signingDomain, sepolia.signingDomain);
    assert.equal(ex.apiUrl, sepolia.restOrigin);
    expectThrow(
      () =>
        createExchange({
          apiKey: "placeholder-vendor-key",
          vault: 1,
          starkPrivateKey: "0x1",
          apiUrl: sepolia.restOrigin,
          network: "sepolia",
          chainId: "SN_MAIN",
          signingDomain: sepolia.signingDomain,
          websocketBase: sepolia.websocketBase,
        }),
      /EXTENDED_PROFILE_MIXED/,
      "vendor-mixed",
    );
  });

  it("sandbox connect is hard-disabled before any exchange mutation", async () => {
    await withEnvAsync(SANDBOX_ENV, async () => {
      const ex = new ExtendedExecutor(false);
      await assert.rejects(() => ex.connect(), /TESTNET_NETWORK_WRITE_UNAUTHORIZED/);
    });
    assert.equal(TESTNET_NETWORK_WRITE_AUTHORIZED, false);
    assert.equal(MAINNET_NETWORK_WRITE_AUTHORIZED, false);
  });

  it("C-WS1: missing websocketBase is rejected", async () => {
    const createExchange = await loadCreateExchange();
    const sepolia = EXTENDED_NETWORK_PROFILES.sepolia;
    expectThrow(
      () =>
        createExchange({
          apiKey: PLACEHOLDER_TESTNET_KEY,
          vault: 1,
          starkPrivateKey: "0x1",
          apiUrl: sepolia.restOrigin,
          network: sepolia.network,
          chainId: sepolia.chainId,
          signingDomain: sepolia.signingDomain,
        }),
      /EXTENDED_WEBSOCKET_BASE_REQUIRED/,
      "C-WS1",
    );
  });

  it("C-WS2: empty websocketBase is rejected", async () => {
    const createExchange = await loadCreateExchange();
    const sepolia = EXTENDED_NETWORK_PROFILES.sepolia;
    expectThrow(
      () =>
        createExchange({
          apiKey: PLACEHOLDER_TESTNET_KEY,
          vault: 1,
          starkPrivateKey: "0x1",
          ...vendorProfileArgs(sepolia),
          websocketBase: "",
        }),
      /EXTENDED_WEBSOCKET_BASE_REQUIRED/,
      "C-WS2-empty",
    );
    expectThrow(
      () =>
        createExchange({
          apiKey: PLACEHOLDER_TESTNET_KEY,
          vault: 1,
          starkPrivateKey: "0x1",
          ...vendorProfileArgs(sepolia),
          websocketBase: "   ",
        }),
      /EXTENDED_WEBSOCKET_BASE_REQUIRED/,
      "C-WS2-whitespace",
    );
  });

  it("C-WS3: mainnet websocketBase with Sepolia profile is rejected", async () => {
    const createExchange = await loadCreateExchange();
    const sepolia = EXTENDED_NETWORK_PROFILES.sepolia;
    expectThrow(
      () =>
        createExchange({
          apiKey: PLACEHOLDER_TESTNET_KEY,
          vault: 1,
          starkPrivateKey: "0x1",
          ...vendorProfileArgs(sepolia),
          websocketBase: EXTENDED_NETWORK_PROFILES.mainnet.websocketBase,
        }),
      /EXTENDED_PROFILE_MIXED/,
      "C-WS3",
    );
  });

  it("C-WS4: Sepolia websocketBase with mainnet profile is rejected", async () => {
    const createExchange = await loadCreateExchange();
    const mainnet = EXTENDED_NETWORK_PROFILES.mainnet;
    expectThrow(
      () =>
        createExchange({
          apiKey: PLACEHOLDER_MAINNET_KEY,
          vault: 1,
          starkPrivateKey: "0x1",
          ...vendorProfileArgs(mainnet),
          websocketBase: EXTENDED_NETWORK_PROFILES.sepolia.websocketBase,
        }),
      /EXTENDED_PROFILE_MIXED/,
      "C-WS4",
    );
  });

  it("C-WS5: correct mainnet tuple remains accepted in the authorized v0.1 context", async () => {
    const createExchange = await loadCreateExchange();
    const mainnet = EXTENDED_NETWORK_PROFILES.mainnet;
    const ex = createMainnetVendor(createExchange);
    assert.equal(ex.network, "mainnet");
    assert.equal(ex.domain.chainId, "SN_MAIN");
    assert.equal(ex.signingDomain, mainnet.signingDomain);
    assert.equal(ex.apiUrl, mainnet.restOrigin);
    assert.equal(ex.websocketBase, mainnet.websocketBase);
    withEnv({ ...V01_LIVE_ENV, EXTENDED_NETWORK: "mainnet" }, () => {
      const cfg = loadRuntimeConfig();
      assert.equal(cfg.executionTarget, "live");
      assert.deepEqual(cfg.extendedProfile, mainnet);
      assertLiveAllowed(cfg);
    });
  });

  it("C-WS6: correct Sepolia tuple parses offline but writes stay unauthorized", async () => {
    const createExchange = await loadCreateExchange();
    const sepolia = EXTENDED_NETWORK_PROFILES.sepolia;
    const ex = createExchange({
      apiKey: PLACEHOLDER_TESTNET_KEY,
      vault: 1,
      starkPrivateKey: "0x1",
      ...vendorProfileArgs(sepolia),
    });
    assert.equal(ex.network, "sepolia");
    assert.equal(ex.websocketBase, sepolia.websocketBase);
    await assert.rejects(() => ex.init(), /TESTNET_NETWORK_WRITE_UNAUTHORIZED/);
    withEnv(SANDBOX_ENV, () => {
      const cfg = loadRuntimeConfig();
      assert.deepEqual(cfg.extendedProfile, sepolia);
      expectThrow(() => assertSandboxWriteAllowed(), /TESTNET_NETWORK_WRITE_UNAUTHORIZED/, "C-WS6");
    });
  });

  it("C-R-MOCK: omitted redirect policy would contact the Location target", async () => {
    const mock = installRedirectAwareFetchMock(
      () =>
        new Response(JSON.stringify({ status: "OK", data: { hijacked: true } }), {
          status: 302,
          headers: { Location: REDIRECT_LOCATION_WITH_SECRET },
        }),
    );
    try {
      await assert.rejects(
        () => globalThis.fetch(`${EXTENDED_NETWORK_PROFILES.mainnet.restOrigin}/api/v1/info/markets`),
        /TEST_REDIRECT_TARGET_CONTACTED/,
      );
      assert.equal(mock.calls.length >= 2, true);
    } finally {
      mock.restore();
    }
  });

  for (const proxy of [false, true]) {
    const pathLabel = proxy ? "proxy" : "native";
    for (const status of FORBIDDEN_REDIRECT_STATUSES) {
      it(`C-R${status}-${pathLabel}: ${pathLabel} fetch rejects HTTP ${status} before follow or body parse`, async () => {
        const createExchange = await loadCreateExchange();
        const ex = createMainnetVendor(createExchange);
        const path = "/api/v1/info/markets";
        const expectedUrl = `${EXTENDED_NETWORK_PROFILES.mainnet.restOrigin}${path}`;
        let bodyRead = (): boolean => false;
        const env = proxy
          ? { EXTENDED_USE_PROXY: "1", EXTENDED_PROXY: LOOPBACK_PROXY }
          : { EXTENDED_USE_PROXY: "", EXTENDED_PROXY: "" };
        await withEnvAsync(env, async () => {
          const mock = installRedirectAwareFetchMock(() => {
            const response = new Response(
              JSON.stringify({ status: "OK", data: { hijacked: true } }),
              {
                status,
                headers: {
                  "Content-Type": "application/json",
                  Location: REDIRECT_LOCATION_WITH_SECRET,
                },
              },
            );
            const inst = instrumentBodyReads(response);
            bodyRead = inst.bodyRead;
            return response;
          });
          try {
            await assert.rejects(() => ex._reqOnce("GET", path), (error: unknown) => {
              const message = String((error as Error).message);
              assert.equal(message, "EXTENDED_ENDPOINT_REDIRECT_FORBIDDEN");
              assert.equal(message.includes(PLACEHOLDER_MAINNET_KEY), false);
              assert.equal(message.includes(PLACEHOLDER_TESTNET_KEY), false);
              assert.equal(message.includes(PLACEHOLDER_TESTNET_PRIV), false);
              assert.equal(message.includes("424242"), false);
              assert.equal(message.includes("evil.example"), false);
              assert.equal(message.includes(REDIRECT_LOCATION_WITH_SECRET), false);
              return true;
            });
            assert.equal(mock.calls.length, 1, "redirect target must not be contacted");
            assert.equal(mock.calls[0]?.url, expectedUrl);
            assert.equal(mock.calls[0]?.init.redirect, "manual");
            if (proxy) {
              assert.equal(mock.calls[0]?.init.dispatcher == null, false);
            } else {
              assert.equal(mock.calls[0]?.init.dispatcher, undefined);
            }
            assert.equal(bodyRead(), false);
          } finally {
            mock.restore();
          }
        });
      });
    }

    it(`C-R200-${pathLabel}: non-redirect ${pathLabel} response still returns payload data`, async () => {
      const createExchange = await loadCreateExchange();
      const ex = createMainnetVendor(createExchange);
      const path = "/api/v1/info/markets";
      const env = proxy
        ? { EXTENDED_USE_PROXY: "1", EXTENDED_PROXY: LOOPBACK_PROXY }
        : { EXTENDED_USE_PROXY: "", EXTENDED_PROXY: "" };
      await withEnvAsync(env, async () => {
        const mock = installRedirectAwareFetchMock(
          () =>
            new Response(JSON.stringify({ data: { ok: true, markets: [] } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        );
        try {
          const data = await ex._reqOnce("GET", path);
          assert.deepEqual(data, { ok: true, markets: [] });
          assert.equal(mock.calls.length, 1);
          assert.equal(mock.calls[0]?.init.redirect, "manual");
        } finally {
          mock.restore();
        }
      });
    });
  }

  it("C-R-SAME-ORIGIN: same-origin Location is still not followed", async () => {
    const createExchange = await loadCreateExchange();
    const ex = createMainnetVendor(createExchange);
    const path = "/api/v1/info/markets";
    const sameOrigin = `${EXTENDED_NETWORK_PROFILES.mainnet.restOrigin}/api/v1/user/account/info`;
    const mock = installRedirectAwareFetchMock((url) => {
      if (url === sameOrigin) {
        throw new Error("TEST_REDIRECT_TARGET_CONTACTED");
      }
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 307,
        headers: { Location: sameOrigin },
      });
    });
    try {
      await assert.rejects(() => ex._reqOnce("GET", path), /EXTENDED_ENDPOINT_REDIRECT_FORBIDDEN/);
      assert.equal(mock.calls.length, 1);
      assert.equal(mock.calls[0]?.init.redirect, "manual");
    } finally {
      mock.restore();
    }
  });

  it("C2-DOC: documented DRY_RUN and LIVE_CONFIRM allowlists are exact 0/1 and YES", () => {
    assert.deepEqual([...DRY_RUN_ALLOWED_VALUES], ["0", "1"]);
    assert.deepEqual([...LIVE_CONFIRM_ALLOWED_VALUES], ["YES"]);
    assert.equal(DRY_RUN_TRUE_VALUE, "1");
    assert.equal(DRY_RUN_FALSE_VALUE, "0");
    assert.equal(LIVE_CONFIRM_VALUE, "YES");
  });

  it("C2-DRY-ACC-OFFLINE: accepted DRY_RUN values stay dry-run unless exact 0", () => {
    for (const value of DRY_RUN_ACCEPTED_TRUE) {
      const historical = parseExecutionBoundary(envWithDryRun({ ...OFFLINE_ENV }, value));
      assert.equal(historical.executionTarget, "dry-run", `historical ${JSON.stringify(value)}`);
      assert.equal(historical.dryRun, true, `historical dryRun ${JSON.stringify(value)}`);
      const explicit = parseExecutionBoundary(
        envWithDryRun({ ...OFFLINE_ENV, EXECUTION_MODE: "dry-run" }, value),
      );
      assert.equal(explicit.executionTarget, "dry-run", `explicit ${JSON.stringify(value)}`);
      assert.equal(explicit.dryRun, true, `explicit dryRun ${JSON.stringify(value)}`);
    }
    const liveViaZero = parseExecutionBoundary(envWithDryRun({ ...OFFLINE_ENV }, "0"));
    assert.equal(liveViaZero.executionTarget, "live");
    assert.equal(liveViaZero.dryRun, false);
    expectThrow(
      () => parseExecutionBoundary(envWithDryRun({ ...OFFLINE_ENV, EXECUTION_MODE: "dry-run" }, "0")),
      /EXECUTION_MODE_DRY_RUN_CONFLICT/,
      "C2-DRY-ACC-OFFLINE-explicit-0",
    );
  });

  it("C2-DRY-ACC-SANDBOX: sandbox accepts only exact DRY_RUN=0", () => {
    const ok = parseExecutionBoundary(envWithDryRun({ ...SANDBOX_ENV }, "0"));
    assert.equal(ok.executionTarget, "sandbox");
    assert.equal(ok.dryRun, false);
    for (const value of DRY_RUN_ACCEPTED_TRUE) {
      expectThrow(
        () => parseExecutionBoundary(envWithDryRun({ ...SANDBOX_ENV }, value)),
        /EXECUTION_MODE_DRY_RUN_CONFLICT/,
        `C2-DRY-ACC-SANDBOX-${JSON.stringify(value)}`,
      );
    }
  });

  it("C2-DRY-ACC-LIVE: live accepts exact DRY_RUN=0 and absent DRY_RUN with EXECUTION_MODE=live", () => {
    const liveEnv = { ...V01_LIVE_ENV, EXECUTION_MODE: "live" };
    const exactZero = parseExecutionBoundary(envWithDryRun(liveEnv, "0"));
    assert.equal(exactZero.executionTarget, "live");
    assert.equal(exactZero.dryRun, false);
    const absent = parseExecutionBoundary(envWithDryRun(liveEnv, undefined));
    assert.equal(absent.executionTarget, "live");
    assert.equal(absent.dryRun, false);
    expectThrow(
      () => parseExecutionBoundary(envWithDryRun(liveEnv, "1")),
      /EXECUTION_MODE_DRY_RUN_CONFLICT/,
      "C2-DRY-ACC-LIVE-explicit-1",
    );
  });

  it("C2-DRY-REJ-OFFLINE: rejected DRY_RUN values fail closed and are never live or sandbox", () => {
    for (const value of DRY_RUN_REJECTED_VALUES) {
      expectThrow(
        () => parseExecutionBoundary(envWithDryRun({ ...OFFLINE_ENV }, value)),
        /DRY_RUN_INVALID/,
        `C2-DRY-REJ-OFFLINE-historical-${JSON.stringify(value)}`,
      );
      expectThrow(
        () =>
          parseExecutionBoundary(
            envWithDryRun({ ...OFFLINE_ENV, EXECUTION_MODE: "dry-run" }, value),
          ),
        /DRY_RUN_INVALID/,
        `C2-DRY-REJ-OFFLINE-explicit-${JSON.stringify(value)}`,
      );
    }
  });

  it("C2-DRY-REJ-SANDBOX: rejected DRY_RUN values are not treated as sandbox DRY_RUN=0", () => {
    for (const value of DRY_RUN_REJECTED_VALUES) {
      expectThrow(
        () => parseExecutionBoundary(envWithDryRun({ ...SANDBOX_ENV }, value)),
        /DRY_RUN_INVALID/,
        `C2-DRY-REJ-SANDBOX-${JSON.stringify(value)}`,
      );
    }
  });

  it("C2-DRY-REJ-LIVE: rejected DRY_RUN values are not treated as live DRY_RUN=0", () => {
    const liveEnv = { ...V01_LIVE_ENV, EXECUTION_MODE: "live" };
    for (const value of DRY_RUN_REJECTED_VALUES) {
      expectThrow(
        () => parseExecutionBoundary(envWithDryRun(liveEnv, value)),
        /DRY_RUN_INVALID/,
        `C2-DRY-REJ-LIVE-${JSON.stringify(value)}`,
      );
    }
  });

  it("C2-LIVE-CONFIRM: LIVE_CONFIRM accepts only exact YES", () => {
    const dryYes = parseExecutionBoundary({ ...OFFLINE_ENV, DRY_RUN: "1", LIVE_CONFIRM: "YES" });
    assert.equal(dryYes.executionTarget, "dry-run");
    assert.equal(dryYes.liveConfirm, true);
    const dryAbsent = parseExecutionBoundary({ ...OFFLINE_ENV, DRY_RUN: "1", LIVE_CONFIRM: "" });
    assert.equal(dryAbsent.liveConfirm, false);
    const liveYes = parseExecutionBoundary({ ...V01_LIVE_ENV, EXECUTION_MODE: "live" });
    assert.equal(liveYes.liveConfirm, true);
    expectThrow(
      () => parseExecutionBoundary({ ...SANDBOX_ENV, LIVE_CONFIRM: "YES" }),
      /EXECUTION_CONFIRMATION_CONFLICT/,
      "C2-LIVE-CONFIRM-sandbox-YES",
    );
    for (const value of LIVE_CONFIRM_REJECTED_VALUES) {
      expectThrow(
        () => parseExecutionBoundary({ ...OFFLINE_ENV, DRY_RUN: "1", LIVE_CONFIRM: value }),
        /LIVE_CONFIRM_INVALID/,
        `C2-LIVE-CONFIRM-offline-${JSON.stringify(value)}`,
      );
      expectThrow(
        () => parseExecutionBoundary({ ...SANDBOX_ENV, LIVE_CONFIRM: value }),
        /LIVE_CONFIRM_INVALID/,
        `C2-LIVE-CONFIRM-sandbox-${JSON.stringify(value)}`,
      );
      expectThrow(
        () =>
          parseExecutionBoundary({
            ...V01_LIVE_ENV,
            EXECUTION_MODE: "live",
            LIVE_CONFIRM: value,
          }),
        /LIVE_CONFIRM_INVALID/,
        `C2-LIVE-CONFIRM-live-${JSON.stringify(value)}`,
      );
    }
  });

  it("C2-PATH: invalid DRY_RUN fails closed on every execution path before connect or write", async () => {
    const samples = ["banana", "FALSEE", "TRUE", "00", "yesplease"] as const;
    for (const value of samples) {
      const offline = envWithDryRun({ ...OFFLINE_ENV }, value);
      const sandbox = envWithDryRun({ ...SANDBOX_ENV }, value);
      const live = envWithDryRun({ ...V01_LIVE_ENV, EXECUTION_MODE: "live" }, value);
      for (const [label, env] of [
        ["offline", offline],
        ["sandbox", sandbox],
        ["live", live],
      ] as const) {
        expectThrow(
          () => parseExecutionBoundary(env),
          /DRY_RUN_INVALID/,
          `C2-PATH-parse-${label}-${value}`,
        );
        await withEnvAsync(env, async () => {
          expectThrow(() => loadRuntimeConfig(), /DRY_RUN_INVALID/, `C2-PATH-cfg-${label}-${value}`);
          const loop = trackingLoopBindings();
          await assert.rejects(() => runLoop(loop.bindings), /DRY_RUN_INVALID/);
          assert.equal(loop.calls.includes("create"), false, `loop create ${label} ${value}`);
          assert.equal(loop.calls.includes("connect"), false, `loop connect ${label} ${value}`);
          assert.equal(loop.calls.includes("stats"), false, `loop stats ${label} ${value}`);
          const status = trackingLoopBindings();
          await assert.rejects(() => runStatus(status.bindings), /DRY_RUN_INVALID/);
          assert.equal(status.calls.includes("create"), false, `status create ${label} ${value}`);
          const flat = trackingLoopBindings();
          await assert.rejects(() => runFlat(flat.bindings), /DRY_RUN_INVALID/);
          assert.equal(flat.calls.includes("create"), false, `flat create ${label} ${value}`);
          const ex = new ExtendedExecutor(false);
          await assert.rejects(() => ex.connect(), /DRY_RUN_INVALID/);
        });
      }
    }
    assert.equal(TESTNET_NETWORK_WRITE_AUTHORIZED, false);
    assert.equal(MAINNET_NETWORK_WRITE_AUTHORIZED, false);
    expectThrow(() => assertSandboxWriteAllowed(), /TESTNET_NETWORK_WRITE_UNAUTHORIZED/, "C2-PATH-write");
  });

  it("C2-PATH-VENDOR: Sepolia vendor init stays unauthorized even after a config parse failure", async () => {
    await withEnvAsync({ ...SANDBOX_ENV, DRY_RUN: "banana" }, async () => {
      expectThrow(() => parseExecutionBoundary(), /DRY_RUN_INVALID/, "C2-PATH-VENDOR-parse");
      const createExchange = await loadCreateExchange();
      const sepolia = EXTENDED_NETWORK_PROFILES.sepolia;
      const ex = createExchange({
        apiKey: PLACEHOLDER_TESTNET_KEY,
        vault: 1,
        starkPrivateKey: "0x1",
        ...vendorProfileArgs(sepolia),
      });
      await assert.rejects(() => ex.init(), /TESTNET_NETWORK_WRITE_UNAUTHORIZED/);
      await assert.rejects(
        () => ex._reqOnce("GET", "/api/v1/info/markets"),
        /TESTNET_NETWORK_WRITE_UNAUTHORIZED/,
      );
    });
  });

  it("C2-PATH-STATS: official Extended fetch returns empty on parse failure before createExchange", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/officialStats.ts"), "utf8");
    const start = src.indexOf("async function fetchExtended");
    const end = src.indexOf("async function fetchRisex");
    const body = src.slice(start, end);
    const catchEmpty = body.indexOf('return empty("extended"');
    const create = body.indexOf("createExchange");
    assert.equal(start >= 0 && end > start, true);
    assert.equal(catchEmpty >= 0 && create >= 0 && catchEmpty < create, true);
    expectThrow(
      () => parseExecutionBoundary(envWithDryRun({ ...OFFLINE_ENV }, "banana")),
      /DRY_RUN_INVALID/,
      "C2-PATH-STATS-parse",
    );
  });
});
