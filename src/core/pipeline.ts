// One scrape run end to end: geocode the city, collect places, drop
// duplicates, apply the limit, enrich from websites, and prove every place
// and every website is accounted for.

import { ListIndex, placeCandidate } from "../jobs/dedupe.js";
import { debugLogFromEnv, type DebugLog } from "./debugLog.js";
import type { WebsiteChecker } from "./enrich/isolated.js";
import { CancelledError, ReconciliationError, UserFacingError } from "./errors.js";
import { countryName, placeLabel, type Geocode, type GeocodeResult, type GeoHit, type ResolvedPlace } from "./geo/geocode.js";
import { buildGrid, canSplitCell, CELL_SPLIT_THRESHOLD, MAX_TOTAL_CELLS, splitCell } from "./geo/grid.js";
import { citiesOf, keywordsOf } from "./keywords.js";
import { dedupeKey, toLead } from "./leads/normalize.js";
import { MAX_WHOLE_CITY_LIMIT, SEARCH_SIZES, usesWholeCityGrid } from "./searchSize.js";
import { withBlockRetry, type BlockRetryOptions } from "./sources/retry.js";
import type { CollectReason, PlaceSource, SearchProgress } from "./sources/source.js";
import type { KeywordSummary, Lead, Progress, RawPlace, Reconciliation, RunOptions, RunResult } from "./types.js";

export const BLOCKED_MESSAGE = "Google Maps stopped answering searches from this computer for now. Wait a few minutes, then try again.";

/** A progress update; every update after geocoding says where the run searches. */
export type ScrapeProgress = Progress & { location?: ResolvedPlace };

/**
 * The least time the website checks get. The checks get whatever is left of
 * the run's `maxSeconds`, but never less than this, so a run can go past
 * `maxSeconds` by up to this long while its websites are checked. Without
 * it, a search that used all of `maxSeconds` on Google Maps would leave
 * every row unchecked.
 */
export const MIN_CHECK_MS = 60_000;

export type RunDeps = {
  source: PlaceSource;
  geocode: Geocode;
  enrich: WebsiteChecker;
  /** Overrides `MIN_CHECK_MS`. */
  minCheckMs?: number;
  /**
   * Aborted to stop the website checks now and finish the run with what is
   * checked (the CLI's Ctrl-C). Unlike the cancel signal, the run returns
   * its rows; the unchecked ones read `not_checked`.
   */
  finishChecks?: AbortSignal;
  now: () => Date;
  /** Diagnostics; defaults to the BUSINESS_FINDER_DEBUG_LOG file, if set. */
  debug?: DebugLog;
  /** Backoff settings when Google blocks; defaults to `BLOCK_RETRY_DELAYS_MS`. */
  blockRetry?: BlockRetryOptions;
};

/**
 * Where a run hands its rows while it is still going, so they can be saved
 * batch by batch. Every row is `added` once, before its website is checked
 * (its `email_status` and `website_status` read `not_checked`), and later
 * `checked` at most once, by its position in the order rows were added.
 * A row cut off by a cancel is never checked. A throwing sink is ignored.
 */
export type RowSink = {
  added(leads: Lead[]): void;
  checked(row: number, lead: Lead): void;
};

const hasPlaceDetails = (p: Pick<RawPlace, "website" | "phone" | "address">): boolean =>
  Boolean(p.website?.trim() || p.phone?.trim() || p.address?.trim());

/** A row saved before its website check: what Maps gave, marked as not checked yet. */
function unchecked(lead: Lead): Lead {
  return { ...lead, email_status: "not_checked", website_status: "not_checked" };
}

function doneMessage(reason: CollectReason, kept: number, opts: RunOptions): string {
  const what = keywordsOf(opts).join(", ");
  const where = citiesOf(opts).join(", ");
  if (reason === "blocked") return BLOCKED_MESSAGE;
  if (kept === 0) return `No places found for "${what}" in ${where}.`;
  const leads = `${kept} ${kept === 1 ? "lead" : "leads"}`;
  if (reason === "timeout") return `Stopped at the time limit with ${leads} in ${where}.`;
  return `Found ${leads} in ${where}.`;
}

/** Keeps the first place per dedupe key, in source order. */
function dedupe(places: RawPlace[], country: string): RawPlace[] {
  const seen = new Set<string>();
  return places.filter((p) => {
    const key = dedupeKey(p, country);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "3 websites didn't answer in time and were skipped." */
export function skippedWebsitesLine(n: number): string {
  return n === 1 ? "1 website didn't answer in time and was skipped." : `${n} websites didn't answer in time and were skipped.`;
}

function checkBalanced(r: Reconciliation, enrichedLeads: number): void {
  const problems: string[] = [];
  if (r.found !== r.kept + r.filtered + r.duplicates) {
    problems.push(`places found ${r.found} ≠ kept ${r.kept} + filtered ${r.filtered} + duplicates ${r.duplicates}`);
  }
  const notChecked = r.notChecked ?? 0;
  if (r.toCheck !== r.fetched + r.unreachable + r.mismatched + r.skipped + notChecked) {
    problems.push(
      `sites to check ${r.toCheck} ≠ fetched ${r.fetched} + unreachable ${r.unreachable} + mismatched ${r.mismatched} + skipped ${r.skipped} + not checked ${notChecked}`,
    );
  }
  if (enrichedLeads !== r.kept) problems.push(`enrichment returned ${enrichedLeads} leads for ${r.kept} kept places`);
  if (problems.length) throw new ReconciliationError(`Reconciliation failed: ${problems.join("; ")}`);
}

function retryMessage(p: SearchProgress): string {
  return `Google Maps stopped answering searches from this computer for now. Trying again in ${p.retryInSeconds} s (${p.retry} of ${p.retries})…`;
}

type ResolvedCity = {
  city: string;
  hit: GeoHit;
  country: string;
  location: ResolvedPlace;
  where: string;
};

/**
 * Said when the place was found in another country than the run's: names what
 * was found, so the person can write the place out in full.
 */
export function otherCountryMessage(typed: string, hit: GeoHit, runCountry: string): string {
  return `${typed} matched ${hit.name} in ${countryName(hit.countryCode)}, not ${countryName(runCountry)}. Write the full place name with its region and country.`;
}

const AREA_WORDS: Readonly<Record<string, string>> = {
  state: "state",
  province: "province",
  region: "region",
  county: "county",
  district: "district",
  state_district: "district",
};

/** Said when the place is a state, region or country, too large for one search. */
export function tooLargeMessage(typed: string, hit: GeoHit): string {
  if (hit.addresstype === "country") return `${typed} is a country. Name a city, or a state to pick towns from.`;
  const word = AREA_WORDS[hit.addresstype] ?? "area";
  return `${typed} is a whole ${word}, too large for one search. Search towns inside it instead; you can give several at once.`;
}

async function resolveCities(
  cities: readonly string[],
  opts: RunOptions,
  deps: RunDeps,
  report: (p: Progress) => void,
  setLocation: (loc: ResolvedPlace) => void,
  stopIfCancelled: (stage: Progress["stage"]) => void,
  debug: DebugLog,
  elapsed: () => number,
): Promise<ResolvedCity[]> {
  const resolved: ResolvedCity[] = [];
  const runCountry = opts.country?.trim().toUpperCase() || undefined;
  for (let i = 0; i < cities.length; i++) {
    const city = cities[i]!;
    const cityFields = cities.length > 1 ? { cityIndex: i + 1, citiesTotal: cities.length, currentCity: city } : {};
    report({ stage: "geocoding", places: 0, ...cityFields, message: `Looking up ${city}…` });
    let geo: GeocodeResult;
    try {
      geo = await deps.geocode(city, runCountry ? { countryCode: runCountry } : undefined);
    } catch (e) {
      debug("geocode_failed", { ms: elapsed() });
      throw new UserFacingError(
        `Could not look up ${city} on the map. Check your internet connection and try again.`,
        { cause: e },
      );
    }
    debug("geocode_done", { ms: elapsed(), result: geo ? geo.kind : "none" });
    stopIfCancelled("geocoding");
    if (!geo) throw new UserFacingError(`City not found: ${city}`);
    // Never search somewhere else quietly: a short name can match a town abroad (PJ → Pojuca, Brazil).
    if (runCountry && geo.hit.countryCode !== runCountry) throw new UserFacingError(otherCountryMessage(city, geo.hit, runCountry));
    // Searching a state's or country's centroid finds the outskirts, not the city.
    if (geo.kind === "region") throw new UserFacingError(tooLargeMessage(city, geo.hit));
    const { hit } = geo;
    const location: ResolvedPlace = { name: hit.name, addresstype: hit.addresstype, lat: hit.lat, lon: hit.lon, label: placeLabel(hit) };
    if (i === 0) setLocation(location);
    const country = (opts.country?.trim() || hit.countryCode).toUpperCase();
    const trimmedCity = city.trim();
    const label = location.label;
    const where =
      label && trimmedCity.toLowerCase() === label.toLowerCase()
        ? city
        : !hit.name || hit.name.toLowerCase() === trimmedCity.toLowerCase()
          ? label || city
          : `${city} (${label || hit.name})`;
    resolved.push({ city, hit, country, location, where });
  }
  return resolved;
}

/**
 * Runs one or more keywords across one or more cities into a single deduped
 * list. Throws `UserFacingError` when a city cannot be looked up or is a
 * state or country too large to search, and `ReconciliationError` when the
 * counts do not balance. A blocked search is not an error: the places read
 * before the block are kept and the final progress message says what to do.
 *
 * When `wholeCity` is set or `limit` exceeds `SINGLE_SEARCH_LIMIT`, covers each
 * city's geocoded bounding box sequentially cell by cell for every keyword,
 * deduping across cells and keywords via `ListIndex` and stopping when the
 * limit is reached, all cells finish, a cell remains blocked after retries, or
 * the run is cancelled.
 *
 * Aborting `signal` stops the search and the website checks and throws
 * `CancelledError`. Nothing is returned then; rows already handed to `rows`
 * are what the run found before it stopped.
 */
export async function runScrape(
  opts: RunOptions,
  deps: RunDeps,
  onProgress: (p: ScrapeProgress) => void,
  signal?: AbortSignal,
  rows?: RowSink,
): Promise<RunResult> {
  const debug = deps.debug ?? debugLogFromEnv();
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const stopIfCancelled = (stage: Progress["stage"]) => {
    if (!signal?.aborted) return;
    debug("run_cancelled", { ms: elapsed(), stage });
    throw new CancelledError();
  };
  let location: ResolvedPlace | undefined;
  const report = (p: Progress, overrideLocation?: ResolvedPlace) => {
    try {
      const loc = overrideLocation ?? location;
      onProgress(loc ? { ...p, location: loc } : p);
    } catch {
      // A failing progress listener must not stop the run.
    }
  };

  const keywords = keywordsOf(opts);
  const cities = citiesOf(opts);

  debug("run_start", {
    keywords: keywords.length,
    cities: cities.length,
    depth: opts.depth,
    limit: opts.limit ?? "none",
    wholeCity: Boolean(opts.wholeCity),
    emails: opts.emails,
    socials: opts.socials,
    deep: opts.deep,
  });

  const resolvedCities = await resolveCities(
    cities,
    opts,
    deps,
    (p) => report(p),
    (loc) => {
      location = loc;
    },
    stopIfCancelled,
    debug,
    elapsed,
  );
  const primaryCity = resolvedCities[0]!;
  const primaryCountry = primaryCity.country;

  const rawLimit = opts.limit === undefined ? undefined : Math.max(0, Math.floor(opts.limit));
  const useGrid = usesWholeCityGrid({ wholeCity: opts.wholeCity, limit: rawLimit });
  const limit = rawLimit !== undefined ? Math.min(rawLimit, MAX_WHOLE_CITY_LIMIT) : useGrid ? MAX_WHOLE_CITY_LIMIT : Infinity;
  const fetchedAt = deps.now().toISOString();

  const source = withBlockRetry(deps.source, deps.blockRetry);
  debug("search_start", { ms: elapsed(), grid: useGrid, keywords: keywords.length, cities: resolvedCities.length });

  let foundCount = 0;
  let unique: RawPlace[] = [];
  let reason: CollectReason = "end-of-list";
  let leads: Lead[] = [];
  let rowOf: Array<number | undefined> = [];
  let keywordSummaries: KeywordSummary[] | undefined;

  if (!useGrid && keywords.length === 1 && resolvedCities.length === 1) {
    const keyword = keywords[0]!;
    const { hit, country, where } = primaryCity;
    const searching = (n: number) => `Searching ${where}… ${n} places`;
    const emittedByKey = new Map<string, { row: number; lead: Lead }>();
    let emittedCount = 0;

    const upgradeEmitted = (prevKey: string, p: RawPlace) => {
      const nextKey = dedupeKey(p, country);
      const existing = emittedByKey.get(prevKey) ?? emittedByKey.get(nextKey);
      if (!existing || hasPlaceDetails(existing.lead) || !hasPlaceDetails(p)) return;
      const updated = toLead(p, country, fetchedAt);
      existing.lead = updated;
      emittedByKey.set(nextKey, existing);
      if (!rows) return;
      try {
        rows.checked(existing.row, unchecked(updated));
      } catch {
        // A failing sink must not stop the run; the caller notices on its side.
      }
    };

    const pushEmitted = (places: RawPlace[]) => {
      const batch: Lead[] = [];
      for (const p of places) {
        const key = dedupeKey(p, country);
        if (emittedByKey.has(key)) {
          upgradeEmitted(key, p);
          continue;
        }
        if (!rows || emittedCount >= limit) continue;
        const lead = toLead(p, country, fetchedAt);
        emittedByKey.set(key, { row: emittedCount, lead });
        emittedCount += 1;
        batch.push(unchecked(lead));
      }
      if (!rows || batch.length === 0) return;
      try {
        rows.added(batch);
      } catch {
        // A failing sink must not stop the run; the caller notices on its side.
      }
    };

    const seen = new Set<string>();
    const emit = (places: RawPlace[]) => {
      const fresh: RawPlace[] = [];
      for (const p of places) {
        const key = dedupeKey(p, country);
        if (seen.has(key)) {
          upgradeEmitted(key, p);
          continue;
        }
        seen.add(key);
        fresh.push(p);
      }
      pushEmitted(fresh);
    };

    report({ stage: "searching", places: 0, message: searching(0) });
    let found: Awaited<ReturnType<PlaceSource["search"]>>;
    try {
      found = await source.search(
        {
          keyword,
          lat: hit.lat,
          lon: hit.lon,
          lang: opts.lang,
          country,
          depth: opts.depth,
          maxSeconds: opts.maxSeconds,
          city: primaryCity.city,
          place: primaryCity.city,
          signal,
        },
        (p) => {
          if (p.retryInSeconds !== undefined) {
            report({
              stage: "searching",
              places: p.places,
              retryInSeconds: p.retryInSeconds,
              ...(p.retry !== undefined ? { retry: p.retry } : {}),
              ...(p.retries !== undefined ? { retries: p.retries } : {}),
              message: retryMessage(p),
            });
            return;
          }
          if (p.found && !signal?.aborted) emit(p.found);
          report({ stage: "searching", places: p.places, message: searching(p.places) });
        },
      );
    } catch (e) {
      // A cancelled browser search fails with whatever its closed connection threw.
      stopIfCancelled("searching");
      throw e;
    }
    stopIfCancelled("searching");
    foundCount = found.places.length;
    unique = dedupe(found.places, country);
    reason = found.reason;
    const kept = unique.slice(0, Math.min(limit, unique.length));
    pushEmitted(kept);
    leads = kept.map((p) => emittedByKey.get(dedupeKey(p, country))?.lead ?? toLead(p, country, fetchedAt));
    rowOf = kept.map((p) => emittedByKey.get(dedupeKey(p, country))?.row);
  } else {
    const runIndex = new ListIndex([], primaryCountry);
    const emittedRows: Array<{ row: number; lead: Lead } | undefined> = [];
    const uniqueCountries: string[] = [];
    let emittedCount = 0;

    const stats = new Map<string, { keyword: string; found: number; added: number }>();
    for (const kw of keywords) stats.set(kw, { keyword: kw, found: 0, added: 0 });

    const absorb = (places: RawPlace[], kwStat: { found: number; added: number }, cityCountry: string) => {
      const batch: Lead[] = [];
      for (const p of places) {
        const candidate = placeCandidate(p);
        const match = runIndex.find(candidate);
        if (match) {
          const prev = unique[match.at];
          if (prev && !hasPlaceDetails(prev) && hasPlaceDetails(p)) {
            unique[match.at] = p;
            const slot = emittedRows[match.at];
            if (slot) {
              const updated = toLead(p, uniqueCountries[match.at] ?? cityCountry, fetchedAt);
              slot.lead = updated;
              if (rows) {
                try {
                  rows.checked(slot.row, unchecked(updated));
                } catch {
                  // A failing sink must not stop the run; the caller notices on its side.
                }
              }
            }
          }
          continue;
        }
        const idx = unique.length;
        runIndex.add(candidate);
        unique.push(p);
        uniqueCountries.push(cityCountry);
        kwStat.added += 1;
        if (rows && emittedCount < limit) {
          const lead = toLead(p, cityCountry, fetchedAt);
          emittedRows[idx] = { row: emittedCount, lead };
          emittedCount += 1;
          batch.push(unchecked(lead));
        }
      }
      if (!rows || batch.length === 0) return;
      try {
        rows.added(batch);
      } catch {
        // A failing sink must not stop the run; the caller notices on its side.
      }
    };

    const runDeadline = Date.now() + opts.maxSeconds * 1000;
    const cellDepth = useGrid ? Math.max(opts.depth, SEARCH_SIZES.wholeCity.depth) : opts.depth;
    let stopped = false;

    for (let ci = 0; ci < resolvedCities.length && !stopped; ci++) {
      const resolvedCity = resolvedCities[ci]!;
      const cityFields =
        resolvedCities.length > 1 ? { cityIndex: ci + 1, citiesTotal: resolvedCities.length, currentCity: resolvedCity.city } : {};

      for (let ki = 0; ki < keywords.length && !stopped; ki++) {
        stopIfCancelled("searching");
        if (unique.length >= limit) {
          reason = "depth";
          stopped = true;
          break;
        }
        const kw = keywords[ki]!;
        const kwStat = stats.get(kw)!;
        const kwFields =
          keywords.length > 1 ? { keywordIndex: ki + 1, keywordsTotal: keywords.length, currentKeyword: kw } : {};
        const scopeLabel = [
          keywords.length > 1 ? `keyword ${ki + 1} of ${keywords.length}` : "",
          resolvedCities.length > 1 ? `city ${ci + 1} of ${resolvedCities.length}` : "",
        ]
          .filter(Boolean)
          .join(", ");

        if (!useGrid) {
          const remainingMs = runDeadline - Date.now();
          if (remainingMs <= 0) {
            reason = "timeout";
            stopped = true;
            break;
          }
          const prefix = scopeLabel ? `Searching ${resolvedCity.where} (${scopeLabel})` : `Searching ${resolvedCity.where}`;
          report({ stage: "searching", places: Math.min(unique.length, limit), ...cityFields, ...kwFields, message: `${prefix}… ${Math.min(unique.length, limit)} places` }, resolvedCity.location);

          let callEmitted = 0;
          let found: Awaited<ReturnType<PlaceSource["search"]>>;
          try {
            found = await source.search(
              {
                keyword: kw,
                lat: resolvedCity.hit.lat,
                lon: resolvedCity.hit.lon,
                lang: opts.lang,
                country: resolvedCity.country,
                depth: opts.depth,
                maxSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
                city: resolvedCity.city,
                place: resolvedCity.city,
                signal,
              },
              (p) => {
                if (p.retryInSeconds !== undefined) {
                  report(
                    {
                      stage: "searching",
                      places: Math.min(unique.length, limit),
                      ...cityFields,
                      ...kwFields,
                      retryInSeconds: p.retryInSeconds,
                      ...(p.retry !== undefined ? { retry: p.retry } : {}),
                      ...(p.retries !== undefined ? { retries: p.retries } : {}),
                      message: retryMessage(p),
                    },
                    resolvedCity.location,
                  );
                  return;
                }
                if (p.found && !signal?.aborted) {
                  callEmitted += p.found.length;
                  absorb(p.found, kwStat, resolvedCity.country);
                }
                const shownCount = Math.min(unique.length, limit);
                report(
                  {
                    stage: "searching",
                    places: shownCount,
                    ...cityFields,
                    ...kwFields,
                    message: `${prefix}… ${shownCount} places`,
                  },
                  resolvedCity.location,
                );
              },
            );
          } catch (e) {
            stopIfCancelled("searching");
            throw e;
          }
          stopIfCancelled("searching");
          const callFound = Math.max(callEmitted, found.places.length);
          foundCount += callFound;
          kwStat.found += callFound;
          absorb(found.places, kwStat, resolvedCity.country);
          reason = found.reason;
          if (found.reason === "blocked" || found.reason === "timeout") {
            stopped = true;
            break;
          }
          if (unique.length >= limit) {
            reason = "depth";
            stopped = true;
            break;
          }
          continue;
        }

        const queue = buildGrid(resolvedCity.hit.bbox, { lat: resolvedCity.hit.lat, lon: resolvedCity.hit.lon });
        let cellsDone = 0;

        while (queue.length > 0) {
          stopIfCancelled("searching");
          if (unique.length >= limit) {
            reason = "depth";
            stopped = true;
            break;
          }
          const remainingMs = runDeadline - Date.now();
          if (remainingMs <= 0) {
            reason = "timeout";
            stopped = true;
            break;
          }

          const cell = queue.shift()!;
          cellsDone += 1;
          const cellsTotal = cellsDone + queue.length;
          const parts = [scopeLabel, `cell ${cellsDone} of ${cellsTotal}`].filter(Boolean).join(", ");
          const cellLabel = `Searching ${resolvedCity.where} (${parts})… ${Math.min(unique.length, limit)} places`;
          report(
            {
              stage: "searching",
              places: Math.min(unique.length, limit),
              cell: cellsDone,
              cells: cellsTotal,
              ...cityFields,
              ...kwFields,
              message: cellLabel,
            },
            resolvedCity.location,
          );

          const cellController = new AbortController();
          let limitStopped = false;
          const onUserAbort = () => cellController.abort();
          signal?.addEventListener("abort", onUserAbort, { once: true });

          let cellEmittedCount = 0;
          let cellResult: Awaited<ReturnType<PlaceSource["search"]>> | undefined;
          try {
            cellResult = await source.search(
              {
                keyword: kw,
                lat: cell.lat,
                lon: cell.lon,
                zoom: cell.zoom,
                lang: opts.lang,
                country: resolvedCity.country,
                depth: cellDepth,
                maxSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
                city: resolvedCity.city,
                signal: cellController.signal,
              },
              (p) => {
                if (p.retryInSeconds !== undefined) {
                  report(
                    {
                      stage: "searching",
                      places: Math.min(unique.length, limit),
                      cell: cellsDone,
                      cells: cellsTotal,
                      ...cityFields,
                      ...kwFields,
                      retryInSeconds: p.retryInSeconds,
                      ...(p.retry !== undefined ? { retry: p.retry } : {}),
                      ...(p.retries !== undefined ? { retries: p.retries } : {}),
                      message: retryMessage(p),
                    },
                    resolvedCity.location,
                  );
                  return;
                }
                if (p.found && !signal?.aborted) {
                  cellEmittedCount += p.found.length;
                  absorb(p.found, kwStat, resolvedCity.country);
                }
                const shownCount = Math.min(unique.length, limit);
                report(
                  {
                    stage: "searching",
                    places: shownCount,
                    cell: cellsDone,
                    cells: cellsTotal,
                    ...cityFields,
                    ...kwFields,
                    message: `Searching ${resolvedCity.where} (${parts})… ${shownCount} places`,
                  },
                  resolvedCity.location,
                );
                if (unique.length >= limit && !signal?.aborted) {
                  limitStopped = true;
                  cellController.abort();
                }
              },
            );
          } catch (e) {
            signal?.removeEventListener("abort", onUserAbort);
            stopIfCancelled("searching");
            if (limitStopped && e instanceof CancelledError) {
              foundCount += cellEmittedCount;
              kwStat.found += cellEmittedCount;
              reason = "depth";
              stopped = true;
              break;
            }
            throw e;
          }
          signal?.removeEventListener("abort", onUserAbort);
          stopIfCancelled("searching");

          const cellFound = Math.max(cellEmittedCount, cellResult.places.length);
          foundCount += cellFound;
          kwStat.found += cellFound;
          absorb(cellResult.places, kwStat, resolvedCity.country);
          reason = cellResult.reason;

          if (unique.length >= limit) {
            reason = "depth";
            stopped = true;
            break;
          }
          if (cellResult.reason === "blocked" || cellResult.reason === "timeout") {
            reason = cellResult.reason;
            stopped = true;
            break;
          }
          if (
            cellResult.places.length >= CELL_SPLIT_THRESHOLD &&
            canSplitCell(cell) &&
            cellsDone + queue.length + 4 <= MAX_TOTAL_CELLS
          ) {
            queue.unshift(...splitCell(cell));
          }
        }
      }
    }

    const keptCount = Math.min(limit, unique.length);
    const keptSlice = unique.slice(0, keptCount);
    // Ensure any rows not streamed during batches are added before enrichment.
    if (rows && emittedCount < keptCount) {
      const missingBatch: Lead[] = [];
      for (let i = 0; i < keptCount; i++) {
        if (emittedRows[i]) continue;
        const lead = toLead(keptSlice[i]!, uniqueCountries[i] ?? primaryCountry, fetchedAt);
        emittedRows[i] = { row: emittedCount, lead };
        emittedCount += 1;
        missingBatch.push(unchecked(lead));
      }
      if (missingBatch.length > 0) {
        try {
          rows.added(missingBatch);
        } catch {
          // A failing sink must not stop the run.
        }
      }
    }
    leads = keptSlice.map((p, i) => emittedRows[i]?.lead ?? toLead(p, uniqueCountries[i] ?? primaryCountry, fetchedAt));
    rowOf = keptSlice.map((_, i) => emittedRows[i]?.row);
    if (keywords.length > 1) {
      keywordSummaries = [...stats.values()].map((s) => ({
        keyword: s.keyword,
        found: s.found,
        added: s.added,
        duplicates: s.found - s.added,
      }));
    }
  }

  const keptCount = Math.min(limit, unique.length);
  debug("search_done", { ms: elapsed(), places: foundCount, unique: unique.length, reason });

  report({ stage: "checking_websites", places: keptCount, message: "Checking websites…" });
  // The checks end inside the run's time limit, but always get at least `MIN_CHECK_MS`.
  const budgetMs = Math.max(opts.maxSeconds * 1000 - elapsed(), deps.minCheckMs ?? MIN_CHECK_MS);
  debug("checks_budget", { ms: elapsed(), budgetMs });
  const enriched = await deps.enrich(
    leads,
    {
      emails: opts.emails,
      socials: opts.socials,
      deep: opts.deep,
      country: primaryCountry,
      debug,
      signal,
      budgetMs,
      ...(deps.finishChecks ? { finish: deps.finishChecks } : {}),
      ...(rows
        ? {
            onLead: (i: number, lead: Lead) => {
              const row = rowOf[i];
              if (row !== undefined && !signal?.aborted) rows.checked(row, lead);
            },
          }
        : {}),
    },
    (p) =>
      report({
        stage: "checking_websites",
        places: keptCount,
        checked: p.checked,
        toCheck: p.toCheck,
        ...(p.notChecked ? { notChecked: p.notChecked } : {}),
        message: p.notChecked
          ? `Checking websites… ${p.checked}/${p.toCheck}. ${skippedWebsitesLine(p.notChecked)}`
          : `Checking websites… ${p.checked}/${p.toCheck}`,
      }),
  );

  const reconciliation: Reconciliation = {
    found: foundCount,
    kept: keptCount,
    filtered: unique.length - keptCount,
    duplicates: foundCount - unique.length,
    ...enriched.counts,
  };
  debug("enrich_done", { ms: elapsed(), leads: enriched.leads.length });
  // Cancelled checks leave sites unaccounted for; that is not a bookkeeping bug.
  stopIfCancelled("checking_websites");
  checkBalanced(reconciliation, enriched.leads.length);

  const skipped = enriched.counts.notChecked ?? 0;
  const done = doneMessage(reason, keptCount, opts);
  report({ stage: "done", places: keptCount, message: skipped > 0 ? `${done} ${skippedWebsitesLine(skipped)}` : done });
  // The caller writes the file after this line; a log that ends here points at the writer.
  debug("run_done", { ms: elapsed(), leads: enriched.leads.length });
  return {
    leads: enriched.leads,
    reason,
    reconciliation,
    ...(keywordSummaries ? { keywords: keywordSummaries } : {}),
  };
}
