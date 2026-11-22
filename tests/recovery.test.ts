import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunOptions } from "../src/core/types.js";
import { JobStore, processAlive } from "../src/jobs/store.js";
import { INTERRUPTED_MESSAGE, JobWorker, type Runner } from "../src/jobs/worker.js";

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

const NEVER: Runner = () => new Promise(() => {});

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid!;
}

let dir: string;
let store: JobStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-recovery-"));
  store = new JobStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("processAlive", () => {
  it("is true for this process and false for one that has exited", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(deadPid())).toBe(false);
  });

  it("treats a process it may not signal as alive", () => {
    const eperm = () => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    expect(processAlive(1234, eperm)).toBe(true);
  });

  it("is false for a pid that cannot be a process", () => {
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-5)).toBe(false);
    expect(processAlive(1.5)).toBe(false);
  });
});

describe("JobWorker startup recovery", () => {
  it("leaves a running job alone while the CLI process that owns it is alive", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
      const job = store.create(OPTIONS, { owner: { kind: "cli", pid: child.pid! } });
      store.update(job.id, { status: "running" });

      new JobWorker(store, NEVER);

      const after = store.get(job.id)!;
      expect(after.status).toBe("running");
      expect(after.error).toBeUndefined();
    } finally {
      child.kill();
    }
  });

  it("fails a running job whose owner process has gone, with the existing message", () => {
    const job = store.create(OPTIONS, { owner: { kind: "cli", pid: deadPid() } });
    store.update(job.id, { status: "running" });

    new JobWorker(store, NEVER);

    expect(INTERRUPTED_MESSAGE).toBe(
      "This search was interrupted because Business Finder was closed or restarted. Nothing is lost; try again to finish it.",
    );
    expect(store.get(job.id)).toMatchObject({ status: "failed", error: INTERRUPTED_MESSAGE });
  });

  it("fails a queued job left by a server that has stopped", () => {
    const job = store.create(OPTIONS, { owner: { kind: "server", pid: deadPid() } });

    new JobWorker(store, NEVER);

    expect(INTERRUPTED_MESSAGE).toBe(
      "This search was interrupted because Business Finder was closed or restarted. Nothing is lost; try again to finish it.",
    );
    expect(store.get(job.id)).toMatchObject({ status: "failed", error: INTERRUPTED_MESSAGE });
  });

  it("fails a running job written before jobs recorded an owner", () => {
    const job = store.create(OPTIONS);
    store.update(job.id, { status: "running" });
    expect(store.get(job.id)!.owner).toBeUndefined();

    new JobWorker(store, NEVER);

    expect(INTERRUPTED_MESSAGE).toBe(
      "This search was interrupted because Business Finder was closed or restarted. Nothing is lost; try again to finish it.",
    );
    expect(store.get(job.id)).toMatchObject({ status: "failed", error: INTERRUPTED_MESSAGE });
  });

  it("does not touch finished jobs", () => {
    const job = store.create(OPTIONS, { owner: { kind: "cli", pid: deadPid() } });
    store.update(job.id, { status: "done" });

    new JobWorker(store, NEVER);

    expect(store.get(job.id)!.status).toBe("done");
  });

  it("records the server as the owner of a job it takes", () => {
    const worker = new JobWorker(store, NEVER);
    const job = store.create(OPTIONS);
    worker.enqueue(job.id);
    expect(store.get(job.id)!.owner).toEqual({ kind: "server", pid: process.pid });
  });
});

describe("JobWorker startup recovery of a held list", () => {
  it("puts back a finished list whose adding process has gone, instead of failing it", () => {
    const job = store.create(OPTIONS);
    store.update(job.id, { status: "done", progress: { stage: "done", places: 2, message: "Found 2 leads in Melaka." } });
    store.hold(job.id, { kind: "cli", pid: deadPid() }, { stage: "searching", places: 0, message: "Adding places…" });
    new JobWorker(store, NEVER);
    const after = store.get(job.id)!;
    expect(after).toMatchObject({ status: "done", progress: { message: "Found 2 leads in Melaka." } });
    expect(after.error).toBeUndefined();
    expect(after.held).toBeUndefined();
  });

  it("leaves a list held by a live process alone", () => {
    const job = store.create(OPTIONS);
    store.update(job.id, { status: "done" });
    store.hold(job.id, { kind: "cli", pid: process.pid }, { stage: "searching", places: 0, message: "Adding places…" });
    new JobWorker(store, NEVER);
    expect(store.get(job.id)?.status).toBe("running");
  });
});
