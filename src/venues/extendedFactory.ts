import type { VenueId } from "../types.js";
import { ExtendedExecutor } from "./extended.js";
import {
  CANARY_PROFILE_VENUE,
  canaryVenueUnavailableError,
  type ExecutorFactory,
} from "./factory.js";
import type { VenueExecutor } from "./types.js";

type CanaryOfficialDay = {
  venue: VenueId;
  ok: false;
  source: "unavailable";
  volume: null;
  fees: null;
  realizedPnl: null;
  fills: null;
  closeFills: null;
  feeMaker: null;
  feeTaker: null;
  note: string;
  updatedAt: string;
};

type CanaryOfficialBundle = {
  dayKey: string;
  dayStartMs: number;
  venues: Record<VenueId, CanaryOfficialDay>;
  updatedAt: string;
};

const CANARY_VENUE_IDS: VenueId[] = [
  "extended",
  "risex",
  "decibel",
  "n1",
  "phoenix",
  "phoenix2",
  "nado",
  "popdex",
];

export function parseCanaryVenues(raw: string | undefined): string[] {
  return String(raw ?? CANARY_PROFILE_VENUE)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function assertCanaryVenueSelection(
  raw: string | undefined = process.env.VENUES,
): string[] {
  const venues = parseCanaryVenues(raw);
  if (venues.length === 0) throw canaryVenueUnavailableError("");
  for (const venue of venues) {
    if (venue !== CANARY_PROFILE_VENUE) throw canaryVenueUnavailableError(venue);
  }
  return venues;
}

export function applyCanaryProfileDefaults(): void {
  if (process.env.VENUES == null || String(process.env.VENUES).trim() === "") {
    process.env.VENUES = CANARY_PROFILE_VENUE;
  }
  if (process.env.MARKETS == null || String(process.env.MARKETS).trim() === "") {
    process.env.MARKETS = "BTC";
  }
  assertCanaryVenueSelection();
}

export const createExtendedCanaryExecutor: ExecutorFactory = (venue, dryRun): VenueExecutor => {
  if (venue !== CANARY_PROFILE_VENUE) throw canaryVenueUnavailableError(venue);
  return new ExtendedExecutor(dryRun);
};

function unavailableDay(venue: VenueId): CanaryOfficialDay {
  return {
    venue,
    ok: false,
    source: "unavailable",
    volume: null,
    fees: null,
    realizedPnl: null,
    fills: null,
    closeFills: null,
    feeMaker: null,
    feeTaker: null,
    note: "CANARY_OFFICIAL_STATS_OFFLINE",
    updatedAt: new Date().toISOString(),
  };
}

export function emptyCanaryOfficialBundle(): CanaryOfficialBundle {
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const venues = {} as CanaryOfficialBundle["venues"];
  for (const venue of CANARY_VENUE_IDS) venues[venue] = unavailableDay(venue);
  return {
    dayKey,
    dayStartMs: Date.parse(`${dayKey}T00:00:00+08:00`),
    venues,
    updatedAt: new Date().toISOString(),
  };
}

export function getCanaryOfficialCache(): CanaryOfficialBundle | null {
  return null;
}
