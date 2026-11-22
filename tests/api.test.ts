import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANCELLED_MESSAGE, UserFacingError } from "../src/core/errors.js";
import { chooseHit } from "../src/core/geo/geocode.js";
import { BLOCKED_MESSAGE, runScrape } from "../src/core/pipeline.js";
import { fixtureSource } from "../src/core/sources/fixture.js";
import { loadFixtureDeps } from "../src/core/sources/fixture-file.js";
import { JobStore, type Job } from "../src/jobs/store.js";
import type { Runner } from "../src/jobs/worker.js";
import { createApp } from "../src/server/app.js";
import { VERSION } from "../src/version.js";
import { hit, MELAKA_CITY, MELAKA_STATE } from "./fixtures/nominatim.js";
import { RUN20_BATCH, RUN20_SITES_DIR, run20Enrich, run20Source } from "./fixtures/run20.js";

const MELAKA = async () => chooseHit([hit(MELAKA_STATE), hit(MELAKA_CITY)]);

const fixtureRunner: Runner = (opts, onProgress) =>
  runScrape(
    opts,
    { source: run20Source(), geocode: MELAKA, enrich: run20Enrich, now: () => new Date() },
    onProgress,
  );

const blockedRunner: Runner = (opts, onProgress) =>
  runScrape(
    opts,
    {
      source: { search: async (q, p) => ({ ...(await fixtureSource([RUN20_BATCH]).search(q, p)), reason: "blocked" }) },
      geocode: MELAKA,
      enrich: run20Enrich,
      now: () => new Date(),
      blockRetry: { delaysMs: [] },
    },
    onProgress,
  );

/** A runner that waits until the test lets it finish. */
function gatedRunner() {
  const gates: Array<() => void> = [];
  const runner: Runner = async (opts, onProgress) => {
    await new Promise<void>((resolve) => gates.push(resolve));
    return fixtureRunner(opts, onProgress);
  };
  return { runner, release: () => gates.shift()?.() };
}

let dir: string;
let store: JobStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-api-"));
  store = new JobStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BODY = { keyword: "souvenir shop", city: "Melaka" };
const LOCAL = { Host: "127.0.0.1:8080" };

type App = ReturnType<typeof createApp>;

function post(app: App, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/v1/jobs", {
    method: "POST",
    headers: { ...LOCAL, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(app: App, url: string, headers: Record<string, string> = {}) {
  return app.request(url, { headers: { ...LOCAL, ...headers } });
}

async function waitFor(app: App, id: string, done: (job: Job) => boolean): Promise<Job> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await get(app, `/api/v1/jobs/${id}`);
    expect(res.status).toBe(200);
    const job = (await res.json()) as Job;
    if (done(job)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const finished = (job: Job) => job.status === "done" || job.status === "failed";

async function startJob(app: App, body: unknown = BODY): Promise<string> {
  const res = await post(app, body);
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect(typeof id).toBe("string");
  return id;
}

describe("job API on the fixture runner", () => {
  it("runs a posted job to done and downloads the leads as CSV and JSON", async () => {
    const app = createApp({ store, runner: fixtureRunner });
    const id = await startJob(app);

    const job = await waitFor(app, id, finished);
    expect(job.status).toBe("done");
    expect(job.options).toMatchObject({ keyword: "souvenir shop", city: "Melaka", depth: 1, lang: "en", emails: true });
    expect(job.progress).toMatchObject({ stage: "done", places: 19, message: "Found 19 leads in Melaka." });
    expect(job.reconciliation).toMatchObject({ found: 20, kept: 19, filtered: 0, duplicates: 1, toCheck: 10 });
    expect(job.place).toEqual({ name: "Bandaraya Melaka", type: "city", label: "Bandaraya Melaka, Malaysia" });
    expect(job.progress).not.toHaveProperty("location");

    const csv = await get(app, `/api/v1/jobs/${id}/download?format=csv&columns=lean`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="business-finder-souvenir-shop-melaka-\d{8}-\d{4}\.csv"$/);
    const bytes = new Uint8Array(await csv.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text.split("\r\n")[0]).toBe(
      "title,phone,whatsapp,emails,Email type,Can receive mail,website,category,address,review_rating,review_count,instagram,facebook,linkedin,tiktok,youtube,x",
    );
    expect(text.trimEnd().split("\r\n")).toHaveLength(20);

    const json = await get(app, `/api/v1/jobs/${id}/download?format=json&columns=full`);
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toMatch(/^application\/json/);
    const rows = (await json.json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(19);
    expect(Object.keys(rows[0]!)).toContain("place_id");

    const list = await get(app, "/api/v1/jobs");
    expect(((await list.json()) as { jobs: Job[] }).jobs.map((j) => j.id)).toEqual([id]);
  });

  it("defaults the download to the lean CSV", async () => {
    const app = createApp({ store, runner: fixtureRunner });
    const id = await startJob(app);
    await waitFor(app, id, finished);
    const res = await get(app, `/api/v1/jobs/${id}/download`);
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    // Response.text() drops a leading BOM, so decode the bytes with it kept.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(text.startsWith("﻿title,phone,whatsapp")).toBe(true);
  });

  it("keeps the leads of a blocked search and ends with the blocked message", async () => {
    const app = createApp({ store, runner: blockedRunner });
    const id = await startJob(app);
    const job = await waitFor(app, id, finished);
    expect(job.status).toBe("failed");
    expect(job.progress.message).toBe(BLOCKED_MESSAGE);
    expect(job.error).toBe(BLOCKED_MESSAGE);
    expect(job.reconciliation?.kept).toBe(19);
    const rows = (await (await get(app, `/api/v1/jobs/${id}/download?format=json`)).json()) as unknown[];
    expect(rows).toHaveLength(19);
  });

  it("fails a job with the run's plain message when the run throws, keeps cause on disk, and omits cause from API responses", async () => {
    const app = createApp({
      store,
      runner: async () => {
        throw new UserFacingError("City not found: Atlantis");
      },
    });
    const id = await startJob(app, { keyword: "souvenir shop", city: "Atlantis" });
    const job = await waitFor(app, id, finished);
    expect(job).toMatchObject({ status: "failed", error: "City not found: Atlantis" });
    expect(job).not.toHaveProperty("cause");
    expect(store.get(id)?.cause).toBe("UserFacingError: City not found: Atlantis");
  });

  it("finishes the run when writing progress to job.json fails", async () => {
    class FlakyStore extends JobStore {
      progressWrites = 0;
      override update(id: string, patch: Partial<Job>): Job {
        if (patch.progress && !patch.status) {
          this.progressWrites += 1;
          throw new Error("EBUSY: job.json is locked");
        }
        return super.update(id, patch);
      }
    }
    const flaky = new FlakyStore(dir);
    const app = createApp({ store: flaky, runner: fixtureRunner });
    const id = await startJob(app);
    const job = await waitFor(app, id, finished);
    expect(flaky.progressWrites).toBeGreaterThan(0);
    expect(job.status).toBe("done");
    expect(job.progress.stage).toBe("done");
    expect(store.readLeads(id)).toHaveLength(19);
  });

  it("runs queued jobs one at a time, in order", async () => {
    const gate = gatedRunner();
    const app = createApp({ store, runner: gate.runner });
    const first = await startJob(app);
    const second = await startJob(app, { ...BODY, city: "Ipoh" });

    await waitFor(app, first, (j) => j.status === "running");
    expect((await waitFor(app, second, () => true)).status).toBe("queued");

    gate.release();
    await waitFor(app, first, finished);
    await waitFor(app, second, (j) => j.status === "running");
    gate.release();
    expect((await waitFor(app, second, finished)).status).toBe("done");
  });

  it("deletes a finished job and a queued one, and refuses to delete a running one", async () => {
    const gate = gatedRunner();
    const app = createApp({ store, runner: gate.runner });
    const running = await startJob(app);
    const queued = await startJob(app);
    await waitFor(app, running, (j) => j.status === "running");

    const del = (id: string) => app.request(`/api/v1/jobs/${id}`, { method: "DELETE", headers: LOCAL });
    expect((await del(running)).status).toBe(409);
    expect((await del(queued)).status).toBe(204);
    expect((await get(app, `/api/v1/jobs/${queued}`)).status).toBe(404);

    gate.release();
    await waitFor(app, running, finished);
    expect(existsSync(path.join(dir, queued))).toBe(false);
    expect((await del(running)).status).toBe(204);
    expect(existsSync(path.join(dir, running))).toBe(false);
    expect((await del(running)).status).toBe(404);
  });

  it("refuses a download until the job has finished", async () => {
    const gate = gatedRunner();
    const app = createApp({ store, runner: gate.runner });
    const id = await startJob(app);
    expect((await get(app, `/api/v1/jobs/${id}/download`)).status).toBe(409);
    gate.release();
    await waitFor(app, id, finished);
  });

  it("marks jobs left running by a previous server as failed", async () => {
    const stale = store.create({ ...BODY, depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 60 });
    store.update(stale.id, { status: "running" });
    const app = createApp({ store, runner: fixtureRunner });
    const job = (await (await get(app, `/api/v1/jobs/${stale.id}`)).json()) as Job;
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/interrupted/i);
  });

  it("answers the health check with the version and the server's pid", async () => {
    const app = createApp({ store, runner: fixtureRunner });
    const res = await get(app, "/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: VERSION, pid: process.pid });
  });
});

describe("job API validation", () => {
  it.each([
    [{ keyword: "souvenir shop" }, "city"],
    [{ keyword: "souvenir shop", city: "   " }, "city"],
    [{ city: "Melaka" }, "keyword"],
    [{ ...BODY, depth: 0 }, "depth"],
    [{ ...BODY, depth: "2" }, "depth"],
    [{ ...BODY, limit: -1 }, "limit"],
    [{ ...BODY, limit: 1001 }, "limit"],
    [{ ...BODY, wholeCity: "yes" }, "wholeCity"],
    [{ ...BODY, country: "Malaysia" }, "country"],
    [{ ...BODY, emails: "yes" }, "emails"],
    [[], "body"],
  ])("rejects %j with 422", async (body, field) => {
    const app = createApp({ store, runner: fixtureRunner });
    const res = await post(app, body);
    expect(res.status).toBe(422);
    const answer = (await res.json()) as { error: string; field: string };
    expect(answer.field).toBe(field);
    expect(answer.error).not.toBe("");
    expect(store.list()).toHaveLength(0);
  });

  it("says to enter a city when the city is missing", async () => {
    const app = createApp({ store, runner: fixtureRunner });
    const res = await post(app, { keyword: "souvenir shop" });
    expect(((await res.json()) as { error: string }).error).toBe("Enter a city.");
  });

  it("rejects a body that is not JSON with 400", async () => {
    const app = createApp({ store, runner: fixtureRunner });
    expect((await post(app, "{nope")).status).toBe(400);
  });

  it("rejects an unknown download format or column set with 422", async () => {
    const app = createApp({ store, runner: fixtureRunner });
    const id = await startJob(app);
    await waitFor(app, id, finished);
    expect((await get(app, `/api/v1/jobs/${id}/download?format=xlsx`)).status).toBe(422);
    expect((await get(app, `/api/v1/jobs/${id}/download?columns=all`)).status).toBe(422);
  });

  it.each(["..%2F..%2Fescape", "..", "%2e%2e", "C%3A%5CWindows", "not-a-job"])(
    "answers 404 for the job id %j without touching the filesystem",
    async (id) => {
      const app = createApp({ store, runner: fixtureRunner });
      expect((await get(app, `/api/v1/jobs/${id}`)).status).toBe(404);
      expect((await get(app, `/api/v1/jobs/${id}/download`)).status).toBe(404);
      expect((await app.request(`/api/v1/jobs/${id}`, { method: "DELETE", headers: LOCAL })).status).toBe(404);
      expect(existsSync(dir)).toBe(true);
    },
  );
});

describe("job API content type", () => {
  const app = () => createApp({ store, runner: fixtureRunner });

  // A cross-site page can send a no-cors POST only with a "simple" content
  // type such as text/plain; requiring JSON makes the browser preflight it.
  it.each([["text/plain"], ["text/plain;charset=UTF-8"], ["application/x-www-form-urlencoded"], ["multipart/form-data; boundary=x"], [""]])(
    "refuses a POST with Content-Type %j with 415 and starts no job", async (type) => {
      const res = await app().request("/api/v1/jobs", {
        method: "POST",
        headers: type ? { ...LOCAL, "Content-Type": type } : LOCAL,
        body: JSON.stringify(BODY),
      });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: "Send the search as JSON (Content-Type: application/json)." });
      expect(store.list()).toHaveLength(0);
    });

  it.each([["application/json"], ["application/json; charset=utf-8"], ["Application/JSON"]])(
    "accepts a POST with Content-Type %j", async (type) => {
      const a = app();
      expect((await post(a, BODY, { "Content-Type": type })).status).toBe(201);
    });
});

describe("localhost guard", () => {
  const app = () => createApp({ store, runner: fixtureRunner });

  it.each([
    [{ Host: "127.0.0.1:8080", Origin: "https://evil.test" }],
    [{ Host: "localhost.evil.test" }],
    [{ Host: "localhost.evil.test:8080" }],
    [{ Host: "127.0.0.1.nip.io:8080" }],
    [{ Host: "evil.test", Origin: "http://localhost:8080" }],
    [{ Host: "localhost:8080", Origin: "http://localhost:9999" }],
    [{ Host: "localhost:8080", Origin: "http://localhost.evil.test:8080" }],
    [{ Host: "localhost:8080", Origin: "null" }],
    [{ Host: "localhost:8080", Origin: "https://localhost:8080" }],
  ])("rejects %j with 403 on GET, POST and DELETE", async (headers) => {
    const a = app();
    expect((await a.request("/api/v1/health", { headers })).status).toBe(403);
    expect((await a.request("/api/v1/jobs", { headers })).status).toBe(403);
    const created = await a.request("/api/v1/jobs", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(BODY),
    });
    expect(created.status).toBe(403);
    expect(store.list()).toHaveLength(0);

    const job = store.create({ ...BODY, depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 60 });
    expect((await a.request(`/api/v1/jobs/${job.id}`, { method: "DELETE", headers })).status).toBe(403);
    expect(store.get(job.id)).not.toBeNull();
  });

  it.each([
    [{ Host: "127.0.0.1:8080" }],
    [{ Host: "localhost:8080" }],
    [{ Host: "localhost:8080", Origin: "http://localhost:8080" }],
    [{ Host: "127.0.0.1:8081", Origin: "http://127.0.0.1:8081" }],
    [{ Host: "LOCALHOST:8080", Origin: "http://localhost:8080" }],
  ])("accepts %j", async (headers) => {
    expect((await app().request("/api/v1/health", { headers })).status).toBe(200);
  });
});

describe("job API cancel", () => {
  const cancel = (app: App, id: string) => app.request(`/api/v1/jobs/${id}/cancel`, { method: "POST", headers: LOCAL });

  /** A fixture runner whose search waits `searchDelayMs` and honours the cancel signal. */
  async function slowRunner(searchDelayMs: number): Promise<Runner> {
    const file = path.join(dir, "slow-fixture.json");
    writeFileSync(
      file,
      JSON.stringify({ geocode: { lat: 2.19, lon: 102.25, countryCode: "MY" }, batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR, searchDelayMs }),
    );
    const fixture = await loadFixtureDeps(file);
    return (opts, onProgress, signal) => runScrape(opts, { ...fixture, now: () => new Date() }, onProgress, signal);
  }

  it("cancels a running job within a second; cancelled before the first batch, it has no rows", async () => {
    const app = createApp({ store, runner: await slowRunner(5000) });
    const id = await startJob(app);
    await waitFor(app, id, (j) => j.status === "running" && j.progress.stage === "searching");

    const t0 = Date.now();
    const res = await cancel(app, id);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "cancelling" });
    const job = await waitFor(app, id, (j) => j.status !== "running");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(job).toMatchObject({ status: "cancelled", progress: { message: `${CANCELLED_MESSAGE} No places were found before it stopped.` } });
    expect(job.error).toBeUndefined();
    expect(existsSync(path.join(dir, id, "leads.jsonl"))).toBe(false);
  });

  it("cancels a queued job before it starts, and the next job still runs", async () => {
    const gate = gatedRunner();
    const app = createApp({ store, runner: gate.runner });
    const first = await startJob(app);
    const queued = await startJob(app);
    await waitFor(app, first, (j) => j.status === "running");

    const res = await cancel(app, queued);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "cancelled" });
    expect(store.get(queued)).toMatchObject({ status: "cancelled", progress: { message: CANCELLED_MESSAGE } });

    gate.release();
    expect((await waitFor(app, first, finished)).status).toBe("done");
    expect(store.get(queued)!.status).toBe("cancelled");
  });

  it("refuses a finished job with 409 and an unknown one with 404", async () => {
    const app = createApp({ store, runner: fixtureRunner });
    const id = await startJob(app);
    await waitFor(app, id, finished);
    const done = await cancel(app, id);
    expect(done.status).toBe(409);
    expect(await done.json()).toEqual({ error: "This search has already finished." });
    expect((await cancel(app, "6f1c2a8e-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await cancel(app, "not-a-job")).status).toBe(404);
  });

  it("refuses a job that a running CLI command owns", async () => {
    const job = store.create({ ...BODY, depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 60 }, {
      owner: { kind: "cli", pid: process.pid },
    });
    store.update(job.id, { status: "running" });
    const app = createApp({ store, runner: fixtureRunner });
    const res = await cancel(app, job.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This search is running in a terminal. Stop it there with Ctrl+C." });
    expect(store.get(job.id)!.status).toBe("running");
  });

  it("keeps a cancelled job cancelled when the server restarts", async () => {
    const app = createApp({ store, runner: await slowRunner(5000) });
    const id = await startJob(app);
    await waitFor(app, id, (j) => j.status === "running");
    await cancel(app, id);
    await waitFor(app, id, (j) => j.status === "cancelled");

    const restarted = createApp({ store, runner: fixtureRunner });
    const job = (await (await get(restarted, `/api/v1/jobs/${id}`)).json()) as Job;
    expect(job.status).toBe("cancelled");
    expect(job.error).toBeUndefined();
  });

  it("tells a delete of a running job to cancel it first", async () => {
    const gate = gatedRunner();
    const app = createApp({ store, runner: gate.runner });
    const id = await startJob(app);
    await waitFor(app, id, (j) => j.status === "running");
    const res = await app.request(`/api/v1/jobs/${id}`, { method: "DELETE", headers: LOCAL });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This search is still running. Cancel it first." });
    gate.release();
    await waitFor(app, id, finished);
  });
});

describe("read-time cleanup on old saved jobs", () => {
  it("returns cleaned rows and CSV/JSON lean & full exports without touching files on disk", async () => {
    const job = store.create({ ...BODY, depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 600 });
    store.appendLeads(job.id, [
      {
        title: "Old Event Co",
        address: "Old Event Co, 12 Jalan Event, 50000 KL",
        website: "https://old-event.test/",
        source: "browser",
        query: "event",
        city: "KL",
        whatsapp: "",
        emails: ["you@company.com", "hello@old-event.test"],
        email_source_url: "https://old-event.test/",
        email_status: "found",
        website_status: "found",
        instagram: "",
        facebook: "",
        linkedin: "",
        tiktok: "",
        youtube: "",
        x: "",
        sources: [
          { field: "email", value: "you@company.com", url: "https://old-event.test/", fetched_at: "2026-11-18T00:00:00.000Z" },
          { field: "email", value: "hello@old-event.test", url: "https://old-event.test/contact", fetched_at: "2026-11-18T00:00:01.000Z" },
        ],
        fetched_at: "2026-11-18T00:00:00.000Z",
      },
      {
        title: "Only Placeholder",
        address: "Only Placeholder - Branch 2, 99 Jalan Ampang",
        website: "https://placeholder-only.test/",
        source: "browser",
        query: "event",
        city: "KL",
        whatsapp: "",
        emails: ["name@company.com"],
        email_source_url: "https://placeholder-only.test/",
        email_status: "found",
        website_status: "found",
        instagram: "",
        facebook: "",
        linkedin: "",
        tiktok: "",
        youtube: "",
        x: "",
        sources: [
          { field: "email", value: "name@company.com", url: "https://placeholder-only.test/", fetched_at: "2026-11-18T00:00:00.000Z" },
        ],
        fetched_at: "2026-11-18T00:00:00.000Z",
      },
    ]);
    store.update(job.id, { status: "done", progress: { stage: "done", places: 2, message: "Found 2 leads in KL." } });

    const jobFile = path.join(dir, job.id, "job.json");
    const leadsFile = path.join(dir, job.id, "leads.jsonl");
    const jobBefore = readFileSync(jobFile);
    const leadsBefore = readFileSync(leadsFile);

    const app = createApp({ store, runner: fixtureRunner });
    const rowsRes = await get(app, `/api/v1/jobs/${job.id}/rows`);
    expect(rowsRes.status).toBe(200);
    const { rows } = (await rowsRes.json()) as { rows: Record<string, unknown>[] };
    expect(rows[0]).toMatchObject({ address: "12 Jalan Event, 50000 KL", emails: ["hello@old-event.test"], email_types: ["generic"], email_mx: null });
    expect(rows[1]).toMatchObject({ address: "Branch 2, 99 Jalan Ampang", emails: [], email_types: [], email_mx: null, email_status: "not_on_site" });

    const csvRes = await get(app, `/api/v1/jobs/${job.id}/download?format=csv&columns=lean`);
    expect(csvRes.status).toBe(200);
    const csvText = await csvRes.text();
    expect(csvText).toContain("12 Jalan Event, 50000 KL");
    expect(csvText).toContain("Branch 2, 99 Jalan Ampang");
    expect(csvText).toContain("hello@old-event.test");
    expect(csvText).not.toContain("Old Event Co, 12 Jalan Event");
    expect(csvText).not.toContain("Only Placeholder - Branch 2");
    expect(csvText).not.toContain("you@company.com");
    expect(csvText).not.toContain("name@company.com");

    const fullJsonRes = await get(app, `/api/v1/jobs/${job.id}/download?format=json&columns=full`);
    expect(fullJsonRes.status).toBe(200);
    const fullRows = (await fullJsonRes.json()) as Record<string, unknown>[];
    expect(fullRows[0]).toMatchObject({
      address: "12 Jalan Event, 50000 KL",
      emails: ["hello@old-event.test"],
      email_types: ["generic"],
      email_mx: null,
      email_source_url: "https://old-event.test/contact",
      sources: [{ field: "email", value: "hello@old-event.test", url: "https://old-event.test/contact", fetched_at: "2026-11-18T00:00:01.000Z" }],
    });
    expect(fullRows[1]).toMatchObject({
      address: "Branch 2, 99 Jalan Ampang",
      emails: [],
      email_source_url: "",
      email_status: "not_on_site",
      sources: [],
    });

    // Files on disk are byte-identical after API reads and exports.
    expect(readFileSync(jobFile)).toEqual(jobBefore);
    expect(readFileSync(leadsFile)).toEqual(leadsBefore);
  });
});

describe("filtered and sorted downloads", () => {
  it("downloads the exact filtered and sorted rows matching the query parameters in CSV and JSON", async () => {
    const app = createApp({ store, runner: fixtureRunner });
    const id = await startJob(app);
    await waitFor(app, id, finished);

    // RUN20: 19 places; 1..12 have WhatsApp, 1..10 have emails, review_count = n*3.
    // Filtering wa=1 & email=1 & reviews=15 -> ZZMARK-5..10 (6 places), sorted by name -> 10, 5, 6, 7, 8, 9.
    const query = "wa=1&email=1&reviews=15&sort=name";
    const jsonRes = await get(app, `/api/v1/jobs/${id}/download?format=json&${query}`);
    expect(jsonRes.status).toBe(200);
    const jsonRows = (await jsonRes.json()) as { title: string }[];
    expect(jsonRows.map((r) => r.title)).toEqual(["ZZMARK-10", "ZZMARK-5", "ZZMARK-6", "ZZMARK-7", "ZZMARK-8", "ZZMARK-9"]);

    const csvRes = await get(app, `/api/v1/jobs/${id}/download?format=csv&${query}`);
    expect(csvRes.status).toBe(200);
    const csvLines = (await csvRes.text()).trimEnd().split("\r\n");
    expect(csvLines).toHaveLength(7);
    expect(csvLines.slice(1).map((line) => line.split(",")[0])).toEqual([
      "ZZMARK-10",
      "ZZMARK-5",
      "ZZMARK-6",
      "ZZMARK-7",
      "ZZMARK-8",
      "ZZMARK-9",
    ]);
  });

  it("filters combined lists by new, hide_missing and hide_cat", async () => {
    const baseLead = {
      source: "browser" as const,
      query: "event",
      city: "KL",
      whatsapp: "",
      emails: [] as string[],
      email_source_url: "",
      email_status: "not_on_site" as const,
      website_status: "no_website" as const,
      instagram: "",
      facebook: "",
      linkedin: "",
      tiktok: "",
      youtube: "",
      x: "",
      fetched_at: "2026-11-18T00:00:00.000Z",
    };
    const first = store.create({ ...BODY, depth: 1, lang: "en", emails: false, socials: false, deep: false, maxSeconds: 600 });
    store.appendLeads(first.id, [
      { ...baseLead, title: "Old Planner", place_id: "p1", category: "Event planner" },
      { ...baseLead, title: "Old Arena", place_id: "p2", category: "Sports arena" },
    ]);
    store.update(first.id, { status: "done", reason: "end-of-list", progress: { stage: "done", places: 2, message: "Done" } });

    const second = store.create({ ...BODY, depth: 1, lang: "en", emails: false, socials: false, deep: false, maxSeconds: 600 });
    store.appendLeads(second.id, [
      { ...baseLead, title: "Old Planner", place_id: "p1", category: "Event planner" },
      { ...baseLead, title: "New Planner", place_id: "p3", category: "Event planner" },
      { ...baseLead, title: "New Arena", place_id: "p4", category: "Sports arena" },
    ]);
    store.update(second.id, { status: "done", reason: "end-of-list", progress: { stage: "done", places: 3, message: "Done" } });

    const app = createApp({ store, runner: fixtureRunner });
    const onlyNew = (await (await get(app, `/api/v1/jobs/${second.id}/download?format=json&new=1`)).json()) as { title: string }[];
    expect(onlyNew.map((r) => r.title)).toEqual(["New Planner", "New Arena"]);

    const hideMissingAndArena = (await (
      await get(app, `/api/v1/jobs/${second.id}/download?format=json&hide_missing=1&hide_cat=Sports+arena`)
    ).json()) as { title: string }[];
    expect(hideMissingAndArena.map((r) => r.title)).toEqual(["Old Planner", "New Planner"]);
  });

  it("filters downloads by email_type", async () => {
    const baseLead = {
      source: "browser" as const,
      query: "event",
      city: "KL",
      whatsapp: "",
      email_source_url: "",
      email_status: "found" as const,
      website_status: "found" as const,
      instagram: "",
      facebook: "",
      linkedin: "",
      tiktok: "",
      youtube: "",
      x: "",
      fetched_at: "2026-11-18T00:00:00.000Z",
    };
    const job = store.create({ ...BODY, depth: 1, lang: "en", emails: true, socials: true, deep: false, maxSeconds: 600 });
    store.appendLeads(job.id, [
      { ...baseLead, title: "Generic Shop", emails: ["info@g.test"], email_types: ["generic"], email_mx: ["ok"] },
      { ...baseLead, title: "Personal Shop", emails: ["alice.tan@p.test"], email_types: ["personal"], email_mx: ["no mail server"] },
    ]);
    store.update(job.id, { status: "done", progress: { stage: "done", places: 2, message: "Done" } });

    const app = createApp({ store, runner: fixtureRunner });
    const generic = (await (await get(app, `/api/v1/jobs/${job.id}/download?format=json&columns=full&email_type=generic`)).json()) as Record<string, unknown>[];
    expect(generic.map((r) => r.title)).toEqual(["Generic Shop"]);
    expect(generic[0]).toMatchObject({ email_types: ["generic"], email_mx: ["ok"] });

    const personal = (await (await get(app, `/api/v1/jobs/${job.id}/download?format=json&columns=full&email_type=personal`)).json()) as Record<string, unknown>[];
    expect(personal.map((r) => r.title)).toEqual(["Personal Shop"]);
    expect(personal[0]).toMatchObject({ email_types: ["personal"], email_mx: ["no mail server"] });
  });
});

describe("multi-keyword and multi-city API", () => {
  it("accepts keywords and cities arrays, round-trips non-Latin keywords through store and CSV, and rejects invalid arrays", async () => {
    const app = createApp({ store, runner: fixtureRunner });

    expect((await post(app, { keywords: [], city: "Melaka" })).status).toBe(422);
    expect((await post(app, { keyword: "cafe", cities: [] })).status).toBe(422);
    expect((await post(app, { keywords: ["cafe", ""], city: "Melaka" })).status).toBe(422);

    const id = await startJob(app, {
      keyword: "纪念品店",
      keywords: ["纪念品店", "kedai cenderamata", "நினைவுப் பொருட்கள்"],
      city: "Melaka",
      cities: ["Melaka", "Ipoh"],
    });
    const job = await waitFor(app, id, finished);
    expect(job.options.keywords).toEqual(["纪念品店", "kedai cenderamata", "நினைவுப் பொருட்கள்"]);
    expect(job.options.cities).toEqual(["Melaka", "Ipoh"]);

    const listed = (await (await get(app, `/api/v1/lists/${id}`)).json()) as { title: string; options: { keywords?: string[] } };
    expect(listed.title).toBe("纪念品店 +2 in Melaka +1");
    expect(listed.options.keywords).toEqual(["纪念品店", "kedai cenderamata", "நினைவுப் பொருட்கள்"]);

    const csv = await get(app, `/api/v1/jobs/${id}/download?format=csv&columns=full`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    const csvText = await csv.text();
    expect(csvText).toContain("纪念品店");
  });
});
