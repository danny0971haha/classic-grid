const TRACKED = [
  "DRY_RUN",
  "LIVE_CONFIRM",
  "EXECUTION_MODE",
  "EXTENDED_NETWORK",
  "SANDBOX_CONFIRM",
  "EXTENDED_API_URL",
  "EXTENDED_USE_PROXY",
  "EXTENDED_PROXY",
  "EXTENDED_API_KEY",
  "EXTENDED_STARK_PRIVATE_KEY",
  "EXTENDED_STARK_PUBLIC_KEY",
  "EXTENDED_VAULT",
  "EXTENDED_VAULT_ID",
  "EXTENDED_TESTNET_API_KEY",
  "EXTENDED_TESTNET_STARK_PRIVATE_KEY",
  "EXTENDED_TESTNET_STARK_PUBLIC_KEY",
  "EXTENDED_TESTNET_VAULT_ID",
  "EXPERIMENT_MODE",
  "EXPERIMENT_SPEC_VERSION",
  "EXPERIMENT_ID",
  "EXPERIMENT_ACCOUNT_SCOPE",
  "EXPERIMENT_CAPITAL_USD",
  "EXPERIMENT_LEVERAGE",
  "EXPERIMENT_MARGIN_FRAC",
  "EXPERIMENT_GRID_COUNT",
  "EXPERIMENT_HALF_BAND_PCT",
  "EXPERIMENT_MAX_GROSS_NOTIONAL_USD",
  "EXPERIMENT_DAILY_LOSS_USD",
  "EXPERIMENT_MAX_DRAWDOWN_USD",
  "EXPERIMENT_BOUNDARY_BUFFER_PCT",
  "EXPERIMENT_HALT_ACK",
  "GRID_LEVERAGE",
  "GRID_MARGIN_FRAC",
  "GRID_HALF_BAND",
  "EXTENDED_LEVERAGE",
  "RISEX_LEVERAGE",
  "RISE_LEVERAGE",
  "PHOENIX_LEVERAGE",
  "PHOENIX2_LEVERAGE",
  "DECIBEL_LEVERAGE",
  "N1_LEVERAGE",
  "NADO_LEVERAGE",
  "POPDEX_LEVERAGE",
  "POPDEX_EQUITY_USD",
  "POPDEX_GRID_COUNT",
  "DECIBEL_EQUITY_USD",
  "N1_EQUITY_USD",
  "SOFT_RESUME",
  "TICK_MS",
  "VENUES",
  "MARKETS",
  "COMMIT_SHA",
] as const;

function restoreKeys(
  keys: readonly string[],
  prev: Record<string, string | undefined>
): void {
  for (const key of keys) {
    const value = prev[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const keys = [...new Set([...TRACKED, ...Object.keys(vars)])];
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    restoreKeys(keys, prev);
  }
}

export async function withEnvAsync<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const keys = [...new Set([...TRACKED, ...Object.keys(vars)])];
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    restoreKeys(keys, prev);
  }
}
