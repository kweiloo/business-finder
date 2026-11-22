import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { debugLogFromEnv, formatDebugLine, NO_DEBUG_LOG, type DebugFields } from "../src/core/debugLog.js";
import { enrichLeads, fixtureFetcher } from "../src/core/enrich/enrich.js";
import type { SiteFetcher } from "../src/core/enrich/safeFetch.js";
import { CancelledError } from "../src/core/errors.js";
import { chooseHit } from "../src/core/geo/geocode.js";
import { toLead } from "../src/core/leads/normalize.js";
import { runScrape } from "../src/core/pipeline.js";
import { hit, MELAKA_CITY, MELAKA_STATE } from "./fixtures/nominatim.js";
import { run20Enrich, run20Source } from "./fixtures/run20.js";

const SITES = fileURLToPath(new URL("./fixtures/sites/", import.meta.url));
const ALL = { emails: true, socials: true, deep: false };
const NOW = new Date("2026-11-19T08:00:00.000Z");

function collector() {
  const events: { event: string; fields: DebugFields }[] = [];
  return { events, debug: (event: string, fields: DebugFields = {}) => events.push({ event, fields }) };
}

const shop = (n: string, phone: string) =>
  toLead({ title: `Shop ${n}`, source: "fixture", query: "florist", city: "Melaka", website: `https://shop-${n}.test/`, phone, category: "Florist" }, "MY");

describe("debugLogFromEnv", () => {
  it("writes nothing unless BUSINESS_FINDER_DEBUG_LOG names a file", () => {
    expect(debugLogFromEnv({})).toBe(NO_DEBUG_LOG);
    expect(debugLogFromEnv({ BUSINESS_FINDER_DEBUG_LOG: "  " })).toBe(NO_DEBUG_LOG);
  });

  it("appends one timestamped key=value line per event to the named file", () => {
    const writes: [string, string][] = [];
    const log = debugLogFromEnv({ BUSINESS_FINDER_DEBUG_LOG: "run.log" }, (f, l) => writes.push([f, l]), () => NOW);
    log("website_done", { n: 3, host: "shop-a.test", outcome: "fetched", ms: 120 });
    expect(writes).toEqual([["run.log", "2026-11-19T08:00:00.000Z website_done n=3 host=shop-a.test outcome=fetched ms=120\n"]]);
  });

  it("quotes values with spaces or quotes, and never throws when the write fails", () => {
    expect(formatDebugLine(NOW, "x", { a: "two words", b: "", c: true })).toBe('2026-11-19T08:00:00.000Z x a="two words" b="" c=true\n');
    const log = debugLogFromEnv({ BUSINESS_FINDER_DEBUG_LOG: "run.log" }, () => {
      throw new Error("EACCES");
    });
    expect(() => log("run_start")).not.toThrow();
  });
});

describe("enrichLeads debug log", () => {
  it("records each website check with its host, outcome and network/parse split", async () => {
    const { events, debug } = collector();
    await enrichLeads([shop("a", "06-281 2345"), shop("c", "06-111 2222")], { ...ALL, fetchSite: fixtureFetcher(SITES), debug });
    expect(events[0]).toEqual({ event: "websites_start", fields: { toCheck: 2 } });
    const done = events.filter((e) => e.event === "website_done").map((e) => e.fields);
    expect(done.map((f) => [f.host, f.outcome]).sort()).toEqual([["shop-a.test", "fetched"], ["shop-c.test", "unreachable"]]);
    for (const f of done) {
      expect(f.ms).toBe((f.fetchMs as number) + (f.parseMs as number));
    }
    expect(events.at(-1)).toMatchObject({ event: "websites_end", fields: { toCheck: 2, fetched: 1, unreachable: 1 } });
  });

  it("lists checks that are still running, so a run that stops shows which site it waits on", async () => {
    // Only the report interval is faked: the test fires it once shop-a has
    // finished, so a slow fixture read under load cannot leave shop-a running.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { events, debug } = collector();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const fetchSite: SiteFetcher = async (url, o) => {
        if (url.includes("shop-b")) await gate;
        return fixtureFetcher(SITES)(url, o);
      };
      const run = enrichLeads([shop("a", "06-281 2345"), shop("b", "06-999 0000")], { ...ALL, fetchSite, debug, pendingReportMs: 10 });
      while (!events.some((e) => e.event === "website_done" && e.fields.host === "shop-a.test")) await new Promise((r) => setTimeout(r, 1));
      vi.advanceTimersByTime(10);
      release();
      await run;
      const pending = events.filter((e) => e.event === "website_pending").map((e) => e.fields.host);
      expect(pending).toEqual(["shop-b.test"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("enrichLeads debug log when cancelled", () => {
  it("logs a site cut off by the cancel as cancelled, never as unreachable", async () => {
    const { events, debug } = collector();
    const controller = new AbortController();
    const fetchSite: SiteFetcher = async (url, o) => {
      if (url.includes("shop-a")) return fixtureFetcher(SITES)(url, o);
      if (url.includes("shop-c")) return { ok: false, reason: "timeout" };
      return new Promise((resolve) => o.signal!.addEventListener("abort", () => resolve({ ok: false, reason: "timeout" }), { once: true }));
    };
    const run = enrichLeads([shop("a", "06-281 2345"), shop("c", "06-111 2222"), shop("b", "06-999 0000")], { ...ALL, fetchSite, debug, signal: controller.signal });
    while (events.filter((e) => e.event === "website_done").length < 2) await new Promise((r) => setTimeout(r, 1));
    controller.abort();
    await run;
    const done = events.filter((e) => e.event === "website_done").map((e) => [e.fields.host, e.fields.outcome]);
    expect(done.sort()).toEqual([["shop-a.test", "fetched"], ["shop-b.test", "cancelled"], ["shop-c.test", "unreachable"]]);
    expect(events.at(-1)).toEqual({
      event: "websites_end",
      fields: { toCheck: 3, fetched: 1, unreachable: 1, mismatched: 0, skipped: 0, cancelled: 1 },
    });
  });
});

/** Stage lines only: not the lines for each website, page, request or check process. */
const isStage = (event: string) => !/^(website|page_|parse_|hop_|decompress_|checks_)/.test(event);

describe("runScrape debug log", () => {
  it("logs each stage in order and ends with run_done", async () => {
    const { events, debug } = collector();
    await runScrape(
      { keyword: "souvenir shop", city: "Melaka", depth: 1, lang: "en", emails: true, socials: true, deep: false, maxSeconds: 600 },
      { source: run20Source(), geocode: async () => chooseHit([hit(MELAKA_STATE), hit(MELAKA_CITY)]), enrich: run20Enrich, now: () => NOW, debug },
      () => {},
    );
    const stages = events.map((e) => e.event).filter(isStage);
    expect(stages).toEqual(["run_start", "geocode_done", "search_start", "search_done", "enrich_done", "run_done"]);
    expect(events.find((e) => e.event === "search_done")?.fields).toMatchObject({ places: 20 });
    expect(events.at(-1)?.fields).toMatchObject({ leads: 19 });
  });

  it("ends a cancelled run with run_cancelled naming the stage it stopped in", async () => {
    const { events, debug } = collector();
    const controller = new AbortController();
    const run = runScrape(
      { keyword: "souvenir shop", city: "Melaka", depth: 1, lang: "en", emails: true, socials: true, deep: false, maxSeconds: 600 },
      {
        source: run20Source(),
        geocode: async () => chooseHit([hit(MELAKA_STATE), hit(MELAKA_CITY)]),
        enrich: async (leads, opts, onProgress) => {
          controller.abort();
          return run20Enrich(leads, opts, onProgress);
        },
        now: () => NOW,
        debug,
      },
      () => {},
      controller.signal,
    );
    await expect(run).rejects.toThrow(CancelledError);
    const stages = events.map((e) => e.event).filter(isStage);
    expect(stages).toEqual(["run_start", "geocode_done", "search_start", "search_done", "enrich_done", "run_cancelled"]);
    expect(events.at(-1)?.fields).toMatchObject({ stage: "checking_websites" });
  });
});
