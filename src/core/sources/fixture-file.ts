// Fixture mode for the CLI and the server: one JSON file stands in for the
// geocoder, Google Maps and the websites, so a whole run touches no network.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixtureFetcher, type MxResolver } from "../enrich/enrich.js";
import { checkWebsites, type FixtureSites } from "../enrich/isolated.js";
import type { EmailMxStatus } from "../enrich/mx.js";
import type { FetchResult, SiteFetcher } from "../enrich/safeFetch.js";
import { chooseHit, type Geocode, type GeoHit } from "../geo/geocode.js";
import type { RunDeps } from "../pipeline.js";
import { cancellableDelay, fixtureSource } from "./fixture.js";
import type { CollectReason, PlaceSource } from "./source.js";

/** The fixture file is missing or malformed. The message names the file. */
export class FixtureFileError extends Error {
  override name = "FixtureFileError";
}

const REASONS: readonly CollectReason[] = [
  "depth",
  "end-of-list",
  "no-growth",
  "timeout",
  "blocked",
  "single",
  "no-feed",
  "dom-fallback",
];

/**
 * The file format:
 *
 * - `geocode`: the geocoder's answer, `{ lat, lon, countryCode }`, or `null`
 *   for a city that is not found. The place is named as the query, type `place`.
 * - `geocodeHits` (optional): Nominatim's hits in order, run through the same
 *   rule as a live lookup; takes precedence over `geocode`.
 * - `batches`: raw `/search?tbm=map` bodies, replayed in order.
 * - `sitesDir`: the folder of fixture websites, relative to the file.
 * - `reason` (optional): ends every search with this reason, e.g. `blocked`
 *   to replay Google limiting the computer after the batches were read.
 * - `searchDelayMs` (optional): each search waits this long before replaying,
 *   and rejects with `CancelledError` as soon as the run is cancelled.
 * - `batchDelayMs` (optional): waits this long between batches, so a test
 *   sees rows arrive one batch at a time; cancellable the same way.
 */
type FixtureFile = {
  geocode?: { lat: number; lon: number; countryCode: string; bbox?: GeoHit["bbox"] } | null;
  geocodeHits?: GeoHit[];
  geocodes?: Record<string, GeoHit[] | null>;
  batches: string[];
  keywordBatches?: Record<string, string[]>;
  cellBatches?: string[][];
  sitesDir: string;
  reason?: CollectReason;
  searchDelayMs?: number;
  batchDelayMs?: number;
  blockedAttempts?: number;
  blockRetryDelaysMs?: number[];
  /** Optional per-domain MX check outcomes for fixture runs (defaults to "ok" for all domains). */
  mx?: Record<string, EmailMxStatus>;
  /** Websites whose check never ends, by host; see `StuckSite`. */
  stuckSites?: Record<string, StuckSite>;
  /** Stops the website checks after this long without progress (default 60 s). */
  checkStallMs?: number;
  /** The least time the website checks get, even past the run's time limit (default 60 s). */
  minCheckMs?: number;
};

/**
 * How a fixture website misbehaves:
 * - `busy`: reading its page spins the CPU forever, the way a runaway parser
 *   would (synchronous, right after the page's `parse_start`);
 * - `busy_fetch`: its fetch spins the CPU forever after a short wait, so the
 *   last step logged may belong to another website;
 * - `silent`: never answers (only a cancel ends it);
 * - `slow`: answers normally after half a second.
 */
export type StuckSite = "busy" | "busy_fetch" | "silent" | "slow";

/** `fetchSite`, except that the hosts in `stuck` never finish. */
export function withStuckSites(fetchSite: SiteFetcher, stuck: Record<string, StuckSite>): SiteFetcher {
  return async (url, opts) => {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return fetchSite(url, opts);
    }
    const mode = stuck[host];
    if (mode === "busy_fetch") {
      await new Promise((resolve) => setTimeout(resolve, BUSY_FETCH_AFTER_MS));
      for (;;) {
        // Never yields: no timer, no abort and no message gets through.
      }
    }
    if (mode === "slow") {
      await new Promise((resolve) => setTimeout(resolve, SLOW_SITE_MS));
      return fetchSite(url, opts);
    }
    if (mode === "silent") {
      return new Promise<FetchResult>((resolve) => {
        if (opts.signal?.aborted) resolve({ ok: false, reason: "timeout" });
        opts.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "timeout" }), { once: true });
      });
    }
    return fetchSite(url, opts);
  };
}

const STUCK_MODES: readonly string[] = ["busy", "busy_fetch", "silent", "slow"] satisfies StuckSite[];

/** How long a `busy_fetch` site waits before it spins: long enough for the quick fixture sites to finish. */
const BUSY_FETCH_AFTER_MS = 200;
/** How long a `slow` site takes to answer. */
const SLOW_SITE_MS = 500;

/**
 * The `onRead` hook for `busy` sites: reading their page spins the CPU
 * forever, the way a runaway parser would. Undefined when no site is `busy`.
 */
export function stuckReader(stuck: Record<string, StuckSite>): ((url: string) => void) | undefined {
  const busy = new Set(Object.keys(stuck).filter((host) => stuck[host] === "busy"));
  if (busy.size === 0) return undefined;
  return (url) => {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (!busy.has(host)) return;
    for (;;) {
      // Never returns: no timer, no abort and no message gets through.
    }
  };
}

function isBbox(box: unknown): box is GeoHit["bbox"] {
  if (typeof box !== "object" || box === null) return false;
  const b = box as Record<string, unknown>;
  return ["south", "north", "west", "east"].every((k) => typeof b[k] === "number");
}

function isGeoHit(h: unknown): h is GeoHit {
  if (typeof h !== "object" || h === null) return false;
  const { name, addresstype, lat, lon, countryCode, bbox } = h as Record<string, unknown>;
  return (
    typeof name === "string" &&
    typeof addresstype === "string" &&
    typeof lat === "number" &&
    typeof lon === "number" &&
    typeof countryCode === "string" &&
    isBbox(bbox)
  );
}

function isFixtureFile(data: unknown): data is FixtureFile {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  const geo = d.geocode as Record<string, unknown> | null | undefined;
  const geoOk =
    geo === null ||
    (geo === undefined && d.geocodeHits !== undefined) ||
    (typeof geo === "object" &&
      typeof geo.lat === "number" &&
      typeof geo.lon === "number" &&
      typeof geo.countryCode === "string" &&
      (geo.bbox === undefined || isBbox(geo.bbox)));
  const hitsOk = d.geocodeHits === undefined || (Array.isArray(d.geocodeHits) && d.geocodeHits.every(isGeoHit));
  const geocodesOk =
    d.geocodes === undefined ||
    (typeof d.geocodes === "object" &&
      d.geocodes !== null &&
      !Array.isArray(d.geocodes) &&
      Object.values(d.geocodes).every((v) => v === null || (Array.isArray(v) && v.every(isGeoHit))));
  const keywordBatchesOk =
    d.keywordBatches === undefined ||
    (typeof d.keywordBatches === "object" &&
      d.keywordBatches !== null &&
      !Array.isArray(d.keywordBatches) &&
      Object.values(d.keywordBatches).every((v) => Array.isArray(v) && v.every((b) => typeof b === "string")));
  const cellBatchesOk =
    d.cellBatches === undefined ||
    (Array.isArray(d.cellBatches) && d.cellBatches.every((c) => Array.isArray(c) && c.every((b) => typeof b === "string")));
  const blockedAttemptsOk =
    d.blockedAttempts === undefined || (typeof d.blockedAttempts === "number" && Number.isInteger(d.blockedAttempts) && d.blockedAttempts >= 0);
  const delaysOk =
    d.blockRetryDelaysMs === undefined ||
    (Array.isArray(d.blockRetryDelaysMs) && d.blockRetryDelaysMs.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0));
  return (
    geoOk &&
    hitsOk &&
    geocodesOk &&
    keywordBatchesOk &&
    cellBatchesOk &&
    blockedAttemptsOk &&
    delaysOk &&
    Array.isArray(d.batches) &&
    d.batches.every((b) => typeof b === "string") &&
    typeof d.sitesDir === "string" &&
    (d.reason === undefined || REASONS.includes(d.reason as CollectReason)) &&
    (d.searchDelayMs === undefined || (typeof d.searchDelayMs === "number" && d.searchDelayMs >= 0)) &&
    (d.batchDelayMs === undefined || (typeof d.batchDelayMs === "number" && d.batchDelayMs >= 0)) &&
    (d.stuckSites === undefined ||
      (typeof d.stuckSites === "object" &&
        d.stuckSites !== null &&
        Object.values(d.stuckSites).every((m) => typeof m === "string" && STUCK_MODES.includes(m)))) &&
    (d.checkStallMs === undefined || (typeof d.checkStallMs === "number" && d.checkStallMs > 0)) &&
    (d.minCheckMs === undefined || (typeof d.minCheckMs === "number" && d.minCheckMs >= 0))
  );
}

function withReason(source: PlaceSource, reason: CollectReason): PlaceSource {
  return {
    async search(q, onProgress) {
      const { places } = await source.search(q, onProgress);
      return { places, reason };
    },
  };
}

function withDelay(source: PlaceSource, ms: number): PlaceSource {
  return {
    async search(q, onProgress) {
      await cancellableDelay(ms, q.signal);
      return source.search(q, onProgress);
    },
  };
}

function withBlockedAttempts(source: PlaceSource, blockedAttempts: number): PlaceSource {
  let remaining = blockedAttempts;
  return {
    async search(q, onProgress) {
      if (remaining > 0) {
        remaining -= 1;
        return { places: [], reason: "blocked" };
      }
      return source.search(q, onProgress);
    },
  };
}

function cellFixtureSource(cellBatches: string[][], batchDelayMs?: number): PlaceSource {
  let index = 0;
  return {
    search(q, onProgress) {
      const batches = cellBatches.length > 0 ? cellBatches[index % cellBatches.length]! : [];
      index += 1;
      return fixtureSource(batches, batchDelayMs ? { batchDelayMs } : {}).search(q, onProgress);
    },
  };
}

function keywordFixtureSource(keywordBatches: Record<string, string[]>, fallback: string[], batchDelayMs?: number): PlaceSource {
  return {
    search(q, onProgress) {
      const batches = keywordBatches[q.keyword] ?? fallback;
      return fixtureSource(batches, batchDelayMs ? { batchDelayMs } : {}).search(q, onProgress);
    },
  };
}

/** Reads `file` and returns the run dependencies it describes; throws `FixtureFileError`. */
export async function loadFixtureDeps(file: string): Promise<Omit<RunDeps, "now">> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new FixtureFileError(`Could not read the fixture file ${file}: ${(e as Error).message}`);
  }
  if (!isFixtureFile(data)) {
    throw new FixtureFileError(
      `The fixture file ${file} needs "geocode" (object or null) or "geocodeHits" (hits), "batches" (strings), ` +
        `"sitesDir" and optionally "reason" (one of ${REASONS.join(", ")}), "searchDelayMs" and "batchDelayMs" (milliseconds).`,
    );
  }
  const { geocode: geo, geocodeHits: hits, geocodes } = data;
  const geocode: Geocode = async (place) => {
    if (geocodes && Object.hasOwn(geocodes, place)) {
      const entry = geocodes[place];
      return entry ? chooseHit(entry) : null;
    }
    if (hits) return chooseHit(hits);
    if (!geo) return null;
    const bbox = geo.bbox ?? { south: geo.lat, north: geo.lat, west: geo.lon, east: geo.lon };
    return { kind: "place", hit: { name: place, addresstype: "place", lat: geo.lat, lon: geo.lon, countryCode: geo.countryCode, bbox } };
  };
  const files = fixtureFetcher(path.resolve(path.dirname(file), data.sitesDir));
  const fetchSite = data.stuckSites ? withStuckSites(files, data.stuckSites) : files;
  const replay = data.cellBatches
    ? cellFixtureSource(data.cellBatches, data.batchDelayMs)
    : data.keywordBatches
      ? keywordFixtureSource(data.keywordBatches, data.batches, data.batchDelayMs)
      : fixtureSource(data.batches, data.batchDelayMs ? { batchDelayMs: data.batchDelayMs } : {});
  const timed = data.searchDelayMs ? withDelay(replay, data.searchDelayMs) : replay;
  const reasoned = data.reason ? withReason(timed, data.reason) : timed;
  const source = data.blockedAttempts ? withBlockedAttempts(reasoned, data.blockedAttempts) : reasoned;
  const blockRetry =
    data.blockRetryDelaysMs !== undefined
      ? { delaysMs: data.blockRetryDelaysMs }
      : data.reason === "blocked" && !data.blockedAttempts
        ? { delaysMs: [] }
        : undefined;
  const mxResolver = data.mx ? fixtureMxResolver(data.mx) : undefined;
  // The checks run in a check process like a live run's; `fetchSite` and
  // `mxResolver` serve the same files if they have to run in this process.
  const fixture: FixtureSites = {
    sitesDir: path.resolve(path.dirname(file), data.sitesDir),
    ...(data.mx ? { mx: data.mx } : {}),
    ...(data.stuckSites ? { stuck: data.stuckSites } : {}),
  };
  return {
    source,
    geocode,
    enrich: (leads, opts, onProgress) =>
      checkWebsites(
        leads,
        {
          ...opts,
          fixture,
          fetchSite,
          ...(mxResolver ? { mxResolver } : {}),
          ...(data.checkStallMs !== undefined ? { stallMs: data.checkStallMs } : {}),
        },
        onProgress,
      ),
    ...(blockRetry ? { blockRetry } : {}),
    ...(data.minCheckMs !== undefined ? { minCheckMs: data.minCheckMs } : {}),
  };
}

/** Answers MX lookups from a fixture's per-domain outcomes; a domain not listed has a mail server. */
export function fixtureMxResolver(mx: Record<string, EmailMxStatus>): MxResolver {
  return {
    resolveMx: async (domain) => {
      const status = mx[domain];
      if (status === "no mail server") return [];
      if (status === "unknown") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      return [{ exchange: "mail.test", priority: 10 }];
    },
    resolve4: async () => [],
  };
}
