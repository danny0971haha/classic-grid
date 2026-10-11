/**
 * Download public Extended mainnet 1m candles and hourly funding (no auth, read-only).
 *
 *   node --import tsx tools/backtest/fetch-extended.ts [--days 180] [--market BTC-USD]
 *
 * Writes data/backtest/<market>-1m.json and data/backtest/<market>-funding.json (gitignored).
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "https://api.starknet.extended.exchange/api/v1/info";
const CANDLE_PAGE = 2800; // server max per call
const MINUTE = 60_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function getJson(url: string): Promise<{ status: string; data: Array<Record<string, string | number>> }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status: string; data: Array<Record<string, string | number>> };
      if (body.status !== "OK" || !Array.isArray(body.data)) throw new Error(`bad body status=${body.status}`);
      return body;
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function main(): Promise<void> {
  const market = arg("market", "BTC-USD");
  const days = Number(arg("days", "180"));
  const outDir = path.join("data", "backtest");
  fs.mkdirSync(outDir, { recursive: true });
  const now = Math.floor(Date.now() / MINUTE) * MINUTE;
  const start = now - days * 86_400_000;

  const candles = new Map<number, { t: number; o: number; h: number; l: number; c: number }>();
  let end = now;
  while (end > start) {
    const body = await getJson(`${BASE}/candles/${market}/trades?interval=PT1M&limit=${CANDLE_PAGE}&endTime=${end}`);
    if (body.data.length === 0) break;
    let oldest = end;
    for (const row of body.data) {
      const t = Number(row.T);
      oldest = Math.min(oldest, t);
      if (t < start) continue;
      candles.set(t, { t, o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c) });
    }
    if (oldest >= end) break;
    end = oldest - 1;
    process.stdout.write(`\rcandles ${candles.size} back to ${new Date(oldest).toISOString()}`);
  }
  const candleRows = [...candles.values()].sort((a, b) => a.t - b.t);
  fs.writeFileSync(path.join(outDir, `${market}-1m.json`), JSON.stringify(candleRows));
  console.log(`\nwrote ${candleRows.length} candles`);

  const funding = new Map<number, number>();
  end = now;
  while (end > start) {
    const body = await getJson(`${BASE}/${market}/funding?startTime=${start}&endTime=${end}`);
    if (body.data.length === 0) break;
    let oldest = end;
    for (const row of body.data) {
      const t = Number(row.T);
      oldest = Math.min(oldest, t);
      if (t >= start) funding.set(t, Number(row.f));
    }
    if (oldest >= end) break;
    end = oldest - 1;
  }
  const fundingRows = [...funding.entries()].map(([t, rate]) => ({ t, rate })).sort((a, b) => a.t - b.t);
  fs.writeFileSync(path.join(outDir, `${market}-funding.json`), JSON.stringify(fundingRows));
  console.log(`wrote ${fundingRows.length} funding rows`);
}

await main();
