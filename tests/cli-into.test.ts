// `business-finder scrape --into`: more Maps searches fill one list, with the same
// duplicate rule as `add --into`; the end-of-list line; the names-only warning.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, parseCli, type ScrapeCommand } from "../src/cli/main.js";
import { NAMES_ONLY_WARNING } from "../src/jobs/dedupe.js";
import { defaultJobsDir, JobStore, type Job } from "../src/jobs/store.js";
import { startTestServer } from "./helpers/startTestServer.js";
import { makeBatch } from "./fixtures/batch.js";
import { assertNoScrapedText, RUN20_BATCH, RUN20_SITES_DIR } from "./fixtures/run20.js";

let dir: string;
let env: NodeJS.ProcessEnv;
let fixturePath: string;

function useBatch(batch: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    fixturePath,
    JSON.stringify({ geocode: { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" }, batches: [batch], sitesDir: RUN20_SITES_DIR, ...extra }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-into-"));
  fixturePath = path.join(dir, "fixture.json");
  useBatch(RUN20_BATCH);
  const data = path.join(dir, "data");
  env = {
    ...process.env,
    BUSINESS_FINDER_FIXTURE: fixturePath,
    BUSINESS_FINDER_DOWNLOADS_DIR: path.join(dir, "downloads"),
    LOCALAPPDATA: data,
    XDG_DATA_HOME: data,
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd: dir, now: () => new Date() });
  return { code, out, err, all: [...out, ...err].join("\n") };
}

const jobs = () => new JobStore(defaultJobsDir(env));
const scrape = (keyword: string, ...rest: string[]) => ["scrape", keyword, "--city", "Melaka", "--source", "fixture", ...rest];

function listId(out: string[]): string {
  const id = out.at(-1)?.match(/^ {2}saved as list ([0-9a-f-]{36}); /)?.[1];
  expect(id).toBeDefined();
  return id!;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A place in the run20 style; `n` above 20 is a place the first search did not find. */
const place = (n: number, over: Record<string, string | number> = {}) => ({
  title: `ZZMARK-${n}`,
  address: `${n} Jalan Ujian, 75000 Melaka`,
  place_id: `ZZPLACE-${pad(n)}`,
  data_id: `0x0:0x${n.toString(16)}`,
  ...over,
});

describe("business-finder scrape --into: parsing", () => {
  it("takes a list id, and refuses a bad id or --no-save", async () => {
    const id = "0d4f2a9e-1111-4222-8333-444455556666";
    expect((parseCli(scrape("gift shop", "--into", id)) as ScrapeCommand).into).toBe(id);
    expect((parseCli(scrape("gift shop")) as ScrapeCommand).into).toBeUndefined();
    const bad = await cli(scrape("gift shop", "--into", "nope"));
    expect(bad.code).toBe(2);
    expect(bad.err.join("\n")).toMatch(/--into must be a list id/);
    const noSave = await cli(scrape("gift shop", "--into", id, "--no-save"));
    expect(noSave.code).toBe(2);
    expect(noSave.err.join("\n")).toMatch(/--into adds to a saved list/);
  });
});

describe("business-finder scrape --into", () => {
  it("adds only the places the list does not have, keeps a shared phone under another place, and keeps the list's rows", async () => {
    const first = await cli(scrape("souvenir shop"));
    expect(first.code).toBe(0);
    const id = listId(first.out);
    const before = jobs().readLeads(id);
    const beforeJob = jobs().get(id)!;
    expect(before).toHaveLength(19);

    // Places 1–5 again, two new places, and a new place on place 13's landline.
    useBatch(makeBatch([...[1, 2, 3, 4, 5].map((n) => place(n)), place(21), place(22), place(23, { phone: "03-2000 0013" })]));
    const r = await cli([...scrape("gift shop", "--into", id), "--out", "more.csv"]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ 3 leads (emails 0/3, phones 1/3, WhatsApp 0/3, same phone 0/3)");
    expect(r.out).toContain("  reconciliation: found 8 = kept 3 + filtered 0 + duplicates 5");
    expect(r.out).toContain("  list: 3 added, 5 already in it, 22 places in all");
    expect(listId(r.out)).toBe(id);
    assertNoScrapedText(r.all);

    const after = jobs().readLeads(id);
    expect(after).toHaveLength(22);
    expect(after.slice(0, 19)).toEqual(before);
    expect(after.slice(19).map((l) => l.place_id)).toEqual(["ZZPLACE-21", "ZZPLACE-22", "ZZPLACE-23"]);
    // The file holds the places this search added.
    expect(readFileSync(path.join(dir, "more.csv"), "utf8").trim().split("\n")).toHaveLength(4);

    const job = jobs().get(id)!;
    expect(job).toMatchObject({ status: "done", options: beforeJob.options, place: beforeJob.place, reason: "end-of-list" });
    expect(job.held).toBeUndefined();
    expect(job.progress).toMatchObject({ stage: "done", places: 22 });
    const rec = job.reconciliation!;
    expect(rec).toMatchObject({ found: 28, kept: 22, filtered: 0, duplicates: 6 });
    expect(rec.toCheck).toBe(rec.fetched + rec.unreachable + rec.mismatched + rec.skipped);
    expect(readdirSync(defaultJobsDir(env))).toEqual([id]);
  });

  it("refuses a list that does not exist or is still running, and leaves it as it was", async () => {
    const missing = await cli(scrape("gift shop", "--into", "0d4f2a9e-1111-4222-8333-444455556666"));
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toMatch(/No list 0d4f2a9e-1111-4222-8333-444455556666/);

    const store = jobs();
    const job = store.create({ keyword: "k", city: "Melaka", depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 60 });
    const running = store.update(job.id, { status: "running", owner: { kind: "cli", pid: process.pid } });
    const busy = await cli(scrape("gift shop", "--into", job.id));
    expect(busy.code).toBe(2);
    expect(busy.err.join("\n")).toMatch(/still running/);
    expect(store.get(job.id)).toEqual(running);
    expect(store.readLeads(job.id)).toEqual([]);
  });

  it("puts the list back as it was when the search fails", async () => {
    const id = listId((await cli(scrape("souvenir shop"))).out);
    const before = jobs().get(id)!;
    useBatch(RUN20_BATCH, { geocode: null });
    const r = await cli(scrape("gift shop", "--into", id));
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["City not found: Melaka"]);
    expect(jobs().get(id)).toEqual(before);
    expect(jobs().readLeads(id)).toHaveLength(19);
  });

  it("keeps the places read before Google blocked the search, leaves the list done and exits 1", async () => {
    const id = listId((await cli(scrape("souvenir shop"))).out);
    useBatch(makeBatch([place(21), place(22)]), { reason: "blocked" });
    const r = await cli(scrape("gift shop", "--into", id));
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/Google Maps stopped answering searches from this computer for now/);
    expect(jobs().get(id)).toMatchObject({ status: "done", reason: "blocked" });
    expect(jobs().readLeads(id)).toHaveLength(21);
  });

  it("still recognises existing rows in an old-shape list on scrape --into", async () => {
    const store = jobs();
    const job = store.create({ keyword: "souvenir shop", city: "Melaka", depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 600 });
    store.appendLeads(job.id, [
      {
        title: "ZZMARK-1",
        address: "ZZMARK-1, 1 Jalan Ujian, 75000 Melaka",
        place_id: "ZZPLACE-01",
        data_id: "0x0:0x1",
        website: "https://shop-1.test/",
        phone: "012-000 0001",
        source: "browser",
        query: "souvenir shop",
        city: "Melaka",
        whatsapp: "https://wa.me/60120000001",
        emails: ["you@company.com"],
        email_source_url: "https://shop-1.test/",
        email_status: "found",
        website_status: "found",
        instagram: "",
        facebook: "",
        linkedin: "",
        tiktok: "",
        youtube: "",
        x: "",
        fetched_at: "2026-11-18T00:00:00.000Z",
      },
    ]);
    store.update(job.id, { status: "done", progress: { stage: "done", places: 1, message: "Found 1 lead in Melaka." } });

    const leadsFile = path.join(defaultJobsDir(env), job.id, "leads.jsonl");
    const firstLineBefore = readFileSync(leadsFile, "utf8").trim().split("\n")[0];

    useBatch(makeBatch([place(1), place(21)]));
    const r = await cli([...scrape("gift shop", "--into", job.id), "--out", "into-old.csv"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  list: 1 added, 1 already in it, 2 places in all");
    const linesAfter = readFileSync(leadsFile, "utf8").trim().split("\n");
    expect(linesAfter[0]).toBe(firstLineBefore);
    expect(linesAfter).toHaveLength(2);
  });
});

describe("the end of Google Maps' list", () => {
  it("says one search shows about 100–120 places and how to find more, under the counts", async () => {
    const r = await cli(scrape("souvenir shop"));
    const id = listId(r.out);
    const at = r.out.findIndex((l) => l.startsWith("  reconciliation:"));
    expect(r.out[at + 1]).toBe(
      `  reached the end of Google Maps' results: one search shows at most about 100–120 places. For more, search other words or a nearby area with --into ${id}.`,
    );
    expect(jobs().get(id)?.reason).toBe("end-of-list");
  });

  it("leaves out --into when the run is not saved, and says nothing when the search stopped for another reason", async () => {
    const unsaved = await cli([...scrape("souvenir shop"), "--no-save"]);
    expect(unsaved.out).toContain(
      "  reached the end of Google Maps' results: one search shows at most about 100–120 places. For more, search other words or a nearby area.",
    );
    useBatch(RUN20_BATCH, { reason: "depth" });
    const r = await cli(scrape("souvenir shop"));
    expect(r.all).not.toContain("reached the end");
    expect(jobs().get(listId(r.out))?.reason).toBe("depth");
  });
});

describe("a run that returns names only", () => {
  const namesOnly = () => makeBatch([1, 2, 3].map((n) => ({ title: `ZZMARK-${n}`, place_id: `ZZPLACE-${pad(n)}`, data_id: `0x0:0x${n}` })));

  it("warns in the CLI and on the job, and still finishes done", async () => {
    useBatch(namesOnly());
    const r = await cli(scrape("souvenir shop"));
    expect(r.code).toBe(0);
    const at = r.out.findIndex((l) => l.startsWith("✓ 3 leads"));
    expect(r.out[at + 1]).toBe(`  warning: ${NAMES_ONLY_WARNING}`);
    assertNoScrapedText(r.all);
    const id = listId(r.out);
    expect(jobs().get(id)).toMatchObject({ status: "done", warning: NAMES_ONLY_WARNING });

    const server = await startTestServer({
      open: false,
      staticDir: path.join(dir, "no-web"),
      jobsDir: defaultJobsDir(env),
      source: "fixture",
      fixtureFile: fixturePath,
    });
    try {
      const listed = (await (await fetch(`http://127.0.0.1:${server.port}/api/v1/jobs`)).json()) as { jobs: Job[] };
      expect(listed.jobs.map((j) => [j.id, j.warning])).toEqual([[id, NAMES_ONLY_WARNING]]);
    } finally {
      await server.close();
    }
  });

  it("does not warn when one place has a detail", async () => {
    useBatch(makeBatch([{ title: "ZZMARK-1", place_id: "ZZPLACE-01" }, { title: "ZZMARK-2", place_id: "ZZPLACE-02", phone: "012-000 0002" }]));
    const r = await cli(scrape("souvenir shop"));
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("warning");
    expect(jobs().get(listId(r.out))?.warning).toBeUndefined();
  });
});
