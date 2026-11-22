// The combined list through the entry points: the HTTP API the page reads,
// and the CLI an agent runs (`business-finder lists`, and a repeated `scrape`).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { toLead } from "../src/core/leads/normalize.js";
import type { Lead, RawPlace, RunOptions } from "../src/core/types.js";
import { defaultJobsDir, JobStore, type Job, type JobStatus } from "../src/jobs/store.js";
import type { Runner } from "../src/jobs/worker.js";
import { createApp } from "../src/server/app.js";
import { makeBatch } from "./fixtures/batch.js";
import { assertNoScrapedText, RUN20_PLACES, RUN20_SITES_DIR } from "./fixtures/run20.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-combine-entry-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OPTIONS: RunOptions = { keyword: "dentist", city: "Lisbon", depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 60 };
const lead = (p: Partial<RawPlace> & { title: string }): Lead => toLead({ source: "fixture", query: "dentist", city: "Lisbon", ...p }, "PT");

describe("the API", () => {
  const LOCAL = { Host: "127.0.0.1:8080" };
  const idle: Runner = () => new Promise(() => {});
  let store: JobStore;
  let clock: number;
  beforeEach(() => {
    clock = Date.parse("2026-11-19T08:00:00Z");
    store = new JobStore(path.join(dir, "jobs"), { now: () => new Date((clock += 60_000)) });
  });

  function saved(status: JobStatus, leads: Lead[], extra: Partial<Job> = {}, options = OPTIONS): Job {
    const job = store.create(options);
    store.appendLeads(job.id, leads);
    return store.update(job.id, { status, ...extra });
  }

  function twoRuns() {
    const older = saved("done", [lead({ title: "Smile", place_id: "p1", phone: "+351 213 000 001" }), lead({ title: "Old", place_id: "p2" })]);
    const newer = saved("done", [lead({ title: "Smile", place_id: "p1", phone: "+351 213 999 999" }), lead({ title: "Teeth", place_id: "p3" })], {
      reason: "end-of-list",
    });
    return { older, newer };
  }

  const get = (url: string) => createApp({ store, runner: idle }).request(url, { headers: LOCAL });

  it("lists one entry per search with the combined count", async () => {
    const { newer } = twoRuns();
    saved("done", [lead({ title: "Other", place_id: "p9" })], {}, { ...OPTIONS, keyword: "florist" });
    const { lists } = (await (await get("/api/v1/lists")).json()) as { lists: { id: string; title: string; count: number; runs: number }[] };
    expect(lists.map((l) => [l.title, l.count, l.runs])).toEqual([
      ["Florist in Lisbon", 1, 1],
      ["Dentist in Lisbon", 3, 2],
    ]);
    expect(lists[1]!.id).toBe(newer.id);
  });

  it("opens the combined list from an older run's id", async () => {
    const { older, newer } = twoRuns();
    const res = await get(`/api/v1/lists/${older.id}`);
    expect(await res.json()).toMatchObject({ id: newer.id, title: "Dentist in Lisbon", runs: 2 });
    expect((await get("/api/v1/lists/00000000-0000-4000-8000-000000000000")).status).toBe(404);

    const body = (await (await get(`/api/v1/jobs/${older.id}/rows`)).json()) as {
      rows: { title: string; phone: string | null; new: boolean; not_found_last_time: boolean }[];
      list: { runs: number; latest: string; fresh: number; missing: number };
    };
    expect(body.rows.map((r) => [r.title, r.phone, r.new, r.not_found_last_time])).toEqual([
      ["Smile", "+351 213 999 999", false, false],
      ["Old", null, false, true],
      ["Teeth", null, true, false],
    ]);
    expect(body.list).toEqual({
      runs: 2,
      latest: newer.createdAt,
      runDates: [older.createdAt, newer.createdAt],
      fresh: 1,
      missing: 1,
    });
  });

  it("downloads the combined list, with the marker columns in the full set and the lean set unchanged", async () => {
    const { older } = twoRuns();
    const full = (await (await get(`/api/v1/jobs/${older.id}/download?format=json&columns=full`)).json()) as Record<string, unknown>[];
    expect(full.map((r) => [r.title, r.new, r.not_found_last_time])).toEqual([
      ["Smile", false, false],
      ["Old", false, true],
      ["Teeth", true, false],
    ]);
    expect(full[2]!.first_seen).toMatch(/^2026-11-19T/);
    const lean = await (await get(`/api/v1/jobs/${older.id}/download?format=csv`)).text();
    expect(lean.split("\r\n")[0]).not.toMatch(/first_seen|not_found_last_time/);
    expect(lean.trim().split("\r\n")).toHaveLength(4);
  });

  it("keeps the first run's place spelling on the combined list so title and properties line agree", async () => {
    const first = saved("done", [lead({ title: "Smile", place_id: "p1" })], { place: { name: "Melaka", type: "place" } }, { ...OPTIONS, keyword: "gift shop", city: "Melaka" });
    const newer = saved("done", [lead({ title: "Smile", place_id: "p1" })], { place: { name: "melaka", type: "place" } }, { ...OPTIONS, keyword: "Gift Shop", city: "melaka" });
    const body = (await (await get(`/api/v1/lists/${newer.id}`)).json()) as { id: string; title: string; place?: { name: string } };
    expect(body.id).toBe(newer.id);
    expect(body.title).toBe("Gift shop in Melaka");
    expect(body.place?.name).toBe("Melaka");
    expect(first.id).not.toBe(newer.id);
  });

  it("holds the download back while a re-run of the search is still going", async () => {
    const { older } = twoRuns();
    saved("running", [], { owner: { kind: "cli", pid: process.pid } });
    expect((await get(`/api/v1/jobs/${older.id}/download`)).status).toBe(409);
  });

  const delList = (id: string, headers: Record<string, string> = {}) =>
    createApp({ store, runner: idle }).request(`/api/v1/lists/${id}`, { method: "DELETE", headers: { ...LOCAL, ...headers } });

  it("deletes every run of a combined list so no older run reappears in the rail", async () => {
    const { older, newer } = twoRuns();
    const other = saved("done", [lead({ title: "Other", place_id: "p9" })], {}, { ...OPTIONS, keyword: "florist" });
    expect((await delList(newer.id)).status).toBe(204);
    expect(store.list().map((j) => j.id)).toEqual([other.id]);
    const jobsBody = (await (await get("/api/v1/jobs")).json()) as { jobs: Job[] };
    expect(jobsBody.jobs.map((j) => j.id)).toEqual([other.id]);
    const listsBody = (await (await get("/api/v1/lists")).json()) as { lists: { id: string }[] };
    expect(listsBody.lists.map((l) => l.id)).toEqual([other.id]);
    expect((await get(`/api/v1/lists/${older.id}`)).status).toBe(404);
  });

  it("deletes a combined list from an older run's id too, and keeps separate --title lists apart", async () => {
    const { older } = twoRuns();
    const webA = saved("done", [lead({ title: "A" })], { source: "web" }, { ...OPTIONS, keyword: "Agencies", city: "" });
    const webB = saved("done", [lead({ title: "B" })], { source: "web" }, { ...OPTIONS, keyword: "Agencies", city: "" });
    expect((await delList(older.id)).status).toBe(204);
    expect((await delList(webA.id)).status).toBe(204);
    expect(store.list().map((j) => j.id)).toEqual([webB.id]);
  });

  it("refuses to delete a combined list when any run is still running and keeps every run", async () => {
    const { older, newer } = twoRuns();
    const running = saved("running", [], { owner: { kind: "cli", pid: process.pid } });
    const res = await delList(older.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This search is still running. Cancel it first." });
    expect(store.list().map((j) => j.id)).toEqual([running.id, newer.id, older.id]);
  });

  it("reports which runs remain when a multi-run delete fails midway and keeps the list reachable", async () => {
    const { older, newer } = twoRuns();
    const origDelete = store.delete.bind(store);
    store.delete = (id: string) => {
      if (id === older.id) throw new Error("EPERM: locked");
      return origDelete(id);
    };
    const res = await delList(newer.id);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; remaining: string[] };
    expect(body.remaining).toEqual([older.id, newer.id]);
    expect(body.error).toBe("2 of 2 searches could not be deleted. Try again.");
    expect(body.error).not.toContain(older.id);
    expect(body.error).not.toContain(newer.id);
    expect(store.get(newer.id)).not.toBeNull();
    expect((await get(`/api/v1/lists/${newer.id}`)).status).toBe(200);
  });

  it("answers 404 for unknown or invalid list ids and enforces localhost on DELETE /api/v1/lists/:id", async () => {
    const { newer } = twoRuns();
    expect((await delList("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await delList("not-a-job")).status).toBe(404);
    const crossSite = await createApp({ store, runner: idle }).request(`/api/v1/lists/${newer.id}`, {
      method: "DELETE",
      headers: { Host: "127.0.0.1:8080", Origin: "https://evil.test" },
    });
    expect(crossSite.status).toBe(403);
    expect(store.get(newer.id)).not.toBeNull();
  });
});

describe("the CLI", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    const data = path.join(dir, "data");
    env = { ...process.env, LOCALAPPDATA: data, XDG_DATA_HOME: data };
  });

  /** A fixture that finds places `from`..`to` of the run20 set, then reaches the end of the list. */
  function fixture(name: string, from: number, to: number): string {
    const file = path.join(dir, `${name}.json`);
    const places = RUN20_PLACES.slice(from - 1, to);
    writeFileSync(
      file,
      JSON.stringify({ geocode: { lat: 2.19, lon: 102.25, countryCode: "MY" }, batches: [makeBatch(places)], sitesDir: RUN20_SITES_DIR }),
    );
    return file;
  }

  async function cli(argv: string[], fixtureFile?: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: fixtureFile ? { ...env, BUSINESS_FINDER_FIXTURE: fixtureFile } : env,
      cwd: dir,
      now: () => new Date(),
    });
    return { code, out, err };
  }

  const SCRAPE = ["scrape", "souvenir shop", "--city", "Melaka", "--source", "fixture", "--json", "--full"];

  it("combines a repeated search: one list, the file holds all of it, and the job files stay as written", async () => {
    const first = await cli([...SCRAPE, "--out", "first.json"], fixture("first", 1, 15));
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.out.some((l) => l.startsWith("  list:"))).toBe(false);
    const store = new JobStore(defaultJobsDir(env));
    const [firstJob] = store.list();
    const firstLeads = readFileSync(path.join(store.dir, firstJob!.id, "leads.jsonl"));

    const again = await cli(["scrape", "Souvenir  Shop", ...SCRAPE.slice(2), "--out", "again.json"], fixture("again", 6, 19));
    expect(again.code).toBe(0);
    expect(again.out).toContain("  list: 19 places in all from 2 runs of this search, 4 new");
    assertNoScrapedText(again.out.join("\n"));

    const rows = JSON.parse(readFileSync(path.join(dir, "again.json"), "utf8")) as { title: string; new: boolean; not_found_last_time: boolean }[];
    expect(rows).toHaveLength(19);
    expect(rows.filter((r) => r.new).map((r) => r.title)).toEqual(["ZZMARK-16", "ZZMARK-17", "ZZMARK-18", "ZZMARK-19"]);
    expect(rows.filter((r) => r.not_found_last_time).map((r) => r.title)).toEqual(["ZZMARK-1", "ZZMARK-2", "ZZMARK-3", "ZZMARK-4", "ZZMARK-5"]);
    // Every run stays its own job, as written.
    expect(store.list()).toHaveLength(2);
    expect(readFileSync(path.join(store.dir, firstJob!.id, "leads.jsonl"))).toEqual(firstLeads);

    const listed = await cli(["lists"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toHaveLength(1);
    const newest = store.list()[0]!;
    expect(listed.out[0]).toMatch(new RegExp(`^Souvenir shop in Melaka · 19 places, 2 runs · last run \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} · ${newest.id}$`));
    assertNoScrapedText(listed.out.join("\n"));

    const json = await cli(["lists", "--json"]);
    expect(JSON.parse(json.out.join("\n"))).toEqual([
      {
        id: newest.id,
        title: "Souvenir shop in Melaka",
        keyword: "Souvenir  Shop",
        city: "Melaka",
        places: 19,
        categories: [{ name: "Souvenir shop", places: 19 }],
        otherPlaces: 0,
        runs: 2,
        lastRun: newest.createdAt,
        status: "done",
      },
    ]);
  });

  it("says so when there are no lists, and rejects unknown options", async () => {
    expect((await cli(["lists"])).out).toEqual(["No saved lists yet."]);
    expect((await cli(["lists", "--all"])).code).toBe(2);
  });
});
