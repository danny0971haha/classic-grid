const TRACKED = [
  "DRY_RUN",
  "LIVE_CONFIRM",
  "EXPERIMENT_MODE",
  "EXPERIMENT_ID",
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
  "VENUES",
  "MARKETS",
  "COMMIT_SHA",
] as const;

export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of TRACKED) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of TRACKED) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function withEnvAsync<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of TRACKED) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of TRACKED) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
