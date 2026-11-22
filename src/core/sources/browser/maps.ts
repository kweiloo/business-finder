// Collects places from a Google Maps search page.
//
// Place data is never scraped from the DOM. The page is only scrolled; every
// `/search?...tbm=map` response it triggers is a JSON batch of ~20 full place
// entities, captured from the network and parsed by index path. The DOM is
// read only for control signals: is there a result list, has it ended, is
// Google showing its unusual-traffic page.

import { namesOnly } from "../../../jobs/dedupe.js";
import { dedupeKey } from "../../leads/normalize.js";
import type { CollectReason, SearchProgress } from "../source.js";
import type { CdpPage } from "./cdp.js";
import { addDerivedFields, parseBatch, parsePlaceLink, type BatchPlace } from "./fields.js";

/** The part of `CdpPage` the collector uses; tests supply a scripted stand-in. */
export type MapsPage = Pick<CdpPage, "navigate" | "eval" | "url" | "setCookie" | "onNetwork" | "responseBody">;

/** Pre-set so Google skips its cookie consent page. */
export const CONSENT_COOKIES = {
  CONSENT: "YES+cb.20210720-07-p0.en+FX+410",
  SOCS: "CAISHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiAo_CmBg",
} as const;

export const BATCH_URL = /^https:\/\/www\.google\.[a-z.]+\/search\?.*tbm=map/;

export type CollectTiming = {
  /** How long to wait for the first batch after the page loads. */
  firstBatchMs: number;
  /** After a scroll, how long to wait for a batch request to start. */
  settleMs: number;
  /** How long to wait for a started batch request to be answered. */
  slowBatchMs: number;
  pollMs: number;
};

export const DEFAULT_TIMING: CollectTiming = {
  firstBatchMs: 10_000,
  settleMs: 6_000,
  slowBatchMs: 45_000,
  pollMs: 250,
};

/**
 * Control signals read from the page on every check. `height` is the result
 * list's scroll height: Google renders a batch's places a few at a time as the
 * list scrolls, so a growing list means "keep scrolling", not "end of list".
 */
export type PageState = { feed: boolean; end: boolean; unusual: boolean; height: number };

const FEED = `div[role="feed"]`;

/** Page scripts, kept as constants so they are reviewed in one place. */
export const PAGE_SCRIPTS = {
  state: `(() => {
    const feed = document.querySelector('${FEED}');
    const end = !!document.querySelector('.HlvSq') || (!!feed && /reached the end/i.test(feed.innerText));
    const unusual = !feed && !!document.body && /unusual traffic/i.test(document.body.innerText);
    return { feed: !!feed, end, unusual, height: feed ? feed.scrollHeight : 0 };
  })()`,
  scroll: `(() => {
    const feed = document.querySelector('${FEED}');
    if (!feed) return false;
    feed.scrollTop = feed.scrollHeight;
    return true;
  })()`,
  feedLinks: `Array.from(document.querySelectorAll('${FEED} a[href*="/maps/place/"]'))
    .map((a) => ({ href: a.href, label: a.getAttribute('aria-label') || '' }))`,
  acceptConsent: `(() => {
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    const accept = buttons.find((b) => /^(accept all|i agree|reject all)$/i.test((b.innerText || b.value || '').trim()));
    if (!accept) return false;
    accept.click();
    return true;
  })()`,
} as const;

export type CollectOptions = {
  /** Country for reading national phone numbers in the dedupe key; defaults to the URL's `gl`. */
  country?: string;
  timing?: Partial<CollectTiming>;
  /** Receives every raw batch body, e.g. to save live captures. */
  onBody?: (body: string) => void;
};

export type CollectResult = {
  places: BatchPlace[];
  reason: CollectReason;
  /** `limited`: places without a review count, which Google's limited view drops. */
  stats: { batches: number; limited: number };
};

/** What goes into the Maps search box: "hotel in George Town", or the keyword alone without a place. */
export function mapsQuery(keyword: string, place?: string): string {
  const where = place?.trim();
  return where ? `${keyword} in ${where}` : keyword;
}

export function searchUrl(q: string, lat: number, lon: number, lang: string, country: string, zoom = 15): string {
  const params = new URLSearchParams({ hl: lang, gl: country });
  return `https://www.google.com/maps/search/${encodeURIComponent(q)}/@${lat},${lon},${zoom}z?${params}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isPlaceUrl = (url: string) => url.includes("/maps/place/");
const isSorryUrl = (url: string) => url.includes("/sorry/");
const isConsentUrl = (url: string) => /^https:\/\/consent\.google\./.test(url);

function countryFromUrl(url: string): string {
  try {
    return new URL(url).searchParams.get("gl") ?? "";
  } catch {
    return "";
  }
}

/** A place from a `/maps/place/` link, without the fields the link does not carry. */
function placeFromLink(href: string, label?: string): BatchPlace | undefined {
  const link = parsePlaceLink(href, label);
  if (!link.title) return undefined;
  const place: BatchPlace = { title: link.title, link: link.link };
  if (link.data_id) place.data_id = link.data_id;
  if (link.cid) place.cid = link.cid;
  if (link.place_id) place.place_id = link.place_id;
  if (link.latitude !== undefined) place.latitude = link.latitude;
  if (link.longitude !== undefined) place.longitude = link.longitude;
  return addDerivedFields(place);
}

/**
 * Opens `url`, scrolls the result list and collects places from the batches
 * it loads, until `depth` batches, the end of the list, no growth, a block or
 * `maxSeconds`. Places read before a block are kept. Places are deduped on
 * `dedupeKey` within this call.
 */
export async function collectPlaces(
  page: MapsPage,
  url: string,
  depth: number,
  maxSeconds: number,
  onBatch: (p: Omit<SearchProgress, "found"> & { found: BatchPlace[] }) => void,
  opts: CollectOptions = {},
): Promise<CollectResult> {
  const timing = { ...DEFAULT_TIMING, ...opts.timing };
  const country = opts.country ?? countryFromUrl(url);
  const deadline = Date.now() + maxSeconds * 1000;

  const places: BatchPlace[] = [];
  const seen = new Set<string>();
  // Keyed by request id: a redirect re-sends `request` with the same id.
  const inFlight = new Set<string>();
  const reading = new Set<Promise<void>>();
  let requests = 0;
  let batches = 0;
  let blocked = false;

  const absorb = (body: string) => {
    opts.onBody?.(body);
    const found: BatchPlace[] = [];
    for (const place of parseBatch(body)) {
      const key = dedupeKey(place, country);
      if (seen.has(key)) continue;
      seen.add(key);
      places.push(place);
      found.push(place);
    }
    batches += 1;
    onBatch({ places: places.length, batches, found });
  };

  const off = page.onNetwork({
    request(id, requestUrl) {
      if (inFlight.has(id) || !BATCH_URL.test(requestUrl)) return;
      inFlight.add(id);
      requests += 1;
    },
    response(id, _responseUrl, status) {
      if (!inFlight.has(id)) return;
      if (status === 429) {
        blocked = true;
        inFlight.delete(id);
        return;
      }
      if (status >= 400) {
        inFlight.delete(id);
        return;
      }
      // Stays in flight until the body is read, so "answered" means "places counted".
      const job: Promise<void> = page
        .responseBody(id)
        .then(absorb, () => undefined)
        .finally(() => {
          inFlight.delete(id);
          reading.delete(job);
        });
      reading.add(job);
    },
    // A 429 can surface only as a failed load; the page check below catches that case.
    failed(id) {
      inFlight.delete(id);
    },
  });

  let state: PageState = { feed: false, end: false, unusual: false, height: 0 };
  let currentUrl = url;
  let consentClicked = false;

  /** Refreshes `state` and `currentUrl`; flags a block from the page itself. */
  const check = async () => {
    currentUrl = await page.url().catch(() => currentUrl);
    // The script context is torn down during navigations; keep the last state then.
    state = await page.eval<PageState>(PAGE_SCRIPTS.state).catch(() => state);
    if (isSorryUrl(currentUrl) || state.unusual || (consentClicked && isConsentUrl(currentUrl))) blocked = true;
  };

  /**
   * Polls until `done()` (true) or `ms` pass (false), never past the deadline.
   * `giveUp`, when given, runs on each poll and ends the wait early (false).
   */
  const waitUntil = async (done: () => boolean, ms: number, giveUp?: () => Promise<boolean>): Promise<boolean> => {
    const until = Math.min(Date.now() + ms, deadline);
    for (;;) {
      if (done()) return true;
      if (blocked) return false;
      if (giveUp && (await giveUp())) return done();
      const left = until - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(timing.pollMs, left));
    }
  };

  const idle = () => inFlight.size === 0 && reading.size === 0;

  const finish = async (reason: CollectReason): Promise<CollectResult> => {
    await Promise.allSettled([...reading]);
    off();
    let result = places;
    if (reason !== "blocked" && reason !== "no-feed" && places.length === 0 && state.feed) {
      const links = await page.eval<{ href: string; label: string }[]>(PAGE_SCRIPTS.feedLinks).catch(() => []);
      const fromLinks = links.map((l) => placeFromLink(l.href, l.label)).filter((p): p is BatchPlace => !!p);
      if (fromLinks.length > 0) {
        result = [];
        for (const place of fromLinks) {
          const key = dedupeKey(place, country);
          if (seen.has(key)) continue;
          seen.add(key);
          result.push(place);
        }
        reason = "dom-fallback";
      }
    }
    if (reason !== "blocked" && places.length > 0 && namesOnly(result)) {
      reason = "blocked";
    }
    const limited = result.filter((p) => p.review_count === undefined).length;
    return { places: result, reason, stats: { batches, limited } };
  };

  try {
    for (const [name, value] of Object.entries(CONSENT_COOKIES)) await page.setCookie(name, value, ".google.com");
    await page.navigate(url);

    // Wait for the first batch, a single-place page or a block. A query that
    // resolves to one place is answered with an entry-less batch first and
    // switches the URL to `/maps/place/` seconds later, so a batch alone does
    // not end the wait until the result list is there too.
    const firstUntil = Date.now() + timing.firstBatchMs;
    for (;;) {
      await check();
      if (blocked) return await finish("blocked");
      if (isConsentUrl(currentUrl) && !consentClicked) {
        consentClicked = true;
        await page.eval<boolean>(PAGE_SCRIPTS.acceptConsent).catch(() => false);
      }
      if (!state.feed && isPlaceUrl(currentUrl)) break;
      if (state.feed && batches > 0 && idle()) break;
      if (Date.now() >= firstUntil || Date.now() >= deadline) break;
      await sleep(timing.pollMs);
    }

    if (!state.feed) {
      if (isPlaceUrl(currentUrl)) {
        off();
        const place = placeFromLink(currentUrl);
        if (place) return { places: [place], reason: "single", stats: { batches, limited: 1 } };
      }
      if (isConsentUrl(currentUrl)) return await finish("blocked");
      return await finish("no-feed");
    }

    let silentScrolls = 0;
    let staleScrolls = 0;
    for (;;) {
      if (blocked) return await finish("blocked");
      if (batches >= depth) return await finish("depth");
      if (state.end) return await finish("end-of-list");
      if (Date.now() >= deadline) return await finish("timeout");

      const requestsBefore = requests;
      const placesBefore = places.length;
      const heightBefore = state.height;
      await page.eval<boolean>(PAGE_SCRIPTS.scroll).catch(() => false);

      // Wait for the scroll to either start a batch request or render more of the list.
      let grew = false;
      const sent = await waitUntil(() => requests > requestsBefore, timing.settleMs, async () => {
        await check();
        grew = state.height > heightBefore;
        return grew;
      });
      if (!sent) {
        if (blocked || state.end || Date.now() >= deadline) continue;
        if (grew) {
          silentScrolls = 0;
          continue;
        }
        silentScrolls += 1;
        if (silentScrolls >= 2) return await finish("end-of-list");
        continue;
      }
      silentScrolls = 0;

      await waitUntil(idle, timing.slowBatchMs);
      await check();
      if (places.length === placesBefore) {
        staleScrolls += 1;
        if (staleScrolls >= 2 && !blocked && !state.end) return await finish("no-growth");
      } else {
        staleScrolls = 0;
      }
    }
  } finally {
    off();
  }
}
