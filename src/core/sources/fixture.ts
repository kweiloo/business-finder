// A place source that replays prepared batch bodies, so every layer above the
// browser can be tested without a network or a browser.

import { CancelledError } from "../errors.js";
import type { RawPlace } from "../types.js";
import { parseBatch } from "./browser/fields.js";
import type { PlaceSource } from "./source.js";

/** Waits `ms`; rejects with `CancelledError` as soon as `signal` aborts. */
export function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type FixtureSourceOptions = {
  /** Wait this long before every batch after the first, the way scrolling Google Maps does. */
  batchDelayMs?: number;
};

/**
 * Replays `batches` (raw `/search?tbm=map` bodies) in order, up to `depth`.
 * Places are passed through verbatim, duplicates included, so the pipeline's
 * own dedupe and reconciliation can be exercised.
 */
export function fixtureSource(batches: string[], opts: FixtureSourceOptions = {}): PlaceSource {
  return {
    async search(q, onProgress) {
      const places: RawPlace[] = [];
      let read = 0;
      for (const body of batches) {
        if (read >= q.depth) return { places, reason: "depth" };
        if (read > 0 && opts.batchDelayMs) await cancellableDelay(opts.batchDelayMs, q.signal);
        read += 1;
        const found = parseBatch(body).map((place) => ({ ...place, source: "fixture" as const, query: q.keyword, city: q.city ?? "" }));
        places.push(...found);
        onProgress({ places: places.length, batches: read, found });
      }
      return { places, reason: "end-of-list" };
    },
  };
}
