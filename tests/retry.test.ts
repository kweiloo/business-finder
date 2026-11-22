import { describe, expect, it } from "vitest";
import { CancelledError } from "../src/core/errors.js";
import { BLOCK_RETRY_DELAYS_MS, withBlockRetry } from "../src/core/sources/retry.js";
import type { CollectReason, PlaceSource, SearchProgress, SearchQuery } from "../src/core/sources/source.js";
import type { RawPlace } from "../src/core/types.js";

const QUERY: SearchQuery = {
  keyword: "event management",
  lat: 3.15,
  lon: 101.7,
  lang: "en",
  country: "MY",
  depth: 3,
  maxSeconds: 300,
  city: "Kuala Lumpur",
};

const place = (n: number, extra: Partial<RawPlace> = {}): RawPlace => ({
  title: `Place ${n}`,
  place_id: `P${n}`,
  phone: `012-000 ${String(n).padStart(4, "0")}`,
  source: "fixture",
  query: "event management",
  city: "Kuala Lumpur",
  ...extra,
});

function scriptedSource(runs: Array<{ places: RawPlace[]; reason: CollectReason; emitFound?: boolean }>) {
  const queries: SearchQuery[] = [];
  let idx = 0;
  const source: PlaceSource = {
    async search(q, onProgress) {
      queries.push(q);
      const run = runs[idx++] ?? { places: [], reason: "end-of-list" as const };
      if (run.emitFound !== false && run.places.length > 0) {
        onProgress({ places: run.places.length, batches: 1, found: run.places });
      }
      return { places: run.places, reason: run.reason };
    },
  };
  return { source, queries };
}

describe("withBlockRetry", () => {
  it("uses [30_000, 90_000] as default backoff delays", () => {
    expect(BLOCK_RETRY_DELAYS_MS).toEqual([30_000, 90_000]);
  });

  it("retries once after a block, sleeps 30 s, merges places without duplicates, and reports retry progress", async () => {
    const p1 = place(1);
    const p2 = place(2);
    const p3 = place(3);
    const { source, queries } = scriptedSource([
      { places: [p1, p2], reason: "blocked" },
      { places: [p2, p3], reason: "end-of-list" },
    ]);
    const sleeps: number[] = [];
    let clock = 1_000;
    const progress: SearchProgress[] = [];

    const retried = withBlockRetry(source, {
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });

    const result = await retried.search(QUERY, (p) => progress.push(p));
    expect(queries).toHaveLength(2);
    expect(sleeps).toEqual([30_000]);
    expect(queries[1]!.maxSeconds).toBe(270);
    expect(result.reason).toBe("end-of-list");
    expect(result.places.map((p) => p.place_id)).toEqual(["P1", "P2", "P3"]);
    expect(progress.some((p) => p.retryInSeconds === 30 && p.retry === 1 && p.retries === 2)).toBe(true);
    expect(progress.at(-1)?.found?.map((p) => p.place_id)).toEqual(["P3"]);
  });

  it("replaces a names-only placeholder when a retry returns full details for the same place", async () => {
    const bare = { title: "Place 1", place_id: "P1", source: "browser" as const, query: "event management", city: "Kuala Lumpur" };
    const full = place(1, { source: "browser", address: "1 Jalan Ampang" });
    const { source } = scriptedSource([
      { places: [bare], reason: "blocked" },
      { places: [full], reason: "end-of-list" },
    ]);
    const progress: SearchProgress[] = [];

    const retried = withBlockRetry(source, { sleep: async () => {}, now: () => 0 });
    const result = await retried.search(QUERY, (p) => progress.push(p));
    expect(result.reason).toBe("end-of-list");
    expect(result.places).toEqual([full]);
    expect(progress.at(-1)?.found).toEqual([full]);
  });

  it("retries twice (30 s then 90 s) and returns blocked with merged places after exhausting attempts", async () => {
    const { source, queries } = scriptedSource([
      { places: [place(1)], reason: "blocked" },
      { places: [place(2)], reason: "blocked" },
      { places: [], reason: "blocked" },
    ]);
    const sleeps: number[] = [];
    let clock = 0;

    const retried = withBlockRetry(source, {
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });

    const result = await retried.search(QUERY, () => {});
    expect(queries).toHaveLength(3);
    expect(sleeps).toEqual([30_000, 90_000]);
    expect(result.reason).toBe("blocked");
    expect(result.places.map((p) => p.place_id)).toEqual(["P1", "P2"]);
  });

  it("does not wait when the backoff delay would pass the search time limit", async () => {
    let clock = 0;
    const source: PlaceSource = {
      async search() {
        clock += 40_000;
        return { places: [place(1)], reason: "blocked" };
      },
    };
    const sleeps: number[] = [];
    const retried = withBlockRetry(source, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => clock,
    });

    const result = await retried.search({ ...QUERY, maxSeconds: 60 }, () => {});
    expect(sleeps).toEqual([]);
    expect(result.reason).toBe("blocked");
    expect(result.places.map((p) => p.place_id)).toEqual(["P1"]);
  });

  it("cancels within 1 s with CancelledError when aborted during a 90 s block wait", async () => {
    const controller = new AbortController();
    let attempt = 0;
    const source: PlaceSource = {
      async search() {
        attempt += 1;
        return { places: [], reason: "blocked" };
      },
    };
    const retried = withBlockRetry(source);
    const t0 = Date.now();
    const promise = retried.search({ ...QUERY, signal: controller.signal }, () => {});
    // First attempt finishes immediately and enters the 30 s wait; cancel right away.
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(attempt).toBe(1);
  });
});
