// Rows saved batch by batch while a search runs: the store contract (whole
// lines, a row filled in place), the job runner (cancel and failure keep what
// was found), `--into`, and the New list form's choices.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { enrichLeads } from "../src/core/enrich/enrich.js";
import { CancelledError } from "../src/core/errors.js";
import type { Geocode } from "../src/core/geo/geocode.js";
import { toLead } from "../src/core/leads/normalize.js";
import { runScrape, type RowSink } from "../src/core/pipeline.js";
import { SEARCH_SIZES } from "../src/core/searchSize.js";
import type { PlaceSource } from "../src/core/sources/source.js";
import type { Lead, RawPlace, RunOptions } from "../src/core/types.js";
import { JobStore } from "../src/jobs/store.js";
import { readList } from "../src/jobs/combine.js";
import { RowWriter, runInto, runJob, type Runner } from "../src/jobs/worker.js";
import {
  emptyQuery,
  estimateExactDuration,
  EXACT_STOPS,
  exactStopIndex,
  exactSummaryText,
  queryOf,
  readQuery,
  SIZE_CHOICES,
  sizeOf,
  toRequest,
} from "../web/src/lib/search.js";

const NOW = new Date("2026-11-20T08:00:00.000Z");
const OPTS: RunOptions = { keyword: "event management", city: "Kuala Lumpur", depth: 3, lang: "en", emails: true, socials: true, deep: false, maxSeconds: 600 };
const GEO: Geocode = async () => ({
  kind: "place",
  hit: { name: "Kuala Lumpur", addresstype: "city", lat: 3.15, lon: 101.7, countryCode: "MY", bbox: { south: 3, north: 3.3, west: 101.6, east: 101.8 } },
});

/** Place `n` of batch `b`: every other one has a website. */
function place(b: number, n: number): Omit<RawPlace, "source" | "query" | "city"> {
  const id = b * 100 + n;
  return {
    title: `Test Event Co ${id}`,
    data_id: `0x1:0x${id.toString(16)}`,
    phone: `012-000 ${String(id).padStart(4, "0")}`,
    ...(n % 2 === 0 ? { website: `https://event-${id}.test/` } : {}),
  };
}

const batchOf = (b: number, size = 20) => Array.from({ length: size }, (_, n) => place(b, n));

type Deferred = { promise: Promise<void>; resolve(): void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Hands out one batch each time the test opens its gate (the first batch at
 * once). Rejects with `CancelledError` when the search is cancelled while
 * waiting, and with `failWith` after `failAfter` batches.
 */
function gatedSource(batches: Omit<RawPlace, "source" | "query" | "city">[][], opts: { failAfter?: number; failWith?: Error } = {}) {
  const gates = batches.map(() => deferred());
  gates[0]!.resolve();
  const read = batches.map(() => deferred());
  const source: PlaceSource = {
    async search(q, onProgress) {
      const places: RawPlace[] = [];
      for (const [i, batch] of batches.entries()) {
        if (i >= q.depth) return { places, reason: "depth" };
        await new Promise<void>((resolve, reject) => {
          if (q.signal?.aborted) return reject(new CancelledError());
          q.signal?.addEventListener("abort", () => reject(new CancelledError()), { once: true });
          void gates[i]!.promise.then(resolve);
        });
        const found = batch.map((p) => ({ ...p, source: "fixture" as const, query: q.keyword, city: q.city ?? "" }));
        places.push(...found);
        onProgress({ places: places.length, batches: i + 1, found });
        read[i]!.resolve();
        if (opts.failAfter === i + 1) throw opts.failWith ?? new Error("The browser closed unexpectedly.");
      }
      return { places, reason: "end-of-list" };
    },
  };
  return { source, open: (i: number) => gates[i]!.resolve(), read: (i: number) => read[i]!.promise };
}

/** Finds an email on every website, reporting each lead as it is done. */
const fakeEnrich: typeof enrichLeads = async (leads, opts) => {
  const out = leads.map((lead, i) => {
    const done: Lead = lead.website
      ? { ...lead, emails: [`hello@${new URL(lead.website).host}`], email_types: ["generic"], email_status: "found", website_status: "found", sources: [] }
      : { ...lead, email_types: [], email_status: "no_website", website_status: "no_website", sources: [] };
    opts.onLead?.(i, done);
    return done;
  });
  const sites = leads.filter((l) => l.website).length;
  return { leads: out, counts: { toCheck: sites, fetched: sites, unreachable: 0, mismatched: 0, skipped: 0 } };
};

const runnerFor = (source: PlaceSource, enrich: typeof enrichLeads = fakeEnrich): Runner => (options, onProgress, signal, rows) =>
  runScrape(options, { source, geocode: GEO, enrich, now: () => NOW }, onProgress, signal, rows);

/** Waits until `check` holds, polling the store the way the page does. */
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let dir: string;
let store: JobStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-live-rows-"));
  store = new JobStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const leadsFile = (id: string) => path.join(dir, id, "leads.jsonl");
const lines = (id: string) => readFileSync(leadsFile(id), "utf8").split("\n").filter(Boolean);

describe("the New list form's choices", () => {
  it("map each size to its batches, time limit, cap and grid mode", () => {
    expect(SIZE_CHOICES.map((c) => c.size)).toEqual(["about20", "oneSearch", "wholeCity"]);
    for (const choice of SIZE_CHOICES) {
      expect(`${choice.label} ${choice.hint}`).not.toMatch(/\b(grid|cell|depth|run|website checks)\b/i);
    }
    const sent = (size: (typeof SIZE_CHOICES)[number]["size"]) => {
      const { depth, maxSeconds, limit, wholeCity } = toRequest({ ...emptyQuery(), keyword: "dentist", city: "Lisbon", size });
      return { depth, maxSeconds, ...(limit !== undefined ? { limit } : {}), ...(wholeCity ? { wholeCity } : {}) };
    };
    expect(sent("about20")).toEqual({ depth: 1, maxSeconds: 600 });
    expect(sent("oneSearch")).toEqual({ depth: 10, maxSeconds: 600, limit: 120 });
    expect(sent("wholeCity")).toEqual({ depth: 10, maxSeconds: 1800, wholeCity: true });
    expect(SEARCH_SIZES.wholeCity.depth * 20).toBeGreaterThan(120);
  });

  it("turns on the grid automatically when exact limit exceeds 120", () => {
    expect(toRequest({ ...emptyQuery(), keyword: "dentist", city: "Lisbon", size: null, exact: "50" })).toMatchObject({
      depth: 3,
      limit: 50,
    });
    expect(toRequest({ ...emptyQuery(), keyword: "dentist", city: "Lisbon", size: null, exact: "50" }).wholeCity).toBeUndefined();
    expect(toRequest({ ...emptyQuery(), keyword: "dentist", city: "Lisbon", size: null, exact: "200" })).toMatchObject({
      depth: 10,
      maxSeconds: 1800,
      limit: 200,
      wholeCity: true,
    });
  });

  it("start on Everything one search finds with emails on, English and the country from the place", () => {
    expect(emptyQuery()).toEqual({ keyword: "", city: "", size: "oneSearch", exact: "", emails: true, lang: "en", country: "" });
    expect(toRequest({ ...emptyQuery(), keyword: " dentist ", city: " Lisbon " })).toEqual({
      keyword: "dentist",
      city: "Lisbon",
      depth: 10,
      maxSeconds: 600,
      limit: 120,
      lang: "en",
      emails: true,
      socials: true,
      deep: true,
    });
  });

  it("turn every website read off with emails, and send a chosen language and country", () => {
    const req = toRequest({ ...emptyQuery(), keyword: "hotel", city: "Melaka", emails: false, lang: "zh-CN", country: "SG" });
    expect(req).toMatchObject({ emails: false, socials: false, deep: false, lang: "zh-CN", country: "SG" });
  });

  it("maps each legacy depth without silently growing into the grid or shrinking", () => {
    expect(sizeOf(1)).toBe("about20");
    expect(sizeOf(2)).toBeNull();
    expect(sizeOf(3)).toBeNull();
    expect(sizeOf(4)).toBe("oneSearch");
    expect(sizeOf(10)).toBe("oneSearch");

    expect(queryOf({ ...OPTS, depth: 1 })).toMatchObject({ size: "about20", exact: "" });
    expect(toRequest(queryOf({ ...OPTS, depth: 1 }))).toEqual({
      keyword: OPTS.keyword,
      city: OPTS.city,
      depth: 1,
      maxSeconds: 600,
      lang: "en",
      emails: true,
      socials: true,
      deep: true,
    });

    for (const depth of [2, 3]) {
      const q = queryOf({ ...OPTS, depth });
      expect(q).toMatchObject({ size: null, exact: "60" });
      const req = toRequest(q);
      expect(req).toMatchObject({ depth: 3, limit: 60 });
      expect(req.wholeCity).toBeUndefined();
    }

    for (const depth of [4, 10]) {
      const q = queryOf({ ...OPTS, depth });
      expect(q).toMatchObject({ size: "oneSearch", exact: "" });
      const req = toRequest(q);
      expect(req).toMatchObject({ depth: 10, limit: 120 });
      expect(req.wholeCity).toBeUndefined();
    }
  });

  it("round-trips every new choice, exact limit, and option via toRequest(queryOf(x))", () => {
    const base = { keyword: "dentist", city: "Lisbon", lang: "pt", country: "PT", emails: false };
    for (const q of [
      { ...base, size: "about20" as const, exact: "" },
      { ...base, size: "oneSearch" as const, exact: "" },
      { ...base, size: "wholeCity" as const, exact: "" },
      { ...base, size: null, exact: "50" },
      { ...base, size: null, exact: "120" },
      { ...base, size: null, exact: "250" },
    ]) {
      const req = toRequest(q);
      expect(toRequest(queryOf(req))).toEqual(req);
    }

    // Never silently shrink a grid job with limit <= 120.
    const gridSmall = { ...OPTS, depth: 10, wholeCity: true, limit: 50 };
    expect(toRequest(queryOf(gridSmall))).toMatchObject({ wholeCity: true, limit: 50 });

    expect(queryOf({ ...OPTS, depth: 10, wholeCity: true, limit: 250, emails: false, country: "MY" })).toEqual({
      keyword: OPTS.keyword,
      city: OPTS.city,
      size: null,
      exact: "250",
      emails: false,
      lang: "en",
      country: "MY",
    });
    expect(readQuery({ keyword: "dentist", city: "Lisbon" })).toEqual({ ...emptyQuery(), keyword: "dentist", city: "Lisbon" });
    expect(readQuery({ keyword: "dentist", city: "Lisbon", size: "about60" })).toEqual({
      ...emptyQuery(),
      keyword: "dentist",
      city: "Lisbon",
      size: null,
      exact: "60",
    });
    expect(readQuery({ keyword: "dentist", city: "Lisbon", size: "oneSearch", exact: "50" })).toEqual({
      ...emptyQuery(),
      keyword: "dentist",
      city: "Lisbon",
      size: null,
      exact: "50",
    });
    expect(readQuery({ keyword: "dentist", city: "Lisbon", size: "huge" })?.size).toBe("oneSearch");
    expect(readQuery(null)).toBeNull();
  });

  it("maps exact stops, scales durations from F1 numbers, and preserves off-stop limits via toRequest(queryOf(x))", () => {
    expect(EXACT_STOPS).toEqual([20, 60, 120, 250, 500, 1000]);
    expect(exactStopIndex("20")).toBe(0);
    expect(exactStopIndex("250")).toBe(3);
    expect(exactStopIndex("1000")).toBe(5);
    expect(exactStopIndex("50")).toBeNull();
    expect(exactStopIndex("1500")).toBeNull();
    expect(exactStopIndex("")).toBeNull();

    expect(estimateExactDuration(20)).toBe("about 20 seconds");
    expect(estimateExactDuration(60)).toBe("about 50 seconds");
    expect(estimateExactDuration(120)).toBe("about 2 minutes");
    expect(estimateExactDuration(250)).toBe("about 8 minutes");
    expect(estimateExactDuration(500)).toBe("about 10 minutes");
    expect(estimateExactDuration(1000)).toBe("about 15 minutes");

    expect(exactSummaryText("250", null)).toBe("About 250 places · about 8 minutes · searches the whole city");
    expect(exactSummaryText("50", null)).toBe("Saved limit: 50 places · about 40 seconds");
    expect(exactSummaryText("50", "wholeCity")).toBe("Saved limit: 50 places · about 6 minutes · searches the whole city");
    expect(exactSummaryText("", "oneSearch")).toBe("Optional. Above 120 searches the whole city.");

    // Round-trip tests for 50 (off-stop), 250 (stop), and 1000 (the form's max; values > 1000 were capped at 1000).
    for (const limit of [50, 250, 1000]) {
      const req = toRequest({ ...emptyQuery(), keyword: "dentist", city: "Lisbon", size: null, exact: String(limit) });
      expect(req.limit).toBe(limit);
      const restored = queryOf(req);
      expect(restored.exact).toBe(String(limit));
      expect(toRequest(restored)).toEqual(req);
    }

    // If a stored job somehow carried > 1000, queryOf keeps the number as text while toRequest clamps to MAX_WHOLE_CITY_LIMIT (1000).
    const overMaxQuery = queryOf({ ...OPTS, depth: 10, wholeCity: true, limit: 1500 });
    expect(overMaxQuery.exact).toBe("1500");
    expect(exactStopIndex(overMaxQuery.exact)).toBeNull();
    expect(toRequest(overMaxQuery).limit).toBe(1000);
  });
});

describe("JobStore.replaceLeads", () => {
  const lead = (title: string) => toLead({ title, source: "fixture", query: "q", city: "c" }, "MY", NOW.toISOString());

  it("replaces a row in place: same count, same order, never a second copy", () => {
    const job = store.create(OPTS);
    store.appendLeads(job.id, [lead("A"), lead("B"), lead("C")]);
    store.replaceLeads(job.id, new Map([[1, { ...lead("B"), emails: ["b@b.test"] }]]));
    expect(store.readLeads(job.id).map((l) => [l.title, l.emails])).toEqual([
      ["A", []],
      ["B", ["b@b.test"]],
      ["C", []],
    ]);
    expect(lines(job.id)).toHaveLength(3);
    // Written to a temporary file and renamed; nothing is left behind.
    expect(readdirSync(path.join(dir, job.id)).sort()).toEqual(["job.json", "leads.jsonl"]);
  });

  it("drops a line cut short by a crash, keeping positions the same as readLeads", () => {
    const job = store.create(OPTS);
    store.appendLeads(job.id, [lead("A")]);
    writeFileSync(leadsFile(job.id), `${readFileSync(leadsFile(job.id), "utf8")}{"title":"cut`, { flag: "w" });
    writeFileSync(leadsFile(job.id), `${readFileSync(leadsFile(job.id), "utf8")}\n${JSON.stringify(lead("B"))}\n`);
    expect(store.readLeads(job.id).map((l) => l.title)).toEqual(["A", "B"]);
    store.replaceLeads(job.id, new Map([[1, { ...lead("B"), note: "filled" }]]));
    expect(store.readLeads(job.id).map((l) => [l.title, l.note])).toEqual([
      ["A", undefined],
      ["B", "filled"],
    ]);
    expect(lines(job.id).every((line) => JSON.parse(line))).toBe(true);
  });

  it("adds a batch after a line cut short by a crash on its own lines, so a filled-in row lands in its place", () => {
    const job = store.create(OPTS);
    store.appendLeads(job.id, [lead("A"), lead("B")]);
    // A crash cut the third line short: no closing brace, no newline.
    writeFileSync(leadsFile(job.id), `${readFileSync(leadsFile(job.id), "utf8")}{"title":"C","email_st`);
    const rows = new RowWriter(store, job.id, store.readLeads(job.id).length);
    rows.added([lead("D"), lead("E"), lead("F")]);
    rows.checked(1, { ...lead("E"), email_status: "found", emails: ["e@e.test"] });
    rows.flush();
    expect(rows.error).toBeUndefined();
    expect(store.readLeads(job.id).map((l) => [l.title, l.email_status])).toEqual([
      ["A", "skipped_by_option"],
      ["B", "skipped_by_option"],
      ["D", "skipped_by_option"],
      ["E", "found"],
      ["F", "skipped_by_option"],
    ]);
    expect(store.get(job.id)?.saved).toBe(5);
    expect(lines(job.id).every((line) => JSON.parse(line))).toBe(true);
  });

  it("ignores positions past the end", () => {
    const job = store.create(OPTS);
    store.appendLeads(job.id, [lead("A")]);
    store.replaceLeads(job.id, new Map([[5, lead("Z")]]));
    expect(store.readLeads(job.id).map((l) => l.title)).toEqual(["A"]);
  });

  it("counts the saved rows on the job with every append", () => {
    const job = store.create(OPTS);
    expect(store.get(job.id)?.saved).toBeUndefined();
    store.appendLeads(job.id, [lead("A"), lead("B")]);
    expect(store.get(job.id)?.saved).toBe(2);
    store.appendLeads(job.id, [lead("C")]);
    expect(store.get(job.id)?.saved).toBe(3);
  });
});

describe("runJob saves rows batch by batch", () => {
  it("saves each batch as it is read, before the search ends, then fills the rows in", async () => {
    const gated = gatedSource([batchOf(1), batchOf(2), batchOf(3)]);
    const job = store.create(OPTS);
    const running = runJob(store, job.id, runnerFor(gated.source));

    await gated.read(0);
    await until(() => store.readLeads(job.id).length === 20);
    expect(store.get(job.id)).toMatchObject({ status: "running", saved: 20 });
    // Saved before its website was checked.
    expect(store.readLeads(job.id).every((l) => l.email_status === "not_checked" && l.website_status === "not_checked")).toBe(true);

    gated.open(1);
    await gated.read(1);
    await until(() => store.readLeads(job.id).length === 40);
    expect(store.get(job.id)).toMatchObject({ status: "running", saved: 40 });

    gated.open(2);
    const run = await running;
    expect(store.get(job.id)).toMatchObject({ status: "done", saved: 60, reconciliation: { found: 60, kept: 60 } });

    // Every row filled in by its website check, in place: 60 lines, none twice, the same as the result.
    const saved = store.readLeads(job.id);
    expect(lines(job.id)).toHaveLength(60);
    expect(new Set(saved.map((l) => l.data_id)).size).toBe(60);
    expect(saved).toEqual(run!.result.leads);
    expect(saved.filter((l) => l.website).every((l) => l.email_status === "found" && l.emails.length === 1)).toBe(true);
    expect(saved.filter((l) => !l.website).every((l) => l.email_status === "no_website")).toBe(true);
  });

  it("keeps the rows of two batches when cancelled, and ends cancelled", async () => {
    const gated = gatedSource([batchOf(1), batchOf(2), batchOf(3)]);
    const job = store.create(OPTS);
    const abort = new AbortController();
    const running = runJob(store, job.id, runnerFor(gated.source), () => {}, abort.signal);
    gated.open(1);
    await gated.read(1);
    await until(() => store.readLeads(job.id).length === 40);

    abort.abort();
    await expect(running).rejects.toBeInstanceOf(CancelledError);
    const stopped = store.get(job.id)!;
    expect(stopped).toMatchObject({ status: "cancelled", saved: 40 });
    expect(stopped.progress.message).toBe("Search cancelled. 40 places were found before it stopped.");
    expect(stopped.error).toBeUndefined();
    // The places it found, not checked: their websites were never read.
    const kept = store.readLeads(job.id);
    expect(kept).toHaveLength(40);
    expect(kept.every((l) => l.website_status === "not_checked")).toBe(true);
  });

  it("keeps the rows it found when it fails mid-run and records the raw cause without scraped values", async () => {
    const gated = gatedSource([batchOf(1), batchOf(2), batchOf(3)], { failAfter: 2 });
    const job = store.create(OPTS);
    const running = runJob(store, job.id, runnerFor(gated.source));
    gated.open(1);
    await expect(running).rejects.toThrow("The browser closed unexpectedly.");
    expect(store.get(job.id)).toMatchObject({
      status: "failed",
      saved: 40,
      error: "The search stopped because something went wrong. Try again.",
      cause: "Error: The browser closed unexpectedly.",
    });
    expect(store.readLeads(job.id)).toHaveLength(40);
  });

  it("strips external URLs and email addresses from the stored failure cause", async () => {
    const job = store.create(OPTS);
    const failing: Runner = async () => {
      throw new Error("failed reading https://shop-a.test/contact for info@shop-a.test");
    };
    await expect(runJob(store, job.id, failing)).rejects.toThrow();
    const saved = store.get(job.id)!;
    expect(saved.error).toBe("The search stopped because something went wrong. Try again.");
    expect(saved.cause).toContain("Error: failed reading [url] for [email]");
    expect(saved.cause).not.toContain("shop-a.test");
    expect(saved.cause).not.toContain("info@");
  });

  it("keeps the rows checked before a cancel during the website checks, and the rest unchecked", async () => {
    const gated = gatedSource([batchOf(1)]);
    const job = store.create({ ...OPTS, depth: 1 });
    const abort = new AbortController();
    // Checks the first 4 rows, then the user cancels.
    const enrich: typeof enrichLeads = async (leads, opts) => {
      leads.slice(0, 4).forEach((lead, i) => opts.onLead?.(i, { ...lead, email_status: "not_on_site", website_status: "found", sources: [] }));
      abort.abort();
      return { leads, counts: { toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 } };
    };
    await expect(runJob(store, job.id, runnerFor(gated.source, enrich), () => {}, abort.signal)).rejects.toBeInstanceOf(CancelledError);
    const kept = store.readLeads(job.id);
    expect(store.get(job.id)).toMatchObject({ status: "cancelled", saved: 20 });
    expect(kept).toHaveLength(20);
    expect(kept.slice(0, 4).every((l) => l.email_status === "not_on_site")).toBe(true);
    expect(kept.slice(4).every((l) => l.email_status === "not_checked")).toBe(true);
  });

  it("writes filled-in rows together rather than one rewrite per row", async () => {
    const gated = gatedSource([batchOf(1)]);
    const job = store.create({ ...OPTS, depth: 1 });
    let rewrites = 0;
    const counting = new JobStore(dir);
    const replace = counting.replaceLeads.bind(counting);
    counting.replaceLeads = (id, rows) => {
      rewrites += 1;
      replace(id, rows);
    };
    await runJob(counting, job.id, runnerFor(gated.source));
    // 20 rows checked within the same second: one rewrite at the end.
    expect(rewrites).toBe(1);
    expect(counting.readLeads(job.id).every((l) => l.email_status !== "not_checked")).toBe(true);
  });

  it("hands each row to the sink once, deduped and within the limit, in result order", async () => {
    const dupes = [...batchOf(1, 3), place(1, 0)];
    const gated = gatedSource([dupes, [place(1, 1), place(2, 0), place(2, 1)]]);
    gated.open(1);
    const added: Lead[] = [];
    const checked: number[] = [];
    const sink: RowSink = { added: (l) => added.push(...l), checked: (row) => checked.push(row) };
    const result = await runScrape({ ...OPTS, limit: 4 }, { source: gated.source, geocode: GEO, enrich: fakeEnrich, now: () => NOW }, () => {}, undefined, sink);
    expect(added.map((l) => l.title)).toEqual(result.leads.map((l) => l.title));
    expect(added).toHaveLength(4);
    expect(checked.sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("runInto saves rows batch by batch", () => {
  it("adds only places the list lacks, as each batch arrives, and fills them in", async () => {
    const first = store.create({ ...OPTS, depth: 1 });
    await runJob(store, first.id, runnerFor(gatedSource([batchOf(1)]).source));
    expect(store.readLeads(first.id)).toHaveLength(20);

    // Batch 1 again (all already in the list), then batch 2 (new).
    const gated = gatedSource([batchOf(1), batchOf(2)]);
    const into = runInto(store, first.id, { ...OPTS, depth: 2 }, runnerFor(gated.source));
    await gated.read(0);
    expect(store.readLeads(first.id)).toHaveLength(20);
    gated.open(1);
    await gated.read(1);
    await until(() => store.readLeads(first.id).length === 40);
    expect(store.get(first.id)).toMatchObject({ status: "running", saved: 40 });

    const run = await into;
    expect(run).toMatchObject({ alreadyInList: 20, total: 40 });
    expect(run!.added).toHaveLength(20);
    expect(lines(first.id)).toHaveLength(40);
    expect(store.get(first.id)).toMatchObject({ status: "done", saved: 40, reconciliation: { kept: 40 } });
    expect(store.readLeads(first.id).every((l) => l.email_status !== "not_checked")).toBe(true);
  });

  it("keeps the places saved before the search threw, and gives the list its status back", async () => {
    const first = store.create({ ...OPTS, depth: 1 });
    await runJob(store, first.id, runnerFor(gatedSource([batchOf(1)]).source));
    const gated = gatedSource([batchOf(2), batchOf(3)], { failAfter: 1 });
    await expect(runInto(store, first.id, { ...OPTS, depth: 2 }, runnerFor(gated.source))).rejects.toThrow();
    expect(store.get(first.id)).toMatchObject({ status: "done", saved: 40 });
    expect(store.readLeads(first.id)).toHaveLength(40);
  });
});

describe("GET /api/v1/jobs/:id/rows", () => {
  const LOCAL = { Host: "127.0.0.1:8080" };

  it("answers with the rows saved so far while the search runs, only the fields a row shows", async () => {
    const { createApp } = await import("../src/server/app.js");
    const gated = gatedSource([batchOf(1), batchOf(2)]);
    const app = createApp({ store, runner: runnerFor(gated.source) });
    const created = await app.request("/api/v1/jobs", {
      method: "POST",
      headers: { ...LOCAL, "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: "event management", city: "Kuala Lumpur", depth: 2 }),
    });
    const { id } = (await created.json()) as { id: string };
    await gated.read(0);
    await until(() => store.readLeads(id).length === 20);

    const res = await app.request(`/api/v1/jobs/${id}/rows`, { headers: LOCAL });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { rows } = (await res.json()) as { rows: Record<string, unknown>[] };
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ title: "Test Event Co 100", email_status: "not_checked", website_status: "not_checked", source: "fixture" });
    expect(Object.keys(rows[0]!)).not.toContain("fetched_at");
    // The download still waits for the search to end.
    expect((await app.request(`/api/v1/jobs/${id}/download`, { headers: LOCAL })).status).toBe(409);

    gated.open(1);
    await until(() => store.get(id)?.status === "done");
    const after = (await (await app.request(`/api/v1/jobs/${id}/rows`, { headers: LOCAL })).json()) as { rows: unknown[] };
    expect(after.rows).toHaveLength(40);
    expect((await app.request(`/api/v1/jobs/00000000-0000-4000-8000-000000000000/rows`, { headers: LOCAL })).status).toBe(404);
  });
});

describe("Search the whole city from an end-of-list single search", () => {
  it("keeps keyword, city and options, turns on the grid, and combines into the same list on read", async () => {
    const singleReq = toRequest({
      ...emptyQuery(),
      keyword: "event management",
      city: "Kuala Lumpur",
      size: "oneSearch",
      emails: false,
      lang: "ms",
      country: "MY",
    });
    const first = store.create(singleReq);
    await runJob(store, first.id, runnerFor(gatedSource([batchOf(1)]).source));
    expect(store.get(first.id)?.reason).toBe("end-of-list");

    const expandReq = toRequest({ ...queryOf(first.options), size: "wholeCity", exact: "" });
    expect(expandReq).toMatchObject({
      keyword: "event management",
      city: "Kuala Lumpur",
      lang: "ms",
      country: "MY",
      emails: false,
      socials: false,
      deep: false,
      wholeCity: true,
    });
    expect(expandReq.limit).toBeUndefined();

    const second = store.create(expandReq);
    const gridSource: PlaceSource = {
      async search(q) {
        const places = [...batchOf(1), ...batchOf(2)].map((p) => ({
          ...p,
          source: "fixture" as const,
          query: q.keyword,
          city: q.city ?? "",
        }));
        return { places, reason: "end-of-list" };
      },
    };
    await runJob(store, second.id, runnerFor(gridSource));

    const combined = readList(store, first.id);
    expect(combined).not.toBeNull();
    expect(combined!.list.runs).toBe(2);
    expect(combined!.list.rows).toHaveLength(40);
    expect(readList(store, second.id)!.list.rows).toHaveLength(40);
  });
});
