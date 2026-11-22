import { describe, expect, it } from "vitest";
import type { enrichLeads } from "../src/core/enrich/enrich.js";
import { CANCELLED_MESSAGE, CancelledError, ReconciliationError, UserFacingError } from "../src/core/errors.js";
import { chooseHit, type Geocode } from "../src/core/geo/geocode.js";
import { runScrape, BLOCKED_MESSAGE, type ScrapeProgress } from "../src/core/pipeline.js";
import { fixtureSource } from "../src/core/sources/fixture.js";
import type { PlaceSource, SearchQuery } from "../src/core/sources/source.js";
import type { Lead, RawPlace, RunOptions } from "../src/core/types.js";
import { makeBatch } from "./fixtures/batch.js";
import { BANGKOK, CALIFORNIA, hit, KUALA_LUMPUR, MELAKA_CITY, MELAKA_STATE, PENANG, SG_CITY, SG_COUNTRY } from "./fixtures/nominatim.js";
import { run20Enrich, run20Source } from "./fixtures/run20.js";

const NOW = new Date("2026-11-17T08:00:00.000Z");
const MELAKA = { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" };
const MELAKA_GEO: Awaited<ReturnType<Geocode>> = { kind: "place", hit: { ...hit(MELAKA_STATE), ...MELAKA } };

const OPTS: RunOptions = {
  keyword: "souvenir shop",
  city: "Melaka",
  depth: 1,
  lang: "en",
  emails: true,
  socials: true,
  deep: false,
  maxSeconds: 600,
};

type Deps = Parameters<typeof runScrape>[1];

function deps(over: Partial<Deps> = {}): Deps {
  return {
    source: run20Source(),
    geocode: async () => MELAKA_GEO,
    enrich: run20Enrich,
    now: () => NOW,
    ...over,
  };
}

function stubSource(places: Omit<RawPlace, "source" | "query" | "city">[], reason: "blocked" | "end-of-list"): PlaceSource & { queries: SearchQuery[] } {
  const queries: SearchQuery[] = [];
  return {
    queries,
    async search(q, onProgress) {
      queries.push(q);
      onProgress({ places: places.length, batches: 1 });
      return { places: places.map((p) => ({ ...p, source: "fixture", query: q.keyword, city: q.city ?? "" })), reason };
    },
  };
}

describe("runScrape on the 20-place fixture", () => {
  it("drops the duplicate and balances both reconciliation equations", async () => {
    const result = await runScrape(OPTS, deps(), () => {});
    expect(result.reason).toBe("end-of-list");
    expect(result.leads).toHaveLength(19);
    expect(result.reconciliation).toEqual({
      found: 20,
      kept: 19,
      filtered: 0,
      duplicates: 1,
      toCheck: 10,
      fetched: 10,
      unreachable: 0,
      mismatched: 0,
      skipped: 0,
    });
    expect(result.leads.map((l) => l.title)).not.toContain("ZZMARK-20");
    expect(result.leads.filter((l) => l.whatsapp)).toHaveLength(12);
    expect(result.leads.filter((l) => l.emails.length)).toHaveLength(10);
    expect(result.leads[0]!.emails).toEqual(["zzmark1@shop-1.test"]);
  });

  it("counts places beyond the limit as filtered", async () => {
    const result = await runScrape({ ...OPTS, limit: 5 }, deps(), () => {});
    expect(result.leads.map((l) => l.title)).toEqual(["ZZMARK-1", "ZZMARK-2", "ZZMARK-3", "ZZMARK-4", "ZZMARK-5"]);
    expect(result.reconciliation).toMatchObject({ found: 20, kept: 5, filtered: 14, duplicates: 1, toCheck: 5, fetched: 5 });
  });

  it("stamps every lead with the injected clock", async () => {
    const result = await runScrape(OPTS, deps(), () => {});
    expect(new Set(result.leads.map((l) => l.fetched_at))).toEqual(new Set([NOW.toISOString()]));
  });

  it("reports stages in order and ends with a plain-English done message", async () => {
    const seen: ScrapeProgress[] = [];
    await runScrape(OPTS, deps(), (p) => seen.push(p));
    const stages = seen.map((p) => p.stage).filter((s, i, all) => s !== all[i - 1]);
    expect(stages).toEqual(["geocoding", "searching", "checking_websites", "done"]);
    expect(seen.find((p) => p.stage === "searching" && p.places === 20)?.message).toBe("Searching Melaka, Malaysia… 20 places");
    expect(seen.some((p) => p.stage === "checking_websites" && p.checked === 10 && p.toCheck === 10)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ stage: "done", places: 19, message: "Found 19 leads in Melaka." });
  });

  it("keeps running when a progress listener throws", async () => {
    const result = await runScrape(OPTS, deps(), () => {
      throw new Error("listener failed");
    });
    expect(result.leads).toHaveLength(19);
  });
});

describe("runScrape reconciliation guard", () => {
  it("throws ReconciliationError when the enrichment counts do not add up", async () => {
    const enrich: typeof enrichLeads = async (leads) => ({
      leads,
      counts: { toCheck: 10, fetched: 8, unreachable: 1, mismatched: 0, skipped: 0 },
    });
    const run = runScrape(OPTS, deps({ enrich }), () => {});
    await expect(run).rejects.toBeInstanceOf(ReconciliationError);
    await expect(run).rejects.toThrow("sites to check 10 ≠ fetched 8 + unreachable 1 + mismatched 0 + skipped 0");
  });

  it("throws ReconciliationError when enrichment loses a lead", async () => {
    const enrich: typeof enrichLeads = async (leads) => ({
      leads: leads.slice(1),
      counts: { toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 },
    });
    await expect(runScrape(OPTS, deps({ enrich }), () => {})).rejects.toBeInstanceOf(ReconciliationError);
  });
});

describe("runScrape geocoding", () => {
  it("turns an unknown city into a UserFacingError", async () => {
    const run = runScrape({ ...OPTS, city: "Atlantis" }, deps({ geocode: async () => null }), () => {});
    await expect(run).rejects.toBeInstanceOf(UserFacingError);
    await expect(run).rejects.toThrow(/^City not found: Atlantis$/);
  });

  it("turns a network failure into a UserFacingError without technical detail", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND nominatim.openstreetmap.org");
    }) as Geocode;
    const error = await runScrape(OPTS, deps({ geocode: failing }), () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as Error).message).toBe(
      "Could not look up Melaka on the map. Check your internet connection and try again.",
    );
    expect((error as Error).message).not.toMatch(/ENOTFOUND|\n\s+at /);
  });

  it("refuses a state with no city of that name before searching Google", async () => {
    const source = stubSource([], "end-of-list");
    const seen: ScrapeProgress[] = [];
    const run = runScrape({ ...OPTS, city: "Penang" }, deps({ source, geocode: async () => chooseHit([hit(PENANG)]) }), (p) => seen.push(p));
    await expect(run).rejects.toBeInstanceOf(UserFacingError);
    await expect(run).rejects.toThrow(/^Penang is a whole state, too large for one search\. Search towns inside it instead; you can give several at once\.$/);
    expect(source.queries).toEqual([]);
    expect(seen.map((p) => p.stage)).toEqual(["geocoding"]);
  });

  it("searches the city a state resolves to and names it in the progress", async () => {
    const source = stubSource([], "end-of-list");
    const seen: ScrapeProgress[] = [];
    await runScrape(OPTS, deps({ source, geocode: async () => chooseHit([hit(MELAKA_STATE), hit(MELAKA_CITY)]) }), (p) => seen.push(p));
    expect(source.queries[0]).toMatchObject({ lat: 2.1942647, lon: 102.2486651, country: "MY", city: "Melaka" });
    expect(seen.find((p) => p.stage === "searching")?.message).toBe("Searching Melaka (Bandaraya Melaka, Malaysia)… 0 places");
    expect(seen[0]!.location).toBeUndefined();
    for (const p of seen.slice(1)) {
      expect(p.location).toEqual({ name: "Bandaraya Melaka", addresstype: "city", lat: 2.1942647, lon: 102.2486651, label: "Bandaraya Melaka, Malaysia" });
    }
  });

  it("searches a small state as it is and keeps the plain message when the name matches", async () => {
    const source = stubSource([], "end-of-list");
    const seen: ScrapeProgress[] = [];
    const city = "kuala lumpur";
    await runScrape({ ...OPTS, city }, deps({ source, geocode: async () => chooseHit([hit(KUALA_LUMPUR)]) }), (p) => seen.push(p));
    expect(source.queries[0]).toMatchObject({ lat: 3.1516964, lon: 101.6942371 });
    expect(seen.find((p) => p.stage === "searching")?.message).toBe("Searching Kuala Lumpur, Malaysia… 0 places");
  });

  it("searches in the geocoded country unless one is given", async () => {
    const place = { title: "ZZMARK-1", phone: "012-000 0001" };
    const fromGeo = stubSource([place], "end-of-list");
    const geoRun = await runScrape(OPTS, deps({ source: fromGeo }), () => {});
    expect(fromGeo.queries[0]).toMatchObject({ country: "MY", lat: MELAKA.lat, lon: MELAKA.lon, city: "Melaka", lang: "en", depth: 1, maxSeconds: 600 });
    expect(geoRun.leads[0]!.whatsapp).toBe("https://wa.me/60120000001");

    const given = stubSource([place], "end-of-list");
    const sgGeo: Awaited<ReturnType<Geocode>> = chooseHit([hit(SG_CITY)]);
    const sgRun = await runScrape({ ...OPTS, city: "Singapore", country: "sg" }, deps({ source: given, geocode: async () => sgGeo }), () => {});
    expect(given.queries[0]!.country).toBe("SG");
    expect(sgRun.leads[0]!.whatsapp).toBe("");
  });
});

describe("runScrape dedupe", () => {
  it("merges places without ids that share a national-format phone", async () => {
    const source = fixtureSource([
      makeBatch([
        { title: "ZZMARK-1", phone: "012-000 0001" },
        { title: "ZZMARK-1 Branch", phone: "+60 12-000 0001" },
        { title: "ZZMARK-2", phone: "012-000 0002" },
      ]),
    ]);
    const result = await runScrape(OPTS, deps({ source }), () => {});
    expect(result.leads.map((l) => l.title)).toEqual(["ZZMARK-1", "ZZMARK-2"]);
    expect(result.reconciliation).toMatchObject({ found: 3, kept: 2, duplicates: 1 });
  });

  it("merges two national-format phones written differently", async () => {
    const source = fixtureSource([
      makeBatch([
        { title: "ZZMARK-1", phone: "012-000 0001" },
        { title: "ZZMARK-9", phone: "0120000001" },
      ]),
    ]);
    const result = await runScrape(OPTS, deps({ source }), () => {});
    expect(result.leads).toHaveLength(1);
    expect(result.reconciliation).toMatchObject({ found: 2, kept: 1, duplicates: 1 });
  });
});

describe("runScrape when Google blocks the search", () => {
  it("keeps the places already read and ends with the blocked message", async () => {
    const places = Array.from({ length: 7 }, (_, i) => ({ title: `ZZMARK-${i + 1}`, place_id: `ZZPLACE-${i + 1}` }));
    const seen: ScrapeProgress[] = [];
    const result = await runScrape(OPTS, deps({ source: stubSource(places, "blocked"), blockRetry: { delaysMs: [] } }), (p) => seen.push(p));
    expect(result.reason).toBe("blocked");
    expect(result.leads).toHaveLength(7);
    expect(result.reconciliation).toMatchObject({ found: 7, kept: 7, filtered: 0, duplicates: 0 });
    expect(BLOCKED_MESSAGE).toBe("Google Maps stopped answering searches from this computer for now. Wait a few minutes, then try again.");
    expect(seen.at(-1)).toMatchObject({ stage: "done", places: 7, message: BLOCKED_MESSAGE });
  });
});

describe("runScrape when the run is cancelled", () => {
  it("stops during the search with CancelledError and never checks websites", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const source: PlaceSource = {
      search: (q) =>
        new Promise((_, reject) => {
          seen = q.signal;
          // A closed browser rejects its pending calls with an unrelated error.
          q.signal?.addEventListener("abort", () => reject(new Error("connection lost")));
          setTimeout(() => controller.abort(), 5);
        }),
    };
    let enriched = false;
    const enrich: typeof enrichLeads = async (...args) => {
      enriched = true;
      return run20Enrich(...args);
    };
    await expect(runScrape(OPTS, deps({ source, enrich }), () => {}, controller.signal)).rejects.toThrow(CancelledError);
    expect(seen).toBe(controller.signal);
    expect(enriched).toBe(false);
  });

  it("stops during the website checks with CancelledError, not a reconciliation error", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const enrich: typeof enrichLeads = async (leads, opts) => {
      seen = opts.signal;
      controller.abort();
      // Workers stop taking sites, so the counts no longer balance.
      return { leads: leads.slice(0, 1), counts: { toCheck: 10, fetched: 1, unreachable: 0, mismatched: 0, skipped: 0 } };
    };
    const run = runScrape(OPTS, deps({ enrich }), () => {}, controller.signal);
    await expect(run).rejects.toThrow(CancelledError);
    await expect(run).rejects.toThrow(CANCELLED_MESSAGE);
    expect(seen).toBe(controller.signal);
  });

  it("does not search when cancelled while the city is looked up", async () => {
    const controller = new AbortController();
    const source = stubSource([], "end-of-list");
    const geocode: Geocode = async () => {
      controller.abort();
      return MELAKA_GEO;
    };
    await expect(runScrape(OPTS, deps({ source, geocode }), () => {}, controller.signal)).rejects.toThrow(CancelledError);
    expect(source.queries).toHaveLength(0);
  });
});

describe("runScrape block retry", () => {
  it("retries when blocked and merges places across attempts", async () => {
    let attempt = 0;
    const seen: ScrapeProgress[] = [];
    const source: PlaceSource = {
      async search(q, onProgress) {
        attempt += 1;
        if (attempt === 1) {
          const p = { title: "ZZMARK-1", place_id: "ZZPLACE-01", phone: "012-000 0001", source: "fixture" as const, query: q.keyword, city: q.city ?? "" };
          onProgress({ places: 1, batches: 1, found: [p] });
          return { places: [p], reason: "blocked" };
        }
        const p2 = { title: "ZZMARK-2", place_id: "ZZPLACE-02", phone: "012-000 0002", source: "fixture" as const, query: q.keyword, city: q.city ?? "" };
        onProgress({ places: 1, batches: 1, found: [p2] });
        return { places: [p2], reason: "end-of-list" };
      },
    };
    const result = await runScrape(
      OPTS,
      deps({ source, blockRetry: { delaysMs: [50], sleep: async () => {} } }),
      (p) => seen.push(p),
    );
    expect(attempt).toBe(2);
    expect(result.reason).toBe("end-of-list");
    expect(result.leads.map((l) => l.place_id)).toEqual(["ZZPLACE-01", "ZZPLACE-02"]);
    expect(seen.some((p) => p.retryInSeconds === 1 && p.message === "Google Maps stopped answering searches from this computer for now. Trying again in 1 s (1 of 1)…")).toBe(true);
  });

  it("upgrades a names-only streamed row in place on single-search retry without adding a duplicate row, and enriches its website", async () => {
    let attempt = 0;
    const source: PlaceSource = {
      async search(q, onProgress) {
        attempt += 1;
        if (attempt === 1) {
          const bare: RawPlace = { title: "ZZMARK-1", place_id: "P1", source: "fixture", query: q.keyword, city: q.city ?? "" };
          onProgress({ places: 1, batches: 1, found: [bare] });
          return { places: [bare], reason: "blocked" };
        }
        const full: RawPlace = {
          title: "ZZMARK-1",
          place_id: "P1",
          phone: "012-000 0001",
          address: "1 Jalan Ampang",
          website: "https://zzmark1.test/",
          source: "fixture",
          query: q.keyword,
          city: q.city ?? "",
        };
        onProgress({ places: 1, batches: 1, found: [full] });
        return { places: [full], reason: "end-of-list" };
      },
    };
    const added: Lead[][] = [];
    const checked: Array<{ row: number; lead: Lead }> = [];
    let enrichedInput: Lead[] = [];
    const enrich: typeof enrichLeads = async (leads, opts) => {
      enrichedInput = leads;
      const done = leads.map((l, i) => {
        const next: Lead = { ...l, emails: ["hi@zzmark1.test"], email_status: "found", website_status: "found", sources: [] };
        opts.onLead?.(i, next);
        return next;
      });
      return { leads: done, counts: { toCheck: done.length, fetched: done.length, unreachable: 0, mismatched: 0, skipped: 0 } };
    };

    const result = await runScrape(
      OPTS,
      deps({ source, enrich, blockRetry: { delaysMs: [50], sleep: async () => {} } }),
      () => {},
      undefined,
      { added: (batch) => added.push(batch), checked: (row, lead) => checked.push({ row, lead }) },
    );
    expect(result.leads).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(added[0]).toHaveLength(1);
    expect(enrichedInput[0]).toMatchObject({ phone: "012-000 0001", address: "1 Jalan Ampang", website: "https://zzmark1.test/" });
    expect(checked.some((c) => c.row === 0 && c.lead.phone === "012-000 0001" && c.lead.website === "https://zzmark1.test/")).toBe(true);
    expect(checked.at(-1)).toMatchObject({ row: 0, lead: { place_id: "P1", emails: ["hi@zzmark1.test"], email_status: "found" } });
  });
});

describe("runScrape whole-city geo-grid", () => {
  const KL_GEO: Awaited<ReturnType<Geocode>> = { kind: "place", hit: hit(KUALA_LUMPUR) };

  it("runs cells one after another, dedupes by id then ListIndex rules, and streams rows", async () => {
    let active = 0;
    let maxActive = 0;
    const queries: SearchQuery[] = [];
    const cellResults: Omit<RawPlace, "source" | "query" | "city">[][] = [
      // Cell 1: P1 (has id), P2 (no id, has website), Branch A (P3, shares phone with Branch B)
      [
        { title: "Shop One", place_id: "P1", data_id: "D1", phone: "012-000 0001" },
        { title: "Web Only", website: "https://webonly.test/" },
        { title: "Clinic Branch A", place_id: "P3", phone: "03-1111 2222" },
      ],
      // Cell 2: duplicate of P1 by data_id only, duplicate of Web Only by website, and distinct Branch B with different place_id sharing phone
      [
        { title: "Shop One Copy", data_id: "D1", phone: "012-000 0001" },
        { title: "Web Only Copy", website: "https://www.webonly.test/contact" },
        { title: "Clinic Branch B", place_id: "P4", phone: "03-1111 2222" },
      ],
    ];
    const source: PlaceSource = {
      async search(q, onProgress) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const idx = queries.length;
        queries.push(q);
        await new Promise((r) => setTimeout(r, 2));
        active -= 1;
        const batch = (cellResults[idx] ?? []).map((p) => ({ ...p, source: "fixture" as const, query: q.keyword, city: q.city ?? "" }));
        if (batch.length) onProgress({ places: batch.length, batches: 1, found: batch });
        return { places: batch, reason: "end-of-list" };
      },
    };
    const streamed: string[] = [];
    const result = await runScrape(
      { ...OPTS, city: "Kuala Lumpur", wholeCity: true, depth: 10 },
      deps({ source, geocode: async () => KL_GEO }),
      () => {},
      undefined,
      { added: (leads) => streamed.push(...leads.map((l) => l.title)), checked: () => {} },
    );

    expect(maxActive).toBe(1);
    expect(queries.length).toBeGreaterThan(4);
    expect(result.reason).toBe("end-of-list");
    expect(result.leads.map((l) => l.title)).toEqual(["Shop One", "Web Only", "Clinic Branch A", "Clinic Branch B"]);
    expect(streamed).toEqual(["Shop One", "Web Only", "Clinic Branch A", "Clinic Branch B"]);
    expect(result.reconciliation).toMatchObject({ found: 6, kept: 4, duplicates: 2, filtered: 0 });
  });

  it("turns on the grid automatically for limit > 120 and stops once the limit is reached", async () => {
    const queries: SearchQuery[] = [];
    let nextId = 1;
    const source: PlaceSource = {
      async search(q, onProgress) {
        queries.push(q);
        // 50 unique places per cell -> 3 cells reach 150 > 130.
        const batch = Array.from({ length: 50 }, () => {
          const id = nextId++;
          return {
            title: `Place ${id}`,
            place_id: `P-${id}`,
            source: "fixture" as const,
            query: q.keyword,
            city: q.city ?? "",
          };
        });
        onProgress({ places: batch.length, batches: 1, found: batch });
        return { places: batch, reason: "end-of-list" };
      },
    };
    const result = await runScrape(
      { ...OPTS, city: "Kuala Lumpur", limit: 130 },
      deps({ source, geocode: async () => KL_GEO }),
      () => {},
    );
    expect(queries).toHaveLength(3);
    expect(result.leads).toHaveLength(130);
    expect(result.reason).toBe("depth");
    expect(result.reconciliation).toMatchObject({ found: 150, kept: 130, filtered: 20, duplicates: 0 });
  });

  it("cancels mid-grid and keeps the rows streamed before cancellation", async () => {
    const controller = new AbortController();
    let cell = 0;
    const source: PlaceSource = {
      async search(q, onProgress) {
        cell += 1;
        if (cell === 1) {
          const p = { title: "Cell1 Shop", place_id: "C1", source: "fixture" as const, query: q.keyword, city: q.city ?? "" };
          onProgress({ places: 1, batches: 1, found: [p] });
          return { places: [p], reason: "end-of-list" };
        }
        controller.abort();
        throw new CancelledError();
      },
    };
    const streamed: string[] = [];
    await expect(
      runScrape(
        { ...OPTS, city: "Kuala Lumpur", wholeCity: true },
        deps({ source, geocode: async () => KL_GEO }),
        () => {},
        controller.signal,
        { added: (leads) => streamed.push(...leads.map((l) => l.title)), checked: () => {} },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(streamed).toEqual(["Cell1 Shop"]);
  });

  it("stops remaining grid cells and keeps found places if a cell remains blocked after retries", async () => {
    let cell = 0;
    const source: PlaceSource = {
      async search(q, onProgress) {
        cell += 1;
        const p = { title: `Cell${cell} Shop`, place_id: `C${cell}`, source: "fixture" as const, query: q.keyword, city: q.city ?? "" };
        onProgress({ places: 1, batches: 1, found: [p] });
        return { places: [p], reason: cell >= 2 ? "blocked" : "end-of-list" };
      },
    };
    const result = await runScrape(
      { ...OPTS, city: "Kuala Lumpur", wholeCity: true, blockRetry: undefined } as RunOptions,
      deps({ source, geocode: async () => KL_GEO, blockRetry: { delaysMs: [10], sleep: async () => {} } }),
      () => {},
    );
    expect(cell).toBe(3); // cell 1 ok, cell 2 blocked -> 1 retry (call 3) still blocked -> stops!
    expect(result.reason).toBe("blocked");
    expect(result.leads.map((l) => l.place_id)).toEqual(["C1", "C2", "C3"]);
  });

  it("upgrades a names-only streamed row in place on a grid retry without dropping details or duplicating rows", async () => {
    let call = 0;
    const source: PlaceSource = {
      async search(q, onProgress) {
        call += 1;
        if (call === 1) {
          const bare: RawPlace = { title: "Grid Co", place_id: "P1", source: "fixture", query: q.keyword, city: q.city ?? "" };
          onProgress({ places: 1, batches: 1, found: [bare] });
          return { places: [bare], reason: "blocked" };
        }
        if (call === 2) {
          const full: RawPlace = {
            title: "Grid Co",
            place_id: "P1",
            phone: "012-999 0001",
            address: "10 Jalan Grid",
            website: "https://gridco.test/",
            source: "fixture",
            query: q.keyword,
            city: q.city ?? "",
          };
          onProgress({ places: 1, batches: 1, found: [full] });
          return { places: [full], reason: "end-of-list" };
        }
        return { places: [], reason: "end-of-list" };
      },
    };
    const added: Lead[][] = [];
    const checked: Array<{ row: number; lead: Lead }> = [];
    let enrichedInput: Lead[] = [];
    const enrich: typeof enrichLeads = async (leads, opts) => {
      enrichedInput = leads;
      const done = leads.map((l, i) => {
        const next: Lead = { ...l, emails: ["team@gridco.test"], email_status: "found", website_status: "found", sources: [] };
        opts.onLead?.(i, next);
        return next;
      });
      return { leads: done, counts: { toCheck: done.length, fetched: done.length, unreachable: 0, mismatched: 0, skipped: 0 } };
    };

    const result = await runScrape(
      { ...OPTS, city: "Kuala Lumpur", wholeCity: true, depth: 10 },
      deps({ source, enrich, geocode: async () => KL_GEO, blockRetry: { delaysMs: [10], sleep: async () => {} } }),
      () => {},
      undefined,
      { added: (batch) => added.push(batch), checked: (row, lead) => checked.push({ row, lead }) },
    );
    expect(result.leads).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(added[0]).toHaveLength(1);
    expect(enrichedInput[0]).toMatchObject({ phone: "012-999 0001", address: "10 Jalan Grid", website: "https://gridco.test/" });
    expect(checked.some((c) => c.row === 0 && c.lead.phone === "012-999 0001" && c.lead.address === "10 Jalan Grid")).toBe(true);
    expect(checked.at(-1)).toMatchObject({ row: 0, lead: { place_id: "P1", emails: ["team@gridco.test"], email_status: "found" } });
  });
});

describe("runScrape multi-keyword and multi-city", () => {
  const KL_GEO: Awaited<ReturnType<Geocode>> = { kind: "place", hit: hit(KUALA_LUMPUR) };

  it("runs 3 keywords in any language into one deduped list with per-keyword and total counts", async () => {
    const byKeyword: Record<string, Omit<RawPlace, "source" | "query" | "city">[]> = {
      "souvenir shop": [
        { title: "Shop 1", place_id: "P1", phone: "012-000 0001" },
        { title: "Shop 2", place_id: "P2", phone: "012-000 0002" },
        { title: "Shop 3", place_id: "P3", phone: "012-000 0003" },
      ],
      "纪念品店": [
        { title: "Shop 2", place_id: "P2", phone: "012-000 0002" },
        { title: "纪念品店 A", place_id: "P4", phone: "012-000 0004" },
        { title: "纪念品店 B", place_id: "P5", phone: "012-000 0005" },
      ],
      "kedai cenderamata": [
        { title: "Shop 1", place_id: "P1", phone: "012-000 0001" },
        { title: "纪念品店 B", place_id: "P5", phone: "012-000 0005" },
        { title: "Kedai C", place_id: "P6", phone: "012-000 0006" },
      ],
    };
    const queries: SearchQuery[] = [];
    const source: PlaceSource = {
      async search(q, onProgress) {
        queries.push(q);
        const found = (byKeyword[q.keyword] ?? []).map((p) => ({
          ...p,
          source: "fixture" as const,
          query: q.keyword,
          city: q.city ?? "",
        }));
        onProgress({ places: found.length, batches: 1, found });
        return { places: found, reason: "end-of-list" };
      },
    };
    const seen: ScrapeProgress[] = [];
    const streamed: string[] = [];
    const result = await runScrape(
      { ...OPTS, keyword: "souvenir shop", keywords: ["souvenir shop", "纪念品店", "kedai cenderamata"] },
      deps({ source, enrich: async (leads) => ({ leads, counts: { toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 } }) }),
      (p) => seen.push(p),
      undefined,
      { added: (batch) => streamed.push(...batch.map((l) => l.title)), checked: () => {} },
    );

    expect(queries.map((q) => q.keyword)).toEqual(["souvenir shop", "纪念品店", "kedai cenderamata"]);
    expect(result.leads.map((l) => l.title)).toEqual(["Shop 1", "Shop 2", "Shop 3", "纪念品店 A", "纪念品店 B", "Kedai C"]);
    expect(streamed).toEqual(["Shop 1", "Shop 2", "Shop 3", "纪念品店 A", "纪念品店 B", "Kedai C"]);
    expect(result.reconciliation).toMatchObject({ found: 9, kept: 6, filtered: 0, duplicates: 3 });
    expect(result.keywords).toEqual([
      { keyword: "souvenir shop", found: 3, added: 3, duplicates: 0 },
      { keyword: "纪念品店", found: 3, added: 2, duplicates: 1 },
      { keyword: "kedai cenderamata", found: 3, added: 1, duplicates: 2 },
    ]);
    expect(seen.some((p) => p.stage === "searching" && p.keywordIndex === 2 && p.keywordsTotal === 3)).toBe(true);
  });

  it("runs every keyword over the same city grid when wholeCity is enabled", async () => {
    const calls: Array<{ keyword: string; lat: number; lon: number }> = [];
    let seq = 0;
    const source: PlaceSource = {
      async search(q, onProgress) {
        calls.push({ keyword: q.keyword, lat: q.lat, lon: q.lon });
        seq += 1;
        // Cell 1 of both keywords emits SHARED-1 so keyword 2 hits 1 duplicate across the shared grid.
        const kwCalls = calls.filter((c) => c.keyword === q.keyword).length;
        const place: RawPlace =
          kwCalls === 1
            ? { title: "Shared 1", place_id: "SHARED-1", source: "fixture", query: q.keyword, city: q.city ?? "" }
            : { title: `${q.keyword} ${seq}`, place_id: `ID-${seq}`, source: "fixture", query: q.keyword, city: q.city ?? "" };
        onProgress({ places: 1, batches: 1, found: [place] });
        return { places: [place], reason: "end-of-list" };
      },
    };
    const seen: ScrapeProgress[] = [];
    const result = await runScrape(
      { ...OPTS, city: "Kuala Lumpur", keyword: "souvenir shop", keywords: ["souvenir shop", "纪念品店"], wholeCity: true, depth: 10 },
      deps({ source, geocode: async () => KL_GEO, enrich: async (leads) => ({ leads, counts: { toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 } }) }),
      (p) => seen.push(p),
    );

    const kw1Cells = calls.filter((c) => c.keyword === "souvenir shop").map((c) => [c.lat, c.lon]);
    const kw2Cells = calls.filter((c) => c.keyword === "纪念品店").map((c) => [c.lat, c.lon]);
    expect(kw1Cells.length).toBeGreaterThan(4);
    expect(kw2Cells).toEqual(kw1Cells);
    expect(result.keywords).toEqual([
      { keyword: "souvenir shop", found: kw1Cells.length, added: kw1Cells.length, duplicates: 0 },
      { keyword: "纪念品店", found: kw2Cells.length, added: kw2Cells.length - 1, duplicates: 1 },
    ]);
    expect(seen.some((p) => p.stage === "searching" && p.keywordIndex === 2 && p.keywordsTotal === 2 && p.cell === 1)).toBe(true);
  });

  it("searches several cities in one run, geocoding each city and deduping into one list", async () => {
    const geocoded: string[] = [];
    const geocode: Geocode = async (place) => {
      geocoded.push(place);
      if (place === "Melaka") return MELAKA_GEO;
      if (place === "Kuala Lumpur") return KL_GEO;
      return null;
    };
    const queries: SearchQuery[] = [];
    const source: PlaceSource = {
      async search(q, onProgress) {
        queries.push(q);
        const places: RawPlace[] =
          q.city === "Melaka"
            ? [{ title: "Melaka Shop", place_id: "PM-1", source: "fixture", query: q.keyword, city: q.city }]
            : [
                { title: "Melaka Shop", place_id: "PM-1", source: "fixture", query: q.keyword, city: q.city ?? "" },
                { title: "KL Shop", place_id: "PK-1", source: "fixture", query: q.keyword, city: q.city ?? "" },
              ];
        onProgress({ places: places.length, batches: 1, found: places });
        return { places, reason: "end-of-list" };
      },
    };
    const result = await runScrape(
      { ...OPTS, city: "Melaka", cities: ["Melaka", "Kuala Lumpur"] },
      deps({ source, geocode, enrich: async (leads) => ({ leads, counts: { toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 } }) }),
      () => {},
    );
    expect(geocoded).toEqual(["Melaka", "Kuala Lumpur"]);
    expect(queries.map((q) => q.city)).toEqual(["Melaka", "Kuala Lumpur"]);
    expect(result.leads.map((l) => l.title)).toEqual(["Melaka Shop", "KL Shop"]);
    expect(result.reconciliation).toMatchObject({ found: 3, kept: 2, duplicates: 1 });
  });
});

describe("runScrape names the place honestly", () => {
  const POJUCA = { name: "Pojuca", addresstype: "town", lat: -12.43, lon: -38.33, countryCode: "BR", country: "Brasil", bbox: { south: -12.47, north: -12.39, west: -38.37, east: -38.29 } };

  it("looks the place up within the run's country", async () => {
    const asked: Array<[string, unknown]> = [];
    const geocode: Geocode = async (place, o) => {
      asked.push([place, o]);
      return MELAKA_GEO;
    };
    await runScrape({ ...OPTS, country: "my" }, deps({ source: stubSource([], "end-of-list"), geocode }), () => {});
    expect(asked).toEqual([["Melaka", { countryCode: "MY" }]]);
  });

  it("stops before searching when the place is in another country, naming what it found", async () => {
    const source = stubSource([], "end-of-list");
    const run = runScrape({ ...OPTS, city: "PJ", country: "MY" }, deps({ source, geocode: async () => ({ kind: "place", hit: POJUCA }) }), () => {});
    await expect(run).rejects.toBeInstanceOf(UserFacingError);
    await expect(run).rejects.toThrow(
      /^PJ matched Pojuca in Brazil, not Malaysia\. Write the full place name with its region and country\.$/,
    );
    expect(source.queries).toEqual([]);
  });

  it("uses the same plain wording for every country when a place is elsewhere", async () => {
    const run = runScrape({ ...OPTS, city: "Porto", country: "PT" }, deps({ geocode: async () => ({ kind: "place", hit: POJUCA }) }), () => {});
    await expect(run).rejects.toThrow(/^Porto matched Pojuca in Brazil, not Portugal\. Write the full place name with its region and country\.$/);
  });

  it("refuses a whole state with the same plain message in any country and no hardcoded town list", async () => {
    const penang = { ...hit(PENANG), stateCode: "MY-07" };
    const myRun = runScrape({ ...OPTS, city: "Penang" }, deps({ geocode: async () => ({ kind: "region", hit: penang }) }), () => {});
    await expect(myRun).rejects.toThrow(
      /^Penang is a whole state, too large for one search\. Search towns inside it instead; you can give several at once\.$/,
    );

    const usRun = runScrape({ ...OPTS, city: "California", country: "US" }, deps({ geocode: async () => chooseHit([hit(CALIFORNIA)]) }), () => {});
    await expect(usRun).rejects.toThrow(
      /^California is a whole state, too large for one search\. Search towns inside it instead; you can give several at once\.$/,
    );
  });

  it("asks for a city or state when given a country", async () => {
    const run = runScrape({ ...OPTS, city: "Malaysia" }, deps({ geocode: async () => ({ kind: "region", hit: { ...hit(SG_COUNTRY), name: "Malaysia", countryCode: "MY" } }) }), () => {});
    await expect(run).rejects.toThrow(/^Malaysia is a country\. Name a city, or a state to pick towns from\.$/);
  });

  it("reports where it searches with the state and country, including outside Malaysia", async () => {
    const seen: ScrapeProgress[] = [];
    const pj = { name: "Petaling Jaya", addresstype: "city", lat: 3.1, lon: 101.6, countryCode: "MY", state: "Selangor", country: "Malaysia", bbox: { south: 3, north: 3.2, west: 101.5, east: 101.7 } };
    await runScrape({ ...OPTS, city: "Petaling Jaya" }, deps({ source: stubSource([], "end-of-list"), geocode: async () => ({ kind: "place", hit: pj }) }), (p) => seen.push(p));
    expect(seen.find((p) => p.stage === "searching")?.location?.label).toBe("Petaling Jaya, Selangor, Malaysia");

    const thSeen: ScrapeProgress[] = [];
    const thSource = stubSource([], "end-of-list");
    await runScrape(
      { ...OPTS, keyword: "cafes", city: "Bangkok, Thailand", country: "TH" },
      deps({ source: thSource, geocode: async () => chooseHit([hit(BANGKOK)]) }),
      (p) => thSeen.push(p),
    );
    expect(thSource.queries[0]).toMatchObject({ country: "TH", place: "Bangkok, Thailand" });
    expect(thSeen.find((p) => p.stage === "searching")?.location?.label).toBe("Bangkok, Thailand");
  });

  it("names the resolved country in the progress echo when no country is passed", async () => {
    const source = stubSource([], "end-of-list");
    const seen: ScrapeProgress[] = [];
    await runScrape(
      { ...OPTS, country: undefined, city: "PJ" },
      deps({ source, geocode: async () => ({ kind: "place", hit: { ...POJUCA, state: "Bahia" } }) }),
      (p) => seen.push(p),
    );
    const echo = seen.find((p) => p.stage === "searching")?.message ?? "";
    expect(echo).toContain("Brazil");
    expect(echo).toBe("Searching PJ (Pojuca, Bahia, Brazil)… 0 places");
    expect(seen.find((p) => p.stage === "searching")?.location?.label).toBe("Pojuca, Bahia, Brazil");
    expect(source.queries[0]).toMatchObject({ country: "BR" });
  });
});

describe("runScrape puts the place into the Google query", () => {
  it("adds the place as typed to a single search", async () => {
    const source = stubSource([], "end-of-list");
    await runScrape({ ...OPTS, city: "George Town, Penang, Malaysia" }, deps({ source }), () => {});
    expect(source.queries[0]).toMatchObject({ keyword: "souvenir shop", place: "George Town, Penang, Malaysia" });
  });

  it("adds each city to its own search when several keywords and cities run", async () => {
    const source = stubSource([], "end-of-list");
    await runScrape({ ...OPTS, keywords: ["hotel", "hostel"], cities: ["George Town", "Butterworth"] }, deps({ source }), () => {});
    expect(source.queries.map((q) => [q.keyword, q.place])).toEqual([
      ["hotel", "George Town"],
      ["hostel", "George Town"],
      ["hotel", "Butterworth"],
      ["hostel", "Butterworth"],
    ]);
  });

  it("keeps whole-city area searches to the keyword, so each area stays where the map is", async () => {
    const source = stubSource([], "end-of-list");
    await runScrape({ ...OPTS, wholeCity: true }, deps({ source }), () => {});
    expect(source.queries.length).toBeGreaterThan(1);
    for (const q of source.queries) expect(q.place).toBeUndefined();
  });
});
