// The browser place source: a local Chromium driven over CDP, no API key.

import { existsSync } from "node:fs";
import { debugLogFromEnv, type DebugLog } from "../../debugLog.js";
import { CancelledError } from "../../errors.js";
import type { PlaceSource } from "../source.js";
import { CdpConnection, CdpPage } from "./cdp.js";
import { chromeUserAgent, findBrowser, launchBrowser } from "./launch.js";
import type { BatchPlace } from "./fields.js";
import { collectPlaces, mapsQuery, searchUrl, type CollectTiming } from "./maps.js";

export class BrowserNotFoundError extends Error {
  override name = "BrowserNotFoundError";
  constructor(
    message: string,
    readonly searched: string[],
  ) {
    super(message);
  }
}

export type BrowserSourceOptions = {
  /** Defaults to true; a visible window helps when diagnosing a block. */
  headless?: boolean;
  /** Receives every raw batch body, e.g. to save live captures. */
  onBody?: (body: string) => void;
  timing?: Partial<CollectTiming>;
  /** Defaults to the BUSINESS_FINDER_DEBUG_LOG file, if set. */
  debug?: DebugLog;
};

/**
 * Each search launches a browser with a private throwaway profile, collects
 * one keyword in its own browser context and closes everything again.
 * Aborting `q.signal` closes the browser at once; the search then rejects
 * with `CancelledError`.
 */
export function browserSource(opts: BrowserSourceOptions = {}): PlaceSource {
  return {
    async search(q, onProgress) {
      const found = findBrowser(process.env, existsSync, process.platform);
      if ("error" in found) throw new BrowserNotFoundError(found.error, found.searched);

      const debug = opts.debug ?? debugLogFromEnv();
      const since = (t: number) => Math.round(performance.now() - t);
      let cancelAt: number | undefined;
      const markCancel = () => (cancelAt = performance.now());
      q.signal?.addEventListener("abort", markCancel, { once: true });
      // A cancel during start-up stops launchBrowser, which closes the browser
      // and throws CancelledError.
      let browser: Awaited<ReturnType<typeof launchBrowser>>;
      try {
        browser = await launchBrowser(found.path, { headless: opts.headless ?? true, signal: q.signal }, { debug });
      } catch (e) {
        q.signal?.removeEventListener("abort", markCancel);
        if (cancelAt !== undefined) debug("browser_search_cancelled", { ms: since(cancelAt) });
        throw e;
      }
      // From here a cancel closes the browser and ends the search at once.
      // Neither the connect nor collectPlaces (which keeps polling a closed
      // connection until its own limits end it) is waited for: both are raced
      // against `cancelled`.
      let rejectCancelled: (e: Error) => void = () => {};
      const cancelled = new Promise<never>((_, reject) => (rejectCancelled = reject));
      cancelled.catch(() => {}); // Observed only through Promise.race below.
      const onAbort = () => {
        rejectCancelled(new CancelledError());
        void browser.close();
      };
      const stopIfCancelled = () => {
        if (q.signal?.aborted) throw new CancelledError();
      };
      let conn: CdpConnection | undefined;
      q.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        stopIfCancelled();
        const connectStart = performance.now();
        const connecting = CdpConnection.connect(browser.wsUrl);
        // A connection that opens after a cancel won the race is closed again.
        connecting.then((c) => q.signal?.aborted && c.close(), () => {});
        conn = await Promise.race([connecting, cancelled]);
        debug("cdp_connected", { ms: since(connectStart) });
        stopIfCancelled();
        const { userAgent } = await conn.send<{ userAgent: string }>("Browser.getVersion");
        const page = await CdpPage.open(conn, { userAgent: chromeUserAgent(userAgent), lang: q.lang });
        try {
          const url = searchUrl(mapsQuery(q.keyword, q.place), q.lat, q.lon, q.lang, q.country, q.zoom);
          const tag = (p: BatchPlace) => ({ ...p, source: "browser" as const, query: q.keyword, city: q.city ?? "" });
          const onBatch = (p: { places: number; batches: number; found: BatchPlace[] }) =>
            onProgress({ places: p.places, batches: p.batches, found: p.found.map(tag) });
          const collecting = collectPlaces(page, url, q.depth, q.maxSeconds, onBatch, {
            country: q.country,
            ...(opts.onBody ? { onBody: opts.onBody } : {}),
            ...(opts.timing ? { timing: opts.timing } : {}),
          });
          collecting.catch(() => {}); // A cancelled collection's late result is dropped.
          const result = await Promise.race([collecting, cancelled]);
          stopIfCancelled();
          return {
            places: result.places.map(tag),
            reason: result.reason,
          };
        } finally {
          await page.close();
        }
      } catch (e) {
        stopIfCancelled();
        throw e;
      } finally {
        q.signal?.removeEventListener("abort", onAbort);
        q.signal?.removeEventListener("abort", markCancel);
        conn?.close();
        await browser.close();
        if (cancelAt !== undefined) debug("browser_search_cancelled", { ms: since(cancelAt) });
      }
    },
  };
}
