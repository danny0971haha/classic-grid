/**
 * Run the v0.1 grid profile over downloaded Extended data (see fetch-extended.ts).
 *
 *   node --import tsx tools/backtest/grid-backtest.ts [--market BTC-USD]
 *
 * Scenario matrix: strategy (bot | classic) x fees x mode
 * - fees "published": maker 0, taker 0.025% (third-party summary, unverified)
 * - fees "repo":      maker = taker = 0.05% (src/config.ts feeRate assumption)
 * - mode "strict":    v0.1 limits, stops for good at 5U drawdown from start
 * - mode "long-run":  no drawdown stop; daily-loss pauses to next UTC day, boundary re-anchors
 *
 * haltPnl = realized PnL minus taker fee of the forced market close at each halt.
 */
import fs from "node:fs";
import path from "node:path";
import { simulate, V01_PROFILE, type Candle, type FundingRow, type SimConfig, type SimResult, type Strategy } from "./grid-sim.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const market = arg("market", "BTC-USD");
const dir = path.join("data", "backtest");
const candles = JSON.parse(fs.readFileSync(path.join(dir, `${market}-1m.json`), "utf8")) as Candle[];
const funding = JSON.parse(fs.readFileSync(path.join(dir, `${market}-funding.json`), "utf8")) as FundingRow[];

const FEES = {
  published: { makerFee: 0, takerFee: 0.00025 },
  repo: { makerFee: 0.0005, takerFee: 0.0005 },
} as const;
const MODES = {
  strict: { maxDrawdownUsd: V01_PROFILE.maxDrawdownUsd },
  "long-run": { maxDrawdownUsd: null },
} as const;

const iso = (t: number): string => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const usd = (n: number): string => (n >= 0 ? "+" : "") + n.toFixed(2);

const first = candles[0]!;
const last = candles[candles.length - 1]!;
console.log(`${market} ${iso(first.t)} -> ${iso(last.t)} UTC, ${candles.length} 1m candles, ${funding.length} funding rows`);
console.log(`price ${first.o} -> ${last.c} (${usd(((last.c - first.o) / first.o) * 100)}%)\n`);

const rows: Array<{ name: string; res: SimResult }> = [];
for (const mode of Object.keys(MODES) as Array<keyof typeof MODES>) {
  for (const fee of Object.keys(FEES) as Array<keyof typeof FEES>) {
    for (const strategy of ["bot", "classic"] as Strategy[]) {
      const cfg: SimConfig = { ...V01_PROFILE, strategy, ...FEES[fee], ...MODES[mode] };
      rows.push({ name: `${mode}/${fee}/${strategy}`, res: simulate(candles, funding, cfg) });
    }
  }
}

console.log(
  [
    "scenario".padEnd(26),
    "net".padStart(8),
    "realized".padStart(9),
    "fees".padStart(7),
    "funding".padStart(8),
    "haltPnl".padStart(8),
    "maxDD".padStart(7),
    "minEq".padStart(6),
    "fills".padStart(6),
    "anchors".padStart(8),
    "capEv".padStart(6),
    "halts(boundary/daily/dd/notional)".padStart(34),
    "  stopped",
  ].join(" ")
);
for (const { name, res } of rows) {
  const count = (reason: string): number => res.halts.filter((h) => h.reasons.includes(reason)).length;
  console.log(
    [
      name.padEnd(26),
      usd(res.endEquity - res.startEquity).padStart(8),
      usd(res.realizedUsd).padStart(9),
      res.feesUsd.toFixed(2).padStart(7),
      usd(res.fundingUsd).padStart(8),
      usd(res.halts.reduce((s, h) => s + h.closePnlUsd, 0)).padStart(8),
      res.maxDrawdownUsd.toFixed(2).padStart(7),
      res.minEquity.toFixed(1).padStart(6),
      String(res.fills).padStart(6),
      String(res.anchors).padStart(8),
      String(res.notionalCapEvents).padStart(6),
      `${count("RISK_BOUNDARY_BREACH")}/${count("DAILY_LOSS")}/${count("DRAWDOWN_FROM_START")}/${count("ACTUAL_NOTIONAL_CAP")}`.padStart(34),
      "  " + (res.stoppedAt != null ? iso(res.stoppedAt) : "-"),
    ].join(" ")
  );
}

console.log("\nlong-run month-end equity (start 50):");
const longRun = rows.filter((r) => r.name.startsWith("long-run/"));
console.log("month".padEnd(8) + longRun.map((r) => r.name.slice("long-run/".length).padStart(18)).join(""));
for (const { month } of longRun[0]!.res.equityByMonth) {
  const cells = longRun.map((r) => (r.res.equityByMonth.find((m) => m.month === month)?.equity ?? NaN).toFixed(2).padStart(18));
  console.log(month.padEnd(8) + cells.join(""));
}
