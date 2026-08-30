/**
 * Classic v0.2 R2-A Extended network / execution-target boundary.
 * Offline configuration only. This module does not contact Extended,
 * load production credentials, or authorize testnet or mainnet writes.
 */

export const TESTNET_NETWORK_WRITE_AUTHORIZED = false as const;
export const MAINNET_NETWORK_WRITE_AUTHORIZED = false as const;

export const SANDBOX_CONFIRM_VALUE = "EXTENDED_SEPOLIA_TEST_ONLY" as const;

export type ExecutionTarget = "dry-run" | "sandbox" | "live";
export type ExtendedNetworkId = "mainnet" | "sepolia";

export type ExtendedNetworkProfile = {
  network: ExtendedNetworkId;
  restOrigin: string;
  restApiPrefix: "/api/v1";
  websocketBase: string;
  signingDomain: string;
  chainId: "SN_MAIN" | "SN_SEPOLIA";
  snip12Name: "Perpetuals";
  snip12Version: "v0";
  snip12Revision: 1;
};

export const EXTENDED_NETWORK_PROFILES: Record<ExtendedNetworkId, ExtendedNetworkProfile> = Object.freeze({
  mainnet: Object.freeze({
    network: "mainnet",
    restOrigin: "https://api.starknet.extended.exchange",
    restApiPrefix: "/api/v1",
    websocketBase: "wss://api.starknet.extended.exchange/stream.extended.exchange/v1",
    signingDomain: "extended.exchange",
    chainId: "SN_MAIN",
    snip12Name: "Perpetuals",
    snip12Version: "v0",
    snip12Revision: 1,
  }),
  sepolia: Object.freeze({
    network: "sepolia",
    restOrigin: "https://api.starknet.sepolia.extended.exchange",
    restApiPrefix: "/api/v1",
    websocketBase: "wss://starknet.sepolia.extended.exchange/stream.extended.exchange/v1",
    signingDomain: "starknet.sepolia.extended.exchange",
    chainId: "SN_SEPOLIA",
    snip12Name: "Perpetuals",
    snip12Version: "v0",
    snip12Revision: 1,
  }),
});

export const MAINNET_CREDENTIAL_ENV = [
  "EXTENDED_API_KEY",
  "EXTENDED_STARK_PRIVATE_KEY",
  "EXTENDED_STARK_PUBLIC_KEY",
  "EXTENDED_VAULT",
  "EXTENDED_VAULT_ID",
] as const;

export const TESTNET_CREDENTIAL_ENV = [
  "EXTENDED_TESTNET_API_KEY",
  "EXTENDED_TESTNET_STARK_PRIVATE_KEY",
  "EXTENDED_TESTNET_STARK_PUBLIC_KEY",
  "EXTENDED_TESTNET_VAULT_ID",
] as const;

export const NETWORK_SCOPE_TOKEN = {
  mainnet: "extended-net-mainnet",
  sepolia: "extended-net-sepolia",
} as const;

export type ParsedEndpoint = {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
};

export type ExecutionBoundary = {
  executionTarget: ExecutionTarget;
  dryRun: boolean;
  liveConfirm: boolean;
  sandboxConfirm: boolean;
  extendedNetwork: ExtendedNetworkId | null;
  extendedNetworkExplicit: boolean;
  profile: ExtendedNetworkProfile | null;
};

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes", "YES"].includes(String(v || "").trim());
}

function present(env: NodeJS.ProcessEnv, key: string): boolean {
  return String(env[key] ?? "").trim() !== "";
}

function envNamesPresent(env: NodeJS.ProcessEnv, keys: readonly string[]): string[] {
  return keys.filter((key) => present(env, key));
}

export function parseAbsoluteEndpoint(raw: string, expectedProtocol: "https:" | "wss:"): ParsedEndpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("EXTENDED_ENDPOINT_UNPARSEABLE");
  }
  if (url.protocol === "http:" || url.protocol === "ws:") {
    throw new Error("EXTENDED_ENDPOINT_PLAINTEXT");
  }
  if (url.protocol !== expectedProtocol) {
    throw new Error("EXTENDED_ENDPOINT_PROTOCOL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("EXTENDED_ENDPOINT_EMBEDDED_CREDENTIAL");
  }
  if (url.port !== "") {
    throw new Error("EXTENDED_ENDPOINT_UNEXPECTED_PORT");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("EXTENDED_ENDPOINT_UNEXPECTED_COMPONENT");
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    pathname,
  };
}

export function endpointsEqual(left: ParsedEndpoint, right: ParsedEndpoint): boolean {
  return (
    left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.port === right.port &&
    left.pathname === right.pathname
  );
}

export function assertAtomicExtendedProfile(profile: ExtendedNetworkProfile): void {
  const frozen = EXTENDED_NETWORK_PROFILES[profile.network];
  if (!frozen) throw new Error("EXTENDED_NETWORK_PROFILE_REQUIRED");
  if (
    profile.restOrigin !== frozen.restOrigin ||
    profile.restApiPrefix !== frozen.restApiPrefix ||
    profile.websocketBase !== frozen.websocketBase ||
    profile.signingDomain !== frozen.signingDomain ||
    profile.chainId !== frozen.chainId ||
    profile.snip12Name !== frozen.snip12Name ||
    profile.snip12Version !== frozen.snip12Version ||
    profile.snip12Revision !== frozen.snip12Revision
  ) {
    throw new Error("EXTENDED_PROFILE_MIXED");
  }
  parseAbsoluteEndpoint(profile.restOrigin, "https:");
  parseAbsoluteEndpoint(profile.websocketBase, "wss:");
}

export function qualifySandboxNetworkProfile(profile: ExtendedNetworkProfile): void {
  const rest = parseAbsoluteEndpoint(profile.restOrigin, "https:");
  const ws = parseAbsoluteEndpoint(profile.websocketBase, "wss:");
  const mainRest = parseAbsoluteEndpoint(EXTENDED_NETWORK_PROFILES.mainnet.restOrigin, "https:");
  const mainWs = parseAbsoluteEndpoint(EXTENDED_NETWORK_PROFILES.mainnet.websocketBase, "wss:");
  if (endpointsEqual(rest, mainRest)) throw new Error("EXTENDED_SANDBOX_MAINNET_REST");
  if (endpointsEqual(ws, mainWs)) throw new Error("EXTENDED_SANDBOX_MAINNET_WS");
  if (profile.chainId === "SN_MAIN") throw new Error("EXTENDED_SANDBOX_SN_MAIN");
  if (profile.signingDomain === EXTENDED_NETWORK_PROFILES.mainnet.signingDomain) {
    throw new Error("EXTENDED_SANDBOX_MAINNET_SIGNING_DOMAIN");
  }
  if (profile.network !== "sepolia") throw new Error("EXTENDED_SANDBOX_MAINNET_PROFILE");
  assertAtomicExtendedProfile(profile);
}

export function vendorRequestUrl(restOrigin: string, vendorPath: string): string {
  const origin = parseAbsoluteEndpoint(restOrigin, "https:");
  if (origin.pathname !== "/") throw new Error("EXTENDED_REST_PREFIX_DOUBLE");
  if (!vendorPath.startsWith("/api/v1/")) throw new Error("EXTENDED_REST_PATH");
  if (vendorPath.includes("/api/v1/api/v1")) throw new Error("EXTENDED_REST_PREFIX_DOUBLE");
  return `${restOrigin.replace(/\/$/, "")}${vendorPath}`;
}

export function effectiveRestUrl(profile: ExtendedNetworkProfile, resourcePath: string): string {
  assertAtomicExtendedProfile(profile);
  const resource = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  if (resource === profile.restApiPrefix || resource.startsWith(`${profile.restApiPrefix}/`)) {
    throw new Error("EXTENDED_REST_PREFIX_DOUBLE");
  }
  return vendorRequestUrl(profile.restOrigin, `${profile.restApiPrefix}${resource}`);
}

export function effectiveWebsocketUrl(profile: ExtendedNetworkProfile, channel = "account"): string {
  assertAtomicExtendedProfile(profile);
  const suffix = channel.replace(/^\//, "");
  return `${profile.websocketBase.replace(/\/$/, "")}/${suffix}`;
}

/** Not the production redirect control. Vendor `_reqOnce` rejects all HTTP redirects. */
export function assertSameOriginResponse(requestUrl: string, responseUrl: string): void {
  const request = new URL(requestUrl);
  const response = new URL(responseUrl);
  if (
    request.protocol !== response.protocol ||
    request.hostname !== response.hostname ||
    request.port !== response.port
  ) {
    throw new Error("EXTENDED_ENDPOINT_REDIRECT_HOST");
  }
}

export function assertCredentialSeparation(target: ExecutionTarget, env: NodeJS.ProcessEnv = process.env): void {
  const mainnetKeys = envNamesPresent(env, MAINNET_CREDENTIAL_ENV);
  const testnetKeys = envNamesPresent(env, TESTNET_CREDENTIAL_ENV);
  if (target === "sandbox") {
    if (mainnetKeys.length > 0 && testnetKeys.length > 0) {
      throw new Error("EXTENDED_SANDBOX_CREDENTIAL_MIXED");
    }
    if (mainnetKeys.length > 0) {
      throw new Error("EXTENDED_SANDBOX_MAINNET_CREDENTIAL_FORBIDDEN");
    }
    return;
  }
  if (target === "live" && testnetKeys.length > 0) {
    throw new Error("EXTENDED_LIVE_TESTNET_CREDENTIAL_FORBIDDEN");
  }
}

function sandboxProxyForbidden(env: NodeJS.ProcessEnv): boolean {
  return (
    /^(1|true|yes)$/i.test(String(env.EXTENDED_USE_PROXY || "").trim()) ||
    String(env.EXTENDED_PROXY ?? "").trim() !== ""
  );
}

export function parseExecutionBoundary(env: NodeJS.ProcessEnv = process.env): ExecutionBoundary {
  const executionModeRaw = String(env.EXECUTION_MODE ?? "").trim();
  const networkRaw = String(env.EXTENDED_NETWORK ?? "").trim();
  const sandboxConfirmRaw = String(env.SANDBOX_CONFIRM ?? "").trim();
  const liveConfirmRaw = String(env.LIVE_CONFIRM ?? "").trim();
  const dryRaw = env.DRY_RUN;
  const apiUrlRaw = String(env.EXTENDED_API_URL ?? "").trim();

  if (
    executionModeRaw !== "" &&
    executionModeRaw !== "dry-run" &&
    executionModeRaw !== "sandbox" &&
    executionModeRaw !== "live"
  ) {
    throw new Error("EXECUTION_MODE_UNSUPPORTED");
  }
  if (networkRaw !== "" && networkRaw !== "mainnet" && networkRaw !== "sepolia") {
    throw new Error("EXTENDED_NETWORK_UNSUPPORTED");
  }
  if (sandboxConfirmRaw !== "" && sandboxConfirmRaw !== SANDBOX_CONFIRM_VALUE) {
    throw new Error("SANDBOX_CONFIRM_INVALID");
  }

  const sandboxConfirm = sandboxConfirmRaw === SANDBOX_CONFIRM_VALUE;
  const sandboxConfirmPresent = sandboxConfirmRaw !== "";
  const liveConfirmPresent = liveConfirmRaw !== "";
  const liveConfirm = truthy(liveConfirmRaw);
  const historicalDryRun =
    dryRaw == null || String(dryRaw).trim() === "" ? true : truthy(String(dryRaw));

  if (liveConfirmPresent && sandboxConfirmPresent) {
    throw new Error("EXECUTION_CONFIRMATION_CONFLICT");
  }

  let executionTarget: ExecutionTarget;
  if (executionModeRaw === "sandbox") executionTarget = "sandbox";
  else if (executionModeRaw === "live") executionTarget = "live";
  else if (executionModeRaw === "dry-run") executionTarget = "dry-run";
  else executionTarget = historicalDryRun ? "dry-run" : "live";

  if (executionTarget === "sandbox") {
    const dryExplicitTrue =
      dryRaw != null && String(dryRaw).trim() !== "" && truthy(String(dryRaw));
    const dryExplicitFalse =
      dryRaw != null && String(dryRaw).trim() !== "" && !truthy(String(dryRaw));
    if (dryExplicitTrue || !dryExplicitFalse) {
      throw new Error("EXECUTION_MODE_DRY_RUN_CONFLICT");
    }
    if (liveConfirmPresent) throw new Error("EXECUTION_CONFIRMATION_CONFLICT");
    if (!sandboxConfirm) throw new Error("SANDBOX_CONFIRM_INVALID");
    if (networkRaw === "") throw new Error("EXTENDED_NETWORK_REQUIRED");
    if (networkRaw !== "sepolia") throw new Error("EXTENDED_SANDBOX_MAINNET_PROFILE");
    if (sandboxProxyForbidden(env)) throw new Error("EXTENDED_SANDBOX_PROXY_FORBIDDEN");
    if (apiUrlRaw !== "") throw new Error("EXTENDED_SANDBOX_CUSTOM_ENDPOINT_FORBIDDEN");
    assertCredentialSeparation("sandbox", env);
    const profile = EXTENDED_NETWORK_PROFILES.sepolia;
    qualifySandboxNetworkProfile(profile);
    return {
      executionTarget: "sandbox",
      dryRun: false,
      liveConfirm: false,
      sandboxConfirm: true,
      extendedNetwork: "sepolia",
      extendedNetworkExplicit: true,
      profile,
    };
  }

  if (executionTarget === "live") {
    const dryExplicitTrue =
      dryRaw != null && String(dryRaw).trim() !== "" && truthy(String(dryRaw));
    if (executionModeRaw === "live" && dryExplicitTrue) {
      throw new Error("EXECUTION_MODE_DRY_RUN_CONFLICT");
    }
    if (sandboxConfirmPresent) throw new Error("EXECUTION_CONFIRMATION_CONFLICT");
    if (networkRaw === "sepolia") throw new Error("EXTENDED_LIVE_SEPOLIA_FORBIDDEN");
    assertCredentialSeparation("live", env);
    const profile = EXTENDED_NETWORK_PROFILES.mainnet;
    if (apiUrlRaw !== "") {
      const got = parseAbsoluteEndpoint(apiUrlRaw.replace(/\/$/, ""), "https:");
      const expected = parseAbsoluteEndpoint(profile.restOrigin, "https:");
      if (!endpointsEqual(got, expected)) throw new Error("EXTENDED_PROFILE_MIXED");
    }
    assertAtomicExtendedProfile(profile);
    return {
      executionTarget: "live",
      dryRun: false,
      liveConfirm,
      sandboxConfirm: false,
      extendedNetwork: "mainnet",
      extendedNetworkExplicit: networkRaw === "mainnet",
      profile,
    };
  }

  const dryExplicitFalse =
    dryRaw != null && String(dryRaw).trim() !== "" && !truthy(String(dryRaw));
  if (executionModeRaw === "dry-run" && dryExplicitFalse) {
    throw new Error("EXECUTION_MODE_DRY_RUN_CONFLICT");
  }
  if (sandboxConfirmPresent) throw new Error("EXECUTION_CONFIRMATION_CONFLICT");
  if (networkRaw !== "") throw new Error("EXTENDED_NETWORK_DRY_RUN_FORBIDDEN");
  return {
    executionTarget: "dry-run",
    dryRun: true,
    liveConfirm,
    sandboxConfirm: false,
    extendedNetwork: null,
    extendedNetworkExplicit: false,
    profile: null,
  };
}

export function networkIdentityForBinding(p: {
  executionTarget: ExecutionTarget;
  extendedNetwork: ExtendedNetworkId | null;
  extendedNetworkExplicit: boolean;
}): ExtendedNetworkId | null {
  if (p.executionTarget === "sandbox") return "sepolia";
  if (p.extendedNetworkExplicit) return p.extendedNetwork;
  return null;
}

export function bindNetworkScopeKey(baseScopeKey: string, network: ExtendedNetworkId | null): string {
  if (network == null) return baseScopeKey;
  if (baseScopeKey.includes("#extended-net-")) {
    throw new Error("EXTENDED_NETWORK_SCOPE_ALREADY_BOUND");
  }
  return `${baseScopeKey}#${NETWORK_SCOPE_TOKEN[network]}`;
}

export function parseBoundNetwork(scopeKey: string): ExtendedNetworkId | null {
  if (scopeKey.endsWith(`#${NETWORK_SCOPE_TOKEN.sepolia}`)) return "sepolia";
  if (scopeKey.endsWith(`#${NETWORK_SCOPE_TOKEN.mainnet}`)) return "mainnet";
  return null;
}

export function assertStateNetworkIdentity(scopeKey: string, expected: ExtendedNetworkId): void {
  const found = parseBoundNetwork(scopeKey);
  if (found == null) throw new Error("EXTENDED_NETWORK_IDENTITY_MISSING");
  if (found !== expected) throw new Error("EXTENDED_NETWORK_STATE_MISMATCH");
}

export function assertSandboxWriteAllowed(): never {
  throw new Error("TESTNET_NETWORK_WRITE_UNAUTHORIZED");
}

export function formatExtendedBoundaryDiagnostics(boundary: ExecutionBoundary): string {
  return [
    `executionTarget=${boundary.executionTarget}`,
    `extendedNetwork=${boundary.extendedNetwork ?? "unset"}`,
    `extendedNetworkExplicit=${boundary.extendedNetworkExplicit ? "yes" : "no"}`,
    `sandboxConfirm=${boundary.sandboxConfirm ? "yes" : "no"}`,
    `liveConfirm=${boundary.liveConfirm ? "yes" : "no"}`,
    `dryRun=${boundary.dryRun ? "yes" : "no"}`,
    `restOrigin=${boundary.profile?.restOrigin ?? "unset"}`,
    `websocketBase=${boundary.profile?.websocketBase ?? "unset"}`,
    `signingDomain=${boundary.profile?.signingDomain ?? "unset"}`,
    `chainId=${boundary.profile?.chainId ?? "unset"}`,
    `testnetWriteAuthorized=${TESTNET_NETWORK_WRITE_AUTHORIZED ? "yes" : "no"}`,
    `mainnetWriteAuthorized=${MAINNET_NETWORK_WRITE_AUTHORIZED ? "yes" : "no"}`,
  ].join("\n");
}

export function createExchangeProfileArgs(profile: ExtendedNetworkProfile): {
  apiUrl: string;
  network: ExtendedNetworkId;
  chainId: ExtendedNetworkProfile["chainId"];
  signingDomain: string;
  websocketBase: string;
} {
  assertAtomicExtendedProfile(profile);
  return {
    apiUrl: profile.restOrigin,
    network: profile.network,
    chainId: profile.chainId,
    signingDomain: profile.signingDomain,
    websocketBase: profile.websocketBase,
  };
}
