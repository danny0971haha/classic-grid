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
  EXTENDED_NETWORK_PROFILES,
  TESTNET_NETWORK_WRITE_AUTHORIZED,
  MAINNET_NETWORK_WRITE_AUTHORIZED,
  assertSameOriginResponse,
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
import { ExtendedExecutor } from "../src/venues/extended.js";
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

function mixedProfile(overrides: Partial<ExtendedNetworkProfile>): ExtendedNetworkProfile {
  return { ...EXTENDED_NETWORK_PROFILES.sepolia, ...overrides };
}

function expectThrow(fn: () => unknown, pattern: RegExp, label: string): void {
  assert.throws(fn, pattern, label);
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

  it("rejects plaintext, embedded credentials, unexpected ports, and cross-host redirects", () => {
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
    expectThrow(
      () =>
        assertSameOriginResponse(
          "https://api.starknet.sepolia.extended.exchange/api/v1/info/markets",
          "https://api.starknet.extended.exchange/api/v1/info/markets",
        ),
      /EXTENDED_ENDPOINT_REDIRECT_HOST/,
      "redirect",
    );
  });

  it("vendor no longer unconditionally assigns mainnet network/domain", async () => {
    const vendor = fs.readFileSync(path.join(ROOT, "vendor/extended/exchange/extended.js"), "utf8");
    assert.equal(vendor.includes("this.network = 'mainnet'"), false);
    assert.equal(vendor.includes("this.domain = DOMAINS.mainnet"), false);
    const sepolia = EXTENDED_NETWORK_PROFILES.sepolia;
    const href = pathToFileURL(path.join(ROOT, "vendor/extended/exchange/index.js")).href;
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
});
