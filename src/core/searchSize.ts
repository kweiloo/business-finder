// How many places a search asks Google Maps for, as the New list form offers
// it. Google Maps loads results in batches of about 20 as the list scrolls,
// so the size is a number of batches (`depth`), with a search time limit
// (`maxSeconds`) long enough for that many.

import type { RunOptions } from "./types.js";

/** Upper bound of what one Google Maps viewport search can return (~100–120). */
export const SINGLE_SEARCH_LIMIT = 120;

/**
 * Maximum places requested in one whole-city or exact-limit run. At ~24 s per
 * cell (up to ~15 minutes for 40 cells) plus website checks, 1000 caps a run
 * within the 30-minute default budget while keeping Google Maps block risk low.
 */
export const MAX_WHOLE_CITY_LIMIT = 1000;

export type SearchSize = "about20" | "oneSearch" | "wholeCity";

export const DEFAULT_SEARCH_SIZE: SearchSize = "oneSearch";

/**
 * The batches, time limit, cap and grid mode for each size. One Maps search
 * ends at about 100–120 places, so "Everything one search finds" scrolls to
 * the end with a 120 cap, and "The whole city" enables the sequential geo-grid
 * with enough time and per-cell batch depth to search every cell.
 */
export const SEARCH_SIZES: Record<SearchSize, Pick<RunOptions, "depth" | "maxSeconds"> & { wholeCity?: boolean; limit?: number }> = {
  about20: { depth: 1, maxSeconds: 600 },
  oneSearch: { depth: 10, maxSeconds: 600, limit: SINGLE_SEARCH_LIMIT },
  wholeCity: { depth: 10, maxSeconds: 1800, wholeCity: true },
};

export function isSearchSize(value: unknown): value is SearchSize {
  return typeof value === "string" && Object.hasOwn(SEARCH_SIZES, value);
}

/** True when a run should search sequentially across geo-grid cells. */
export function usesWholeCityGrid(options: { wholeCity?: boolean | undefined; limit?: number | undefined }): boolean {
  return Boolean(options.wholeCity) || (options.limit !== undefined && options.limit > SINGLE_SEARCH_LIMIT);
}
