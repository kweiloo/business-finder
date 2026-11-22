import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserFacingError } from "../src/core/errors.js";
import { runScrape, type ScrapeProgress } from "../src/core/pipeline.js";
import { FixtureFileError, loadFixtureDeps } from "../src/core/sources/fixture-file.js";
import type { RunOptions } from "../src/core/types.js";
import { hit, MELAKA_CITY, MELAKA_STATE, PENANG } from "./fixtures/nominatim.js";
import { makeBatch } from "./fixtures/batch.js";
import { RUN20_BATCH, RUN20_SITES_DIR } from "./fixtures/run20.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-fixture-file-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(data: unknown): string {
  const file = path.join(dir, "fixture.json");
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  return file;
}

const GEO = { lat: 2.3, lon: 102.2, countryCode: "MY" };
const QUERY = { keyword: "souvenir shop", lat: 0, lon: 0, lang: "en", country: "MY", depth: 1, maxSeconds: 60, city: "Melaka" };

describe("loadFixtureDeps", () => {
  it("replays the batches and answers geocoding from the file", async () => {
    const deps = await loadFixtureDeps(write({ geocode: GEO, batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR }));
    expect(await deps.geocode("anywhere")).toEqual({
      kind: "place",
      hit: { name: "anywhere", addresstype: "place", ...GEO, bbox: { south: 2.3, north: 2.3, west: 102.2, east: 102.2 } },
    });
    const { places, reason } = await deps.source.search(QUERY, () => {});
    expect(places).toHaveLength(20);
    expect(reason).toBe("end-of-list");
  });

  it("answers a null geocode as not found", async () => {
    const deps = await loadFixtureDeps(write({ geocode: null, batches: [], sitesDir: "." }));
    expect(await deps.geocode("Atlantis")).toBeNull();
  });

  it("runs geocodeHits through the hit rule, ahead of geocode", async () => {
    const hits = [hit(MELAKA_STATE), hit(MELAKA_CITY)];
    const deps = await loadFixtureDeps(write({ geocode: GEO, geocodeHits: hits, batches: [], sitesDir: "." }));
    expect(await deps.geocode("Melaka")).toEqual({ kind: "place", hit: hit(MELAKA_CITY), region: hit(MELAKA_STATE) });
    const alone = await loadFixtureDeps(write({ geocodeHits: [hit(PENANG)], batches: [], sitesDir: "." }));
    expect(await alone.geocode("Penang")).toEqual({ kind: "region", hit: hit(PENANG) });
  });

  it("ends the search with the reason given in the file", async () => {
    const deps = await loadFixtureDeps(
      write({ geocode: GEO, batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR, reason: "blocked" }),
    );
    const { places, reason } = await deps.source.search(QUERY, () => {});
    expect(reason).toBe("blocked");
    expect(places).toHaveLength(20);
  });

  it("supports blockedAttempts, blockRetryDelaysMs and cellBatches", async () => {
    const cell1 = makeBatch([{ title: "Cell1", place_id: "P1" }]);
    const cell2 = makeBatch([{ title: "Cell2", place_id: "P2" }]);
    const deps = await loadFixtureDeps(
      write({
        geocode: GEO,
        batches: [],
        cellBatches: [[cell1], [cell2]],
        sitesDir: RUN20_SITES_DIR,
        blockedAttempts: 1,
        blockRetryDelaysMs: [25],
      }),
    );
    expect(deps.blockRetry?.delaysMs).toEqual([25]);
    const first = await deps.source.search(QUERY, () => {});
    expect(first).toEqual({ places: [], reason: "blocked" });
    const second = await deps.source.search(QUERY, () => {});
    expect(second.places.map((p) => p.place_id)).toEqual(["P1"]);
    const third = await deps.source.search(QUERY, () => {});
    expect(third.places.map((p) => p.place_id)).toEqual(["P2"]);
    const fourth = await deps.source.search(QUERY, () => {});
    expect(fourth.places.map((p) => p.place_id)).toEqual(["P1"]);
  });

  it("throws FixtureFileError for a missing file", async () => {
    await expect(loadFixtureDeps(path.join(dir, "nope.json"))).rejects.toBeInstanceOf(FixtureFileError);
  });

  it("throws FixtureFileError for invalid JSON", async () => {
    await expect(loadFixtureDeps(write("{not json"))).rejects.toBeInstanceOf(FixtureFileError);
  });

  it.each([
    [{ batches: [], sitesDir: "." }],
    [{ geocode: GEO, batches: [1], sitesDir: "." }],
    [{ geocode: GEO, batches: [] }],
    [{ geocode: GEO, batches: [], sitesDir: ".", reason: "melted" }],
    [{ geocodeHits: [{ name: "Melaka" }], batches: [], sitesDir: "." }],
    [{ geocodeHits: "Melaka", batches: [], sitesDir: "." }],
  ])("throws FixtureFileError for the malformed file %j", async (data) => {
    await expect(loadFixtureDeps(write(data))).rejects.toThrow(FixtureFileError);
  });
});

describe("runScrape on a fixture with geocodeHits", () => {
  const OPTS: RunOptions = {
    keyword: "souvenir shop", city: "Melaka", depth: 1, lang: "en", emails: true, socials: true, deep: false, maxSeconds: 60,
  };
  const now = () => new Date("2026-11-18T00:00:00.000Z");

  it("searches Melaka at Bandaraya Melaka", async () => {
    const deps = await loadFixtureDeps(
      write({ geocodeHits: [hit(MELAKA_STATE), hit(MELAKA_CITY)], batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR }),
    );
    const queries: { lat: number; lon: number }[] = [];
    const source = { search: (q: Parameters<typeof deps.source.search>[0], p: Parameters<typeof deps.source.search>[1]) => {
      queries.push({ lat: q.lat, lon: q.lon });
      return deps.source.search(q, p);
    } };
    const seen: ScrapeProgress[] = [];
    await runScrape(OPTS, { ...deps, source, now }, (p) => seen.push(p));
    expect(queries).toEqual([{ lat: 2.1942647, lon: 102.2486651 }]);
    expect(seen.find((p) => p.stage === "searching")?.message).toBe("Searching Melaka (Bandaraya Melaka, Malaysia)… 0 places");
  });

  it("stops on Penang before the source is called", async () => {
    const deps = await loadFixtureDeps(write({ geocodeHits: [hit(PENANG)], batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR }));
    let searched = false;
    const source = { search: () => {
      searched = true;
      throw new Error("searched");
    } };
    const run = runScrape({ ...OPTS, city: "Penang" }, { ...deps, source, now }, () => {});
    await expect(run).rejects.toBeInstanceOf(UserFacingError);
    expect(searched).toBe(false);
  });
});
