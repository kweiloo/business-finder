// The contract every place source (browser, fixture, later an API) fulfils.

import type { RawPlace } from "../types.js";

/**
 * Why a keyword's collection stopped.
 *
 * - `depth`: the requested number of result batches was read.
 * - `end-of-list`: Google showed its end marker, or scrolling stopped sending requests.
 * - `no-growth`: scrolling kept answering but brought no new places.
 * - `timeout`: the keyword's time limit ran out.
 * - `blocked`: Google answered with HTTP 429 or its unusual-traffic page.
 * - `single`: the query resolved to one place page instead of a result list.
 * - `no-feed`: neither a result list nor a place page appeared.
 * - `dom-fallback`: no batch held places, so places were read from the list's links.
 */
export type CollectReason =
  | "depth"
  | "end-of-list"
  | "no-growth"
  | "timeout"
  | "blocked"
  | "single"
  | "no-feed"
  | "dom-fallback";

export type SearchQuery = {
  keyword: string;
  lat: number;
  lon: number;
  /** Interface language, e.g. `en`. */
  lang: string;
  /** ISO 3166-1 alpha-2 country, e.g. `MY`; also used to read national phone numbers. */
  country: string;
  /** Maps viewport zoom level (defaults to 15 when omitted). */
  zoom?: number;
  /** Maximum number of result batches (~20 places each). */
  depth: number;
  maxSeconds: number;
  /** Copied onto every place; empty when not given. */
  city?: string;
  /**
   * The place as the person wrote it, searched as "<keyword> in <place>" so
   * Google reads the place too and the coordinates only centre the map. Left
   * out for whole-city area searches, whose coordinates must hold each area.
   */
  place?: string;
  /** Aborted when the user cancels; the search then rejects as soon as it can. */
  signal?: AbortSignal;
};

/**
 * One batch read. `found` holds the places this batch added that the search
 * had not seen yet, in source order; a source that cannot tell batches apart
 * leaves it out, and its places arrive with the final result instead.
 */
export type SearchProgress = {
  places: number;
  batches: number;
  found?: RawPlace[];
  retryInSeconds?: number;
  retry?: number;
  retries?: number;
};

export interface PlaceSource {
  search(
    q: SearchQuery,
    onProgress: (p: SearchProgress) => void,
  ): Promise<{ places: RawPlace[]; reason: CollectReason }>;
}
