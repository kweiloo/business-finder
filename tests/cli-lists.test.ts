import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, parseCli, type ScrapeCommand } from "../src/cli/main.js";
import { chooseHit } from "../src/core/geo/geocode.js";
import { runScrape } from "../src/core/pipeline.js";
import type { RunOptions } from "../src/core/types.js";
import {
  defaultDataDir,
  defaultJobsDir,
  JobStore,
  readServerRecord,
  writeServerRecord,
  type Job,
} from "../src/jobs/store.js";
import { runJob } from "../src/jobs/worker.js";
import { startTestServer } from "./helpers/startTestServer.js";
import { hit, MELAKA_CITY, MELAKA_STATE } from "./fixtures/nominatim.js";
import { assertNoScrapedText, RUN20_BATCH, run20Enrich, RUN20_SITES_DIR, run20Source } from "./fixtures/run20.js";

let dir: string;
let env: NodeJS.ProcessEnv;
let fixturePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-lists-"));
  fixturePath = path.join(dir, "run20.json");
  writeFileSync(
    fixturePath,
    JSON.stringify({
      geocode: { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" },
      batches: [RUN20_BATCH],
      sitesDir: RUN20_SITES_DIR,
    }),
  );
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

const SCRAPE = ["scrape", "souvenir shop", "--city", "Melaka", "--source", "fixture"];

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd: dir, now: () => new Date() });
  return { code, out, err, all: [...out, ...err].join("\n") };
}

const jobs = () => new JobStore(defaultJobsDir(env));
const LIST_LINE = /^ {2}saved as list ([0-9a-f-]{36}); /;

function listId(out: string[]): string {
  const id = out.at(-1)?.match(LIST_LINE)?.[1];
  expect(id).toBeDefined();
  return id!;
}

const OPTIONS: RunOptions = {
  keyword: "souvenir shop",
  city: "Melaka",
  depth: 1,
  lang: "en",
  emails: true,
  socials: true,
  deep: true,
  maxSeconds: 600,
};

describe("runJob", () => {
  it("writes running, each progress update and the place once, then done with the leads", async () => {
    const store = new JobStore(path.join(dir, "jobs"));
    const patches: Partial<Job>[] = [];
    const update = store.update.bind(store);
    store.update = (id, patch) => {
      patches.push(patch);
      return update(id, patch);
    };
    const job = store.create(OPTIONS, { owner: { kind: "cli", pid: process.pid } });
    const seen: string[] = [];
    const run = await runJob(
      store,
      job.id,
      (o, p) =>
        runScrape(o, { source: run20Source(), geocode: async () => chooseHit([hit(MELAKA_STATE), hit(MELAKA_CITY)]), enrich: run20Enrich, now: () => new Date() }, p),
      (p) => seen.push(p.stage),
    );

    expect(run!.result.leads).toHaveLength(19);
    const statuses = patches.flatMap((p) => (p.status ? [p.status] : []));
    expect(statuses).toEqual(["running", "done"]);
    expect(patches.filter((p) => p.place)).toEqual([expect.objectContaining({ place: { name: "Bandaraya Melaka", type: "city", label: "Bandaraya Melaka, Malaysia" } })]);
    expect(seen[0]).toBe("geocoding");
    expect(seen.at(-1)).toBe("done");

    const done = store.get(job.id)!;
    expect(done).toMatchObject({ status: "done", owner: { kind: "cli", pid: process.pid }, place: { name: "Bandaraya Melaka", type: "city" } });
    expect(done.progress.stage).toBe("done");
    expect(done.reconciliation).toMatchObject({ found: 20, kept: 19 });
    expect(store.readLeads(job.id)).toHaveLength(19);
  });

  it("fails the job and rethrows when the run throws", async () => {
    const store = new JobStore(path.join(dir, "jobs"));
    const job = store.create(OPTIONS);
    await expect(runJob(store, job.id, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(store.get(job.id)).toMatchObject({ status: "failed", error: "The search stopped because something went wrong. Try again." });
  });

  it("does nothing for a job that is not queued", async () => {
    const store = new JobStore(path.join(dir, "jobs"));
    const job = store.create(OPTIONS);
    store.update(job.id, { status: "done" });
    expect(await runJob(store, job.id, async () => Promise.reject(new Error("must not run")))).toBeNull();
  });
});

describe("business-finder scrape saves a list", () => {
  it("parses --no-save", () => {
    expect((parseCli(SCRAPE) as ScrapeCommand).save).toBe(true);
    expect((parseCli([...SCRAPE, "--no-save"]) as ScrapeCommand).save).toBe(false);
  });

  it("creates a done job with the leads and the place, owned by the CLI", async () => {
    const r = await cli(SCRAPE);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const id = listId(r.out);
    expect(r.out.at(-1)).toBe(`  saved as list ${id}; run \`business-finder serve\` to see it`);

    const job = jobs().get(id)!;
    expect(job).toMatchObject({
      status: "done",
      owner: { kind: "cli", pid: process.pid },
      place: { name: "Melaka", type: "place" },
      options: { keyword: "souvenir shop", city: "Melaka" },
    });
    expect(job.progress.stage).toBe("done");
    expect(jobs().readLeads(id)).toHaveLength(19);
    // The file is written to the Downloads subfolder by default.
    expect(readdirSync(path.join(dir, "downloads", "Business Finder")).some((f) => /^business-finder-souvenir-shop-melaka-\d{8}-\d{4}\.csv$/.test(f))).toBe(true);
    assertNoScrapedText(r.all);
  });

  it("writes only the file with --no-save", async () => {
    const r = await cli([...SCRAPE, "--no-save", "--out", "only.csv"]);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, "only.csv"))).toBe(true);
    expect(r.out.at(-1)).toMatch(/^ {2}saved → /);
    expect(r.all).not.toContain("saved as list");
    expect(existsSync(defaultJobsDir(env)) ? readdirSync(defaultJobsDir(env)) : []).toEqual([]);
  });

  it("saves the places read and fails the list when Google blocks the search", async () => {
    writeFileSync(
      fixturePath,
      JSON.stringify({ geocode: { lat: 2.3, lon: 102.3, countryCode: "MY" }, batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR, reason: "blocked" }),
    );
    const r = await cli(SCRAPE);
    expect(r.code).toBe(1);
    const id = listId(r.out);
    expect(jobs().get(id)).toMatchObject({ status: "failed" });
    expect(jobs().readLeads(id)).toHaveLength(19);
  });

  it("fails the list with the run's message when the city is not found", async () => {
    writeFileSync(fixturePath, JSON.stringify({ geocode: null, batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR }));
    const r = await cli(SCRAPE);
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["City not found: Melaka"]);
    const [job] = jobs().list();
    expect(job).toMatchObject({ status: "failed", error: "City not found: Melaka" });
  });

  it("links to the list when business-finder serve is running", async () => {
    const server = await startTestServer({
      open: false,
      staticDir: path.join(dir, "no-web"),
      jobsDir: defaultJobsDir(env),
      source: "fixture",
      fixtureFile: fixturePath,
    });
    try {
      writeServerRecord(defaultDataDir(env), { pid: process.pid, port: server.port });
      const r = await cli(SCRAPE);
      const id = listId(r.out);
      expect(r.out.at(-1)).toBe(`  saved as list ${id}; open http://127.0.0.1:${server.port}/?job=${id} while business-finder serve is running`);
    } finally {
      await server.close();
    }
  });

  it("does not link to a business-finder server on the recorded port whose pid is not the recorded one", async () => {
    const server = await startTestServer({
      open: false,
      staticDir: path.join(dir, "no-web"),
      jobsDir: defaultJobsDir(env),
      source: "fixture",
      fixtureFile: fixturePath,
    });
    try {
      // The recorded process is alive (it started this test run), but the server answering is this one.
      expect(process.ppid).not.toBe(process.pid);
      writeServerRecord(defaultDataDir(env), { pid: process.ppid, port: server.port });
      const r = await cli(SCRAPE);
      expect(r.out.at(-1)).toMatch(/run `business-finder serve` to see it$/);
    } finally {
      await server.close();
    }
  });

  it("does not link to a server whose process has gone", async () => {
    const gone = spawnSync(process.execPath, ["-e", "0"]).pid!;
    writeServerRecord(defaultDataDir(env), { pid: gone, port: 1 });
    const r = await cli(SCRAPE);
    expect(r.out.at(-1)).toMatch(/run `business-finder serve` to see it$/);
  });
});

describe("business-finder serve records itself for CLI runs", () => {
  it("writes server.json while running and removes it on stop", async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const out: string[] = [];
    const exit = main(["serve", "--no-open", "--port", "0"], {
      out: (l) => out.push(l),
      err: () => {},
      env,
      cwd: dir,
      now: () => new Date(),
      untilStopped: () => stopped,
      webDir: path.join(dir, "no-web"),
    });
    while (!out.some((l) => l.startsWith("✓ Business Finder running at"))) await new Promise((r) => setTimeout(r, 20));
    const port = Number(out[0]!.match(/:(\d+)$/)![1]);
    expect(readServerRecord(defaultDataDir(env))).toEqual({ pid: process.pid, port });
    stop();
    expect(await exit).toBe(0);
    expect(readServerRecord(defaultDataDir(env))).toBeNull();
  });
});

describe("a CLI list in the server", () => {
  it("is listed as done with its leads by a server started afterwards", async () => {
    const r = await cli(SCRAPE);
    const id = listId(r.out);
    const server = await startTestServer({
      open: false,
      staticDir: path.join(dir, "no-web"),
      jobsDir: defaultJobsDir(env),
      source: "fixture",
      fixtureFile: fixturePath,
    });
    try {
      const listed = (await (await fetch(`http://127.0.0.1:${server.port}/api/v1/jobs`)).json()) as { jobs: Job[] };
      expect(listed.jobs.map((j) => [j.id, j.status])).toEqual([[id, "done"]]);
      const rows = (await (await fetch(`http://127.0.0.1:${server.port}/api/v1/jobs/${id}/download?format=json`)).json()) as unknown[];
      expect(rows).toHaveLength(19);
    } finally {
      await server.close();
    }
  });
});

describe("business-finder delete", () => {
  it("deletes every run of a search and prints how many runs it removed", async () => {
    const first = await cli(SCRAPE);
    const firstId = listId(first.out);
    const second = await cli(["scrape", "Souvenir Shop", "--city", "melaka", "--source", "fixture"]);
    expect(second.code).toBe(0);
    expect(jobs().list()).toHaveLength(2);

    const del = await cli(["delete", firstId]);
    expect(del.code).toBe(0);
    expect(del.err).toEqual([]);
    expect(del.out).toEqual(["✓ Deleted Souvenir shop in Melaka (2 runs removed)"]);
    expect(jobs().list()).toEqual([]);
  });

  it("refuses a running search with the same message and exits 2 on missing or invalid ids", async () => {
    const store = jobs();
    const job = store.create(OPTIONS, { owner: { kind: "cli", pid: process.pid } });
    store.update(job.id, { status: "running" });

    const running = await cli(["delete", job.id]);
    expect(running.code).toBe(1);
    expect(running.err).toEqual(["This search is still running. Cancel it first."]);
    expect(store.get(job.id)).not.toBeNull();

    expect((await cli(["delete", "00000000-0000-4000-8000-000000000000"])).code).toBe(2);
    expect((await cli(["delete", "not-an-id"])).code).toBe(2);
  });
});
