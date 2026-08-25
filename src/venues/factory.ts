import type { VenueId } from "../types.js";
import type { VenueExecutor } from "./types.js";

export type ExecutorFactory = (venue: VenueId, dryRun: boolean) => VenueExecutor;

export const CANARY_VENUE_UNAVAILABLE = "CANARY_VENUE_UNAVAILABLE" as const;
export const CANARY_PROFILE_VENUE = "extended" as const;

export function canaryVenueUnavailableError(venue: string): Error {
  const id = venue.trim() === "" ? "<empty>" : venue;
  return new Error(`${CANARY_VENUE_UNAVAILABLE}:${id}`);
}
