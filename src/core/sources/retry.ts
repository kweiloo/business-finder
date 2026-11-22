// Retries a blocked Google Maps search with backoff. Sleeps honour the
// run's AbortSignal so cancelling during a wait ends immediately.

import { CancelledError } from "../errors.js";
import { dedupeKey } from "../leads/normalize.js";
import type { RawPlace } from "../types.js";
import { cancellableDelay } from "./fixture.js";
import type { CollectReason, PlaceSource } from "./source.js";

export const BLOCK_RETRY_DELAYS_MS: readonly number[] = [30_000, 90_000];

export type BlockRetryOptions = {
  delaysMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

const hasDetails = (p: Pick<RawPlace, "website" | "phone" | "address">) =>
  Boolean(p.website?.trim() || p.phone?.trim() || p.address?.trim());

/**
 * Wraps `source` so a `"blocked"` result waits through `delaysMs` and tries
 * again with the remaining `maxSeconds`. On a non-blocked first attempt the
 * source's progress and raw places pass through unchanged; across retries,
 * places are merged by `dedupeKey`, replacing any earlier names-only entry
 * when a retry reads full details.
 */
export function withBlockRetry(source: PlaceSource, opts: BlockRetryOptions = {}): PlaceSource {
  const delaysMs = opts.delaysMs ?? BLOCK_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? cancellableDelay;
  const now = opts.now ?? Date.now;

  return {
    async search(q, onProgress) {
      const startedAt = now();
      const merged: RawPlace[] = [];
      const seen = new Map<string, number>();
      let totalBatches = 0;

      const absorb = (place: RawPlace): boolean => {
        const key = dedupeKey(place, q.country);
        const existingIdx = seen.get(key);
        if (existingIdx === undefined) {
          seen.set(key, merged.length);
          merged.push(place);
          return true;
        }
        if (!hasDetails(merged[existingIdx]!) && hasDetails(place)) {
          merged[existingIdx] = place;
          return true;
        }
        return false;
      };

      let lastReason: CollectReason = "end-of-list";
      for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
        if (q.signal?.aborted) throw new CancelledError();
        const remainingSeconds =
          attempt === 0 ? q.maxSeconds : Math.max(1, Math.ceil((q.maxSeconds * 1000 - (now() - startedAt)) / 1000));

        let attemptBatches = 0;
        const result = await source.search({ ...q, maxSeconds: remainingSeconds }, (p) => {
          const delta = Math.max(1, p.batches - attemptBatches);
          attemptBatches = p.batches;
          totalBatches += delta;
          if (attempt === 0) {
            for (const place of p.found ?? []) absorb(place);
            onProgress(p);
            return;
          }
          const newFound = (p.found ?? []).filter(absorb);
          onProgress({
            places: merged.length,
            batches: totalBatches,
            ...(newFound.length > 0 ? { found: newFound } : {}),
          });
        });

        if (attempt === 0 && result.reason !== "blocked") {
          return result;
        }
        for (const place of result.places) absorb(place);
        lastReason = result.reason;
        if (result.reason !== "blocked" || attempt >= delaysMs.length) {
          return { places: merged, reason: lastReason };
        }

        const delayMs = delaysMs[attempt]!;
        const remainingMs = q.maxSeconds * 1000 - (now() - startedAt);
        if (delayMs >= remainingMs) {
          return { places: merged, reason: "blocked" };
        }

        onProgress({
          places: merged.length,
          batches: totalBatches,
          retryInSeconds: delayMs > 0 ? Math.max(1, Math.round(delayMs / 1000)) : 0,
          retry: attempt + 1,
          retries: delaysMs.length,
        });
        await sleep(delayMs, q.signal);
      }

      return { places: merged, reason: lastReason };
    },
  };
}
