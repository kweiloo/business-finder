// The geocoder the CLI and the server use: Nominatim's usage policy asks for
// at most one request per second from the whole application and for answers
// to be cached. Lookups wait on one process-wide pacer, the same place asked
// twice at once shares one request, and answers are kept in a JSON file.

import * as nodeFs from "node:fs";
import path from "node:path";
import { HostPacer } from "../enrich/safeFetch.js";
import { geocode as lookUp, type Geocode, type GeocodeResult, type GeoHit } from "./geocode.js";

export const GEOCODE_HOST = "nominatim.openstreetmap.org";
/** A little over a second, so clock jitter never makes two requests land in one second. */
export const GEOCODE_INTERVAL_MS = 1100;
export const HIT_TTL_DAYS = 30;
/** Not-found answers expire sooner: a misspelling corrected in OSM should not stay unknown for a month. */
export const NOT_FOUND_TTL_HOURS = 24;
/** The cache file's name inside Business Finder's data folder. */
export const GEOCODE_CACHE_FILE = "geocode-cache.json";

/** Version 2 added each hit's state and country names, so version-1 answers are asked again. */
const CACHE_VERSION = 2;
const HOUR_MS = 60 * 60 * 1000;

/**
 * One pacer for every geocoder in this process, so two runs (or a CLI run
 * and a server job) in one process never exceed the policy together.
 * Separate processes each have their own; the disk cache keeps that rare.
 */
const NOMINATIM_PACER = new HostPacer({ intervalMs: GEOCODE_INTERVAL_MS });

export type GeocoderFs = Pick<typeof nodeFs, "readFileSync" | "writeFileSync" | "renameSync" | "mkdirSync">;

export type GeocoderOptions = {
  /** Where answers are kept between runs; without it they last for this process only. */
  cacheFile?: string;
  fetchFn?: typeof fetch;
  pacer?: Pick<HostPacer, "wait">;
  now?: () => Date;
  fs?: GeocoderFs;
};

type Entry = { at: string; result: GeocodeResult };
type CacheFile = { version: typeof CACHE_VERSION; entries: Record<string, Entry> };

/**
 * Places that differ only in case or spacing share an entry; a place asked
 * within a country ("my|pj") is kept apart from the same place asked worldwide ("pj").
 */
export function cacheKey(place: string, countryCode?: string): string {
  const key = place.trim().toLowerCase().replace(/\s+/g, " ");
  const country = countryCode?.trim().toLowerCase();
  return country ? `${country}|${key}` : key;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isHit(v: unknown): v is GeoHit {
  if (!isObject(v) || !isObject(v.bbox)) return false;
  const box = v.bbox;
  return (
    typeof v.name === "string" &&
    typeof v.addresstype === "string" &&
    typeof v.countryCode === "string" &&
    [v.state, v.stateCode, v.country].every((t) => t === undefined || typeof t === "string") &&
    [v.lat, v.lon, box.south, box.north, box.west, box.east].every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function isResult(v: unknown): v is GeocodeResult {
  if (v === null) return true;
  if (!isObject(v) || !isHit(v.hit)) return false;
  if (v.kind === "region") return true;
  return v.kind === "place" && (v.region === undefined || isHit(v.region));
}

function isEntry(v: unknown): v is Entry {
  return isObject(v) && typeof v.at === "string" && Number.isFinite(Date.parse(v.at)) && isResult(v.result);
}

/** The entries of a readable version-1 file; anything else counts as an empty cache. */
function readEntries(fs: GeocoderFs, file: string | undefined): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  if (!file) return entries;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return entries;
  }
  if (!isObject(parsed) || parsed.version !== CACHE_VERSION || !isObject(parsed.entries)) return entries;
  for (const [key, entry] of Object.entries(parsed.entries)) if (isEntry(entry)) entries.set(key, entry);
  return entries;
}

/** Written to a temporary file and renamed over the old one, so a crash never leaves half a file. */
function writeEntries(fs: GeocoderFs, file: string, entries: Map<string, Entry>): void {
  const body: CacheFile = { version: CACHE_VERSION, entries: Object.fromEntries(entries) };
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(body));
    fs.renameSync(temp, file);
  } catch {
    // The cache only saves requests; a read-only or locked data folder must not stop a run.
  }
}

/**
 * A `Geocode` that paces requests to Nominatim and remembers its answers:
 * hits for 30 days, "not found" for 24 hours. Errors (an unreachable or
 * rate-limiting Nominatim) are never remembered, so the next run asks again.
 */
export function createGeocoder(opts: GeocoderOptions = {}): Geocode {
  const fs = opts.fs ?? nodeFs;
  const fetchFn = opts.fetchFn ?? fetch;
  const pacer = opts.pacer ?? NOMINATIM_PACER;
  const now = opts.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<GeocodeResult>>();
  let entries: Map<string, Entry> | undefined;

  const fresh = (entry: Entry): boolean => {
    const ttl = entry.result === null ? NOT_FOUND_TTL_HOURS * HOUR_MS : HIT_TTL_DAYS * 24 * HOUR_MS;
    return now().getTime() - Date.parse(entry.at) < ttl;
  };

  const fetchAndKeep = async (key: string, place: string, countryCode: string | undefined): Promise<GeocodeResult> => {
    // A lookup within a country may ask twice (the country, then worldwide); each request waits its turn.
    const result = await lookUp(place, fetchFn, { ...(countryCode ? { countryCode } : {}), pace: () => pacer.wait(GEOCODE_HOST) });
    entries!.set(key, { at: now().toISOString(), result });
    if (opts.cacheFile) writeEntries(fs, opts.cacheFile, entries!);
    return result;
  };

  return (place, lookUpOpts) => {
    entries ??= readEntries(fs, opts.cacheFile);
    const countryCode = lookUpOpts?.countryCode?.trim() || undefined;
    const key = cacheKey(place, countryCode);
    const cached = entries.get(key);
    if (cached && fresh(cached)) return Promise.resolve(cached.result);

    const pending = inFlight.get(key);
    if (pending) return pending;
    const request = fetchAndKeep(key, place, countryCode).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  };
}
