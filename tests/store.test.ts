import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDataDir, defaultJobsDir, JobStore, legacyDataDir, migrateDataDir } from "../src/jobs/store.js";
import type { Lead, RunOptions } from "../src/core/types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

function lead(n: number): Lead {
  return {
    title: `ZZMARK-${n}`,
    source: "fixture",
    query: "souvenir shop",
    city: "Melaka",
    whatsapp: "",
    emails: [`zzmark${n}@shop-${n}.test`],
    email_source_url: "",
    email_status: "found",
    website_status: "found",
    instagram: "",
    facebook: "",
    linkedin: "",
    tiktok: "",
    youtube: "",
    x: "",
    fetched_at: "2026-11-17T00:00:00.000Z",
  };
}

describe("JobStore", () => {
  it("round-trips a job through job.json and leads.jsonl", () => {
    const store = new JobStore(dir);
    const job = store.create(OPTIONS);
    expect(job.status).toBe("queued");
    expect(job.options).toEqual(OPTIONS);
    expect(job.progress.message).not.toBe("");
    expect(Number.isNaN(Date.parse(job.createdAt))).toBe(false);

    store.update(job.id, { status: "running", progress: { stage: "searching", places: 4, message: "Searching Melaka… 4 places" } });
    store.appendLeads(job.id, [lead(1), lead(2)]);
    store.appendLeads(job.id, [lead(3)]);

    // A second store on the same folder (a restarted server) sees the same state.
    const reopened = new JobStore(dir);
    expect(reopened.get(job.id)).toMatchObject({ id: job.id, status: "running", progress: { places: 4 } });
    expect(reopened.readLeads(job.id).map((l) => l.title)).toEqual(["ZZMARK-1", "ZZMARK-2", "ZZMARK-3"]);
    expect(existsSync(path.join(dir, job.id, "job.json"))).toBe(true);
    expect(existsSync(path.join(dir, job.id, "leads.jsonl"))).toBe(true);
  });

  it("lists jobs newest first and deletes one", () => {
    let t = Date.parse("2026-11-17T00:00:00Z");
    const store = new JobStore(dir, { now: () => new Date((t += 1000)) });
    const a = store.create(OPTIONS);
    const b = store.create({ ...OPTIONS, city: "Ipoh" });
    expect(store.list().map((j) => j.id)).toEqual([b.id, a.id]);
    expect(store.delete(a.id)).toBe(true);
    expect(store.get(a.id)).toBeNull();
    expect(existsSync(path.join(dir, a.id))).toBe(false);
    expect(store.list().map((j) => j.id)).toEqual([b.id]);
    expect(store.delete(a.id)).toBe(false);
  });

  it("returns no leads for a job that has none yet", () => {
    const store = new JobStore(dir);
    expect(store.readLeads(store.create(OPTIONS).id)).toEqual([]);
  });

  it("leaves the previous job.json intact when the process dies between the temp write and the rename", () => {
    const store = new JobStore(dir);
    const job = store.create(OPTIONS);
    const before = readFileSync(path.join(dir, job.id, "job.json"), "utf8");

    const crashing = new JobStore(dir, {
      fs: {
        ...fs,
        renameSync: () => {
          throw new Error("simulated crash before rename");
        },
      },
    });
    expect(() => crashing.update(job.id, { status: "done" })).toThrow(/simulated crash/);

    expect(readFileSync(path.join(dir, job.id, "job.json"), "utf8")).toBe(before);
    const reopened = new JobStore(dir);
    expect(reopened.get(job.id)?.status).toBe("queued");
    expect(reopened.list()).toHaveLength(1);
  });

  it("ignores a half-written last line in leads.jsonl", () => {
    const store = new JobStore(dir);
    const job = store.create(OPTIONS);
    store.appendLeads(job.id, [lead(1)]);
    fs.appendFileSync(path.join(dir, job.id, "leads.jsonl"), '{"title":"ZZMARK-2","sour');
    expect(store.readLeads(job.id).map((l) => l.title)).toEqual(["ZZMARK-1"]);
  });

  it("skips folders that are not jobs", () => {
    const store = new JobStore(dir);
    store.create(OPTIONS);
    fs.mkdirSync(path.join(dir, "stray"));
    writeFileSync(path.join(dir, "notes.txt"), "x");
    expect(store.list()).toHaveLength(1);
  });

  it.each(["../escape", "..", "a/b", "a\\b", "C:\\Windows", "", "%2e%2e"])("refuses the job id %j", (id) => {
    const store = new JobStore(dir);
    const outside = path.join(dir, "..", "escape");
    expect(store.get(id)).toBeNull();
    expect(store.delete(id)).toBe(false);
    expect(store.readLeads(id)).toEqual([]);
    expect(() => store.update(id, { status: "done" })).toThrow();
    expect(() => store.appendLeads(id, [lead(1)])).toThrow();
    expect(existsSync(outside)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("puts business-finder's data in LOCALAPPDATA on Windows and XDG_DATA_HOME or ~/.local/share elsewhere", () => {
    expect(defaultDataDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(
      path.win32.join("C:\\Users\\u\\AppData\\Local", "business-finder"),
    );
    expect(defaultDataDir({}, "win32", "C:\\Users\\u")).toBe(path.win32.join("C:\\Users\\u", "AppData", "Local", "business-finder"));
    expect(defaultDataDir({}, "linux", "/home/u")).toBe(path.posix.join("/home/u", ".local", "share", "business-finder"));
    expect(defaultDataDir({ XDG_DATA_HOME: "/data" }, "linux", "/home/u")).toBe(path.posix.join("/data", "business-finder"));
    expect(legacyDataDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(
      path.win32.join("C:\\Users\\u\\AppData\\Local", "leadscout"),
    );
    expect(legacyDataDir({ XDG_DATA_HOME: "/data" }, "linux", "/home/u")).toBe(path.posix.join("/data", "leadscout"));
  });

  it("defaults to LOCALAPPDATA on Windows and XDG_DATA_HOME or ~/.local/share elsewhere", () => {
    expect(defaultJobsDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(
      path.win32.join("C:\\Users\\u\\AppData\\Local", "business-finder", "jobs"),
    );
    expect(defaultJobsDir({}, "linux", "/home/u")).toBe(path.posix.join("/home/u", ".local", "share", "business-finder", "jobs"));
    expect(defaultJobsDir({ XDG_DATA_HOME: "/data" }, "linux", "/home/u")).toBe(path.posix.join("/data", "business-finder", "jobs"));
  });
});

describe("JobStore cancelled jobs", () => {
  it("round-trips the cancelled status", () => {
    const store = new JobStore(dir);
    const job = store.create(OPTIONS);
    store.update(job.id, { status: "cancelled", progress: { stage: "searching", places: 0, message: "Search cancelled." } });
    expect(new JobStore(dir).get(job.id)).toMatchObject({ status: "cancelled", progress: { message: "Search cancelled." } });
  });
});

describe("JobStore holding a finished list while rows are added", () => {
  const progress = { stage: "searching" as const, places: 0, message: "Adding places…" };
  const owner = { kind: "cli" as const, pid: process.pid };

  function doneJob(store: JobStore) {
    const job = store.create(OPTIONS);
    return store.update(job.id, { status: "done", progress: { stage: "done", places: 3, message: "Found 3 leads in Melaka." } });
  }

  it("marks the list running for its owner, then puts its status and progress back", () => {
    const store = new JobStore(dir);
    const job = doneJob(store);
    const held = store.hold(job.id, owner, progress)!;
    expect(held).toMatchObject({ status: "running", owner, progress });
    expect(store.get(job.id)).toMatchObject({ status: "running" });

    const back = store.release(job.id, { reconciliation: { found: 1, kept: 1, filtered: 0, duplicates: 0, toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 } });
    expect(back).toMatchObject({ status: "done", progress: job.progress, reconciliation: { found: 1 } });
    expect(back.held).toBeUndefined();
    expect(readdirSync(path.join(dir, job.id)).sort()).toEqual(["job.json"]);
  });

  it("refuses a list that is held, queued or running", () => {
    const store = new JobStore(dir);
    const job = doneJob(store);
    store.hold(job.id, owner, progress);
    expect(() => store.hold(job.id, owner, progress)).toThrow(/still running/);
    const running = store.create(OPTIONS);
    expect(() => store.hold(running.id, owner, progress)).toThrow(/still running/);
    expect(store.hold("0d4f2a9e-1111-4222-8333-444455556666", owner, progress)).toBeNull();
  });

  it("refuses while another live process is taking the list, and takes over from one that has gone", () => {
    const store = new JobStore(dir);
    const job = doneJob(store);
    const lock = path.join(dir, job.id, "hold.lock");
    writeFileSync(lock, String(process.pid));
    expect(() => store.hold(job.id, owner, progress)).toThrow(/still running/);
    expect(store.get(job.id)?.status).toBe("done");

    const gone = spawnSync(process.execPath, ["-e", "0"]).pid!;
    writeFileSync(lock, String(gone));
    expect(store.hold(job.id, owner, progress)?.status).toBe("running");
    expect(existsSync(lock)).toBe(false);
  });

  it("takes over a list held by a process that has gone, keeping the status it had before", () => {
    const store = new JobStore(dir);
    const job = doneJob(store);
    const gone = spawnSync(process.execPath, ["-e", "0"]).pid!;
    store.hold(job.id, { kind: "cli", pid: gone }, progress);
    expect(store.hold(job.id, owner, progress)?.owner).toEqual(owner);
    expect(store.release(job.id)).toMatchObject({ status: "done", progress: job.progress });
  });
});

describe("JobStore read-time cleanup", () => {
  it("strips the leading title from the address, drops placeholder emails, trims run-on emails and keeps real ones", () => {
    const store = new JobStore(dir);
    const job = store.create(OPTIONS);
    const oldRows: Lead[] = [
      {
        ...lead(1),
        title: "Shop One",
        address: "Shop One, 10 Jalan Test, 75000 Melaka",
        website: "https://www.shop-one.test/",
        emails: ["you@company.com", "name@yourcompany.com", "sales@shop-one.test", "hello@shop-one.testx"],
        email_source_url: "https://www.shop-one.test/",
        sources: [
          { field: "email", value: "you@company.com", url: "https://www.shop-one.test/", fetched_at: "2026-11-18T00:00:00.000Z" },
          { field: "email", value: "name@yourcompany.com", url: "https://www.shop-one.test/", fetched_at: "2026-11-18T00:00:00.000Z" },
          { field: "email", value: "sales@shop-one.test", url: "https://www.shop-one.test/contact", fetched_at: "2026-11-18T00:00:01.000Z" },
          { field: "email", value: "hello@shop-one.testx", url: "https://www.shop-one.test/", fetched_at: "2026-11-18T00:00:00.000Z" },
          { field: "instagram", value: "https://instagram.com/shopone", url: "https://www.shop-one.test/", fetched_at: "2026-11-18T00:00:00.000Z" },
        ],
      },
      {
        ...lead(2),
        title: "Shop Two",
        address: "Shop Two - Cawangan KL, 5 Jalan Dua, 50000 KL",
        emails: ["you@company.com"],
        email_source_url: "https://shop-two.test/",
        email_status: "found",
        sources: [
          { field: "email", value: "you@company.com", url: "https://shop-two.test/", fetched_at: "2026-11-18T00:00:00.000Z" },
          { field: "facebook", value: "https://facebook.com/shoptwo", url: "https://shop-two.test/", fetched_at: "2026-11-18T00:00:00.000Z" },
        ],
      },
      {
        ...lead(3),
        title: "Legacy Shop",
        address: "Legacy Shop，中山路 12 号",
        emails: ["you@company.com", "hi@legacy.test"],
        email_source_url: "https://legacy.test/",
        // No `sources` field: written before provenance existed.
      },
    ];
    store.appendLeads(job.id, oldRows);

    const jobFile = path.join(dir, job.id, "job.json");
    const leadsFile = path.join(dir, job.id, "leads.jsonl");
    const jobBefore = readFileSync(jobFile);
    const leadsBefore = readFileSync(leadsFile);

    const cleaned = store.readLeads(job.id);
    expect(cleaned[0]).toMatchObject({
      address: "10 Jalan Test, 75000 Melaka",
      emails: ["sales@shop-one.test", "hello@shop-one.test"],
      email_types: ["generic", "generic"],
      email_source_url: "https://www.shop-one.test/contact",
      email_status: "found",
      sources: [
        { field: "email", value: "sales@shop-one.test", url: "https://www.shop-one.test/contact" },
        { field: "email", value: "hello@shop-one.test", url: "https://www.shop-one.test/" },
        { field: "instagram", value: "https://instagram.com/shopone" },
      ],
    });
    expect(cleaned[0]!.email_mx).toBeUndefined();
    expect(cleaned[1]).toMatchObject({
      address: "Cawangan KL, 5 Jalan Dua, 50000 KL",
      emails: [],
      email_types: [],
      email_source_url: "",
      email_status: "not_on_site",
      sources: [{ field: "facebook", value: "https://facebook.com/shoptwo" }],
    });
    expect(cleaned[2]).toMatchObject({
      address: "中山路 12 号",
      emails: ["hi@legacy.test"],
      email_types: ["generic"],
      email_source_url: "https://legacy.test/",
    });
    expect(cleaned[2]!.sources).toBeUndefined();
    expect(cleaned[2]!.email_mx).toBeUndefined();

    // Files on disk stay byte-identical.
    expect(readFileSync(jobFile)).toEqual(jobBefore);
    expect(readFileSync(leadsFile)).toEqual(leadsBefore);
  });

  it("cleans batch-saved rows on cancelled jobs and rows updated in place without rewriting untouched rows", () => {
    const store = new JobStore(dir);
    const job = store.create(OPTIONS);
    store.update(job.id, { status: "cancelled" });
    const row0: Lead = {
      ...lead(1),
      title: "Batch One",
      address: "Batch One, 1 Jalan Satu",
      emails: ["you@company.com"],
      email_status: "not_checked",
      website_status: "not_checked",
    };
    const row1: Lead = {
      ...lead(2),
      title: "Batch Two",
      address: "Batch Two, 2 Jalan Dua",
      emails: [],
      email_status: "not_checked",
      website_status: "not_checked",
    };
    store.appendLeads(job.id, [row0, row1]);

    // Replacing row 1 in place must not rewrite row 0 on disk.
    store.replaceLeads(
      job.id,
      new Map([[1, { ...row1, emails: ["you@company.com", "ok@batch2.test"], email_status: "found", website_status: "found" }]]),
    );

    const rawLines = readFileSync(path.join(dir, job.id, "leads.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(rawLines[0]!) as Lead).toEqual(row0);

    const cleaned = store.readLeads(job.id);
    expect(cleaned[0]).toMatchObject({ address: "1 Jalan Satu", emails: [], email_status: "not_checked" });
    expect(cleaned[1]).toMatchObject({ address: "2 Jalan Dua", emails: ["ok@batch2.test"], email_status: "found" });
  });
});

describe("migrateDataDir", () => {
  function seedLegacy(base: string) {
    const oldDir = path.join(base, "leadscout");
    const store = new JobStore(path.join(oldDir, "jobs"));
    const job = store.create(OPTIONS);
    store.appendLeads(job.id, [lead(1)]);
    store.update(job.id, { status: "done" });
    writeFileSync(path.join(oldDir, "geocode-cache.json"), '{"version":2,"entries":{}}');
    writeFileSync(path.join(oldDir, "extra.txt"), "keep me");
    return { oldDir, newDir: path.join(base, "business-finder"), jobId: job.id };
  }

  it("moves only-old to business-finder, keeping jobs, geocode cache, and everything else", async () => {
    const base = path.join(dir, "only-old");
    const { oldDir, newDir, jobId } = seedLegacy(base);
    const env = { LOCALAPPDATA: base, XDG_DATA_HOME: base };

    const res = await migrateDataDir({ env });
    expect(res).toEqual({ outcome: "migrated", from: oldDir, to: newDir });
    expect(existsSync(oldDir)).toBe(false);
    expect(new JobStore(path.join(newDir, "jobs")).readLeads(jobId).map((l) => l.title)).toEqual(["ZZMARK-1"]);
    expect(readFileSync(path.join(newDir, "geocode-cache.json"), "utf8")).toBe('{"version":2,"entries":{}}');
    expect(readFileSync(path.join(newDir, "extra.txt"), "utf8")).toBe("keep me");
  });

  it("uses the new folder when both exist, says once that the old folder was left alone, and never deletes old", async () => {
    const base = path.join(dir, "both");
    const { oldDir, newDir, jobId: oldJobId } = seedLegacy(base);
    const newStore = new JobStore(path.join(newDir, "jobs"));
    const newJob = newStore.create({ ...OPTIONS, city: "Ipoh" });
    const env = { LOCALAPPDATA: base, XDG_DATA_HOME: base };

    const first = await migrateDataDir({ env });
    expect(first.outcome).toBe("both_kept_new");
    expect(first).toHaveProperty("message");
    if (first.outcome === "both_kept_new") {
      expect(first.message).toContain("leaving the old folder alone");
    }

    // Second run uses the new folder without repeating the notice.
    const second = await migrateDataDir({ env });
    expect(second).toEqual({ outcome: "both_kept_new", oldDir, newDir });

    // Old folder and its jobs were never deleted; new folder is intact.
    expect(existsSync(oldDir)).toBe(true);
    expect(new JobStore(path.join(oldDir, "jobs")).get(oldJobId)).not.toBeNull();
    expect(new JobStore(path.join(newDir, "jobs")).get(newJob.id)).not.toBeNull();
  });

  it("is a no-op when only the new folder exists", async () => {
    const base = path.join(dir, "only-new");
    const newDir = path.join(base, "business-finder");
    const store = new JobStore(path.join(newDir, "jobs"));
    const job = store.create(OPTIONS);
    const env = { LOCALAPPDATA: base, XDG_DATA_HOME: base };

    expect(await migrateDataDir({ env })).toEqual({ outcome: "only_new" });
    expect(new JobStore(path.join(newDir, "jobs")).get(job.id)).not.toBeNull();
  });

  it("never leaves lists in neither place if a single-step rename fails or an EXDEV staging copy is interrupted", async () => {
    const base = path.join(dir, "interrupted");
    const { oldDir, newDir, jobId } = seedLegacy(base);
    const env = { LOCALAPPDATA: base, XDG_DATA_HOME: base };

    // Case 1: rename fails directly — old folder remains intact, new folder does not exist.
    await expect(
      migrateDataDir({
        env,
        fs: {
          ...fs,
          renameSync: () => {
            throw Object.assign(new Error("simulated crash"), { code: "EIO" });
          },
        },
      }),
    ).rejects.toThrow(/simulated crash/);
    expect(existsSync(newDir)).toBe(false);
    expect(new JobStore(path.join(oldDir, "jobs")).readLeads(jobId).map((l) => l.title)).toEqual(["ZZMARK-1"]);

    // Case 2: cross-device fallback (EXDEV) interrupted halfway through copy — old stays intact, staging is cleaned up.
    let copies = 0;
    await expect(
      migrateDataDir({
        env,
        fs: {
          ...fs,
          renameSync: () => {
            throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
          },
          copyFileSync: (src, dst) => {
            copies += 1;
            if (copies >= 2) throw new Error("power loss mid-copy");
            fs.copyFileSync(src, dst);
          },
        },
      }),
    ).rejects.toThrow(/power loss/);
    expect(existsSync(newDir)).toBe(false);
    expect(readdirSync(base).filter((n) => n.includes(".migrating-"))).toEqual([]);
    expect(new JobStore(path.join(oldDir, "jobs")).readLeads(jobId).map((l) => l.title)).toEqual(["ZZMARK-1"]);
  });

  it("does not move when old server.json names a live server with matching health check", async () => {
    const base = path.join(dir, "live-server");
    const { oldDir, newDir, jobId } = seedLegacy(base);
    const env = { LOCALAPPDATA: base, XDG_DATA_HOME: base };

    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      if (req.url === "/api/v1/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid: process.pid }));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    writeFileSync(path.join(oldDir, "server.json"), JSON.stringify({ pid: process.pid, port }));

    try {
      const res = await migrateDataDir({ env });
      expect(res).toEqual({
        outcome: "old_server_running",
        oldDir,
        newDir,
        message: "An older version is still running. Close it (or re-run the installer), then try again.",
      });
      expect(existsSync(oldDir)).toBe(true);
      expect(existsSync(newDir)).toBe(false);
      expect(new JobStore(path.join(oldDir, "jobs")).get(jobId)).not.toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("moves as before when old server.json has a dead PID or stale port", async () => {
    const base = path.join(dir, "stale-server");
    const { oldDir, newDir, jobId } = seedLegacy(base);
    writeFileSync(path.join(oldDir, "server.json"), JSON.stringify({ pid: 999_999, port: 1 }));
    const env = { LOCALAPPDATA: base, XDG_DATA_HOME: base };

    const res = await migrateDataDir({ env });
    expect(res).toEqual({ outcome: "migrated", from: oldDir, to: newDir });
    expect(existsSync(oldDir)).toBe(false);
    expect(new JobStore(path.join(newDir, "jobs")).get(jobId)).not.toBeNull();
  });

  it("leaves an installer-managed old folder (containing app/) to the installer without moving it", async () => {
    const base = path.join(dir, "app-present");
    const { oldDir, newDir, jobId } = seedLegacy(base);
    mkdirSync(path.join(oldDir, "app"), { recursive: true });
    writeFileSync(path.join(oldDir, "app", "package.json"), "{}");
    const env = { LOCALAPPDATA: base, XDG_DATA_HOME: base };

    const res = await migrateDataDir({ env });
    expect(res.outcome).toBe("installer_managed");
    if (res.outcome === "installer_managed") {
      expect(res.message).toContain("re-run the installer");
    }
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(newDir)).toBe(false);
    expect(new JobStore(path.join(oldDir, "jobs")).get(jobId)).not.toBeNull();
  });
});
