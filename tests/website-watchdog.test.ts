// A website check that never ends must not stop the run. These runs go
// through the fixture file, so the checks run in the same child process a
// live run uses, with one site that either spins the CPU forever (it starves
// the child's event loop, so no timeout in the child can fire) or never
// answers.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import type { DebugFields } from "../src/core/debugLog.js";
import { CancelledError } from "../src/core/errors.js";
import { runScrape, type ScrapeProgress } from "../src/core/pipeline.js";
import { loadFixtureDeps } from "../src/core/sources/fixture-file.js";
import type { RunOptions } from "../src/core/types.js";
import { RUN20_BATCH, RUN20_SITES_DIR } from "./fixtures/run20.js";

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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-watchdog-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(extra: Record<string, unknown>): string {
  const file = path.join(dir, "run20.json");
  writeFileSync(
    file,
    JSON.stringify({ geocode: { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" }, batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR, ...extra }),
  );
  return file;
}

type Logged = { event: string; fields: DebugFields };

function recorder() {
  const events: Logged[] = [];
  return { events, debug: (event: string, fields: DebugFields = {}) => void events.push({ event, fields }) };
}

/** The pid of every check process the run started, from its debug log. */
const childPids = (events: Logged[]) => events.filter((e) => e.event === "checks_child_start").map((e) => Number(e.fields.pid));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const notChecked = (leads: { website_status: string }[]) => leads.filter((l) => l.website_status === "not_checked").length;

/** How many check processes were stopped because they stopped making progress. */
const stalls = (events: Logged[]) => events.filter((e) => e.event === "checks_child_exit" && e.fields.ending === "stalled").length;

/** The website status of the row whose website is on `host`. */
const statusOf = (leads: { website?: string; website_status: string }[], host: string) =>
  leads.find((l) => (l.website ?? "").includes(host))?.website_status;

/**
 * Runs `body` with the check processes writing their debug log to a file,
 * and returns the hosts in the order their first page started.
 */
async function withChildLog<T>(body: () => Promise<T>): Promise<{ result: T; pageOrder: string[] }> {
  const file = path.join(dir, "checks.log");
  const before = process.env.BUSINESS_FINDER_DEBUG_LOG;
  process.env.BUSINESS_FINDER_DEBUG_LOG = file;
  try {
    const result = await body();
    const order: string[] = [];
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    for (const line of text.split(/\r?\n/)) {
      const host = / page_start host=(\S+)/.exec(line)?.[1];
      if (host && !order.includes(host)) order.push(host);
    }
    return { result, pageOrder: order };
  } finally {
    if (before === undefined) delete process.env.BUSINESS_FINDER_DEBUG_LOG;
    else process.env.BUSINESS_FINDER_DEBUG_LOG = before;
  }
}

describe("website checks that never finish", () => {
  it("stops a check whose page spins the CPU, keeps every row and marks that one not checked", async () => {
    const deps = await loadFixtureDeps(fixture({ stuckSites: { "shop-3.test": "busy" }, checkStallMs: 5000 }));
    const log = recorder();
    const seen: ScrapeProgress[] = [];
    const started = performance.now();
    const result = await runScrape(OPTS, { ...deps, now: () => new Date(), debug: log.debug }, (p) => seen.push(p));
    const seconds = (performance.now() - started) / 1000;

    // The stall limit counts from before the check process starts, so it must outlast a cold start on a busy machine.
    expect(seconds).toBeLessThan(25);
    expect(result.leads).toHaveLength(19);
    expect(notChecked(result.leads)).toBe(1);
    expect(result.reconciliation).toMatchObject({ toCheck: 10, fetched: 9, notChecked: 1 });
    expect(seen.some((p) => p.stage === "checking_websites" && p.notChecked === 1 && /1 website didn't answer in time and was skipped/.test(p.message))).toBe(true);
    expect(seen.at(-1)?.stage).toBe("done");
    expect(statusOf(result.leads, "shop-3.test")).toBe("not_checked");
    expect(stalls(log.events)).toBe(1);
    expect(childPids(log.events).every((pid) => !alive(pid))).toBe(true);
    expect(log.events.some((e) => e.event === "checks_stopped" && e.fields.reason === "stalled")).toBe(true);
  }, 40_000);

  it("does not blame a website whose page started after the one that froze while being read", async () => {
    // shop-5 answers after half a second, so its page is still open when shop-3's page freezes the check process.
    const deps = await loadFixtureDeps(fixture({ stuckSites: { "shop-3.test": "busy", "shop-5.test": "slow" }, checkStallMs: 5000 }));
    const log = recorder();
    const { result, pageOrder } = await withChildLog(() => runScrape(OPTS, { ...deps, now: () => new Date(), debug: log.debug }, () => {}));

    expect(pageOrder.indexOf("shop-5.test")).toBeGreaterThan(pageOrder.indexOf("shop-3.test"));
    expect(result.leads).toHaveLength(19);
    expect(statusOf(result.leads, "shop-3.test")).toBe("not_checked");
    expect(statusOf(result.leads, "shop-5.test")).toBe("found");
    expect(result.reconciliation).toMatchObject({ toCheck: 10, fetched: 9, notChecked: 1 });
    expect(stalls(log.events)).toBe(1);
    expect(childPids(log.events).every((pid) => !alive(pid))).toBe(true);
  }, 40_000);

  it("gives up every open website when the freeze is not inside a page read, and stalls only once", async () => {
    // shop-3's fetch spins, so the last step logged may be shop-5's: neither can be cleared, and both are given up at once.
    const deps = await loadFixtureDeps(fixture({ stuckSites: { "shop-3.test": "busy_fetch", "shop-5.test": "slow" }, checkStallMs: 5000 }));
    const log = recorder();
    const { result, pageOrder } = await withChildLog(() => runScrape(OPTS, { ...deps, now: () => new Date(), debug: log.debug }, () => {}));

    expect(pageOrder.indexOf("shop-5.test")).toBeGreaterThan(pageOrder.indexOf("shop-3.test"));
    expect(result.leads).toHaveLength(19);
    expect(statusOf(result.leads, "shop-3.test")).toBe("not_checked");
    expect(statusOf(result.leads, "shop-5.test")).toBe("not_checked");
    expect(result.reconciliation).toMatchObject({ toCheck: 10, fetched: 8, notChecked: 2 });
    expect(stalls(log.events)).toBe(1);
    expect(childPids(log.events).every((pid) => !alive(pid))).toBe(true);
  }, 40_000);

  it("stops the checks at the phase deadline and keeps every row", async () => {
    // The site never answers and the stall watchdog is far away: only the deadline can end the run.
    const deps = await loadFixtureDeps(fixture({ stuckSites: { "shop-3.test": "silent" }, checkStallMs: 600_000, minCheckMs: 1500 }));
    const log = recorder();
    const started = performance.now();
    const result = await runScrape({ ...OPTS, maxSeconds: 3 }, { ...deps, now: () => new Date(), debug: log.debug }, () => {});
    const seconds = (performance.now() - started) / 1000;

    expect(seconds).toBeLessThan(10);
    expect(result.leads).toHaveLength(19);
    expect(notChecked(result.leads)).toBe(1);
    expect(result.reconciliation.notChecked).toBe(1);
    expect(log.events.some((e) => e.event === "checks_stopped" && e.fields.reason === "deadline")).toBe(true);
    expect(childPids(log.events).every((pid) => !alive(pid))).toBe(true);
  }, 40_000);

  it("cancels during the checks with CancelledError and leaves no check process running", async () => {
    const deps = await loadFixtureDeps(fixture({ stuckSites: { "shop-3.test": "silent" }, checkStallMs: 600_000 }));
    const log = recorder();
    const controller = new AbortController();
    const onProgress = (p: ScrapeProgress) => {
      if (p.stage === "checking_websites" && p.checked === 9) controller.abort();
    };
    const started = performance.now();
    await expect(runScrape(OPTS, { ...deps, now: () => new Date(), debug: log.debug }, onProgress, controller.signal)).rejects.toThrow(
      CancelledError,
    );
    expect((performance.now() - started) / 1000).toBeLessThan(15);
    const pids = childPids(log.events);
    expect(pids).toHaveLength(1);
    expect(alive(pids[0]!)).toBe(false);
  }, 40_000);
});

describe("business-finder scrape --no-save interrupted during the checks", () => {
  it("still writes the file with every row on Ctrl-C", async () => {
    const file = fixture({ stuckSites: { "shop-3.test": "silent" }, checkStallMs: 600_000 });
    const out: string[] = [];
    const err: string[] = [];
    const csv = path.join(dir, "out.csv");
    let interrupted = false;
    const code = await main(["scrape", "souvenir shop", "--city", "Melaka", "--source", "fixture", "--no-save", "--out", csv], {
      out: (line) => {
        out.push(line);
        if (!interrupted && line.includes("checking websites: 9/10")) {
          interrupted = true;
          // What Ctrl-C delivers to the process; emitted here so the test runner keeps running.
          setTimeout(() => process.emit("SIGINT"), 50);
        }
      },
      err: (line) => err.push(line),
      env: { ...process.env, BUSINESS_FINDER_FIXTURE: file, LOCALAPPDATA: path.join(dir, "data"), XDG_DATA_HOME: path.join(dir, "data") },
      cwd: dir,
      now: () => new Date(),
    });

    expect(interrupted).toBe(true);
    expect(code).toBe(1);
    expect(existsSync(csv)).toBe(true);
    const lines = readFileSync(csv, "utf8").trim().split(/\r?\n/);
    expect(lines).toHaveLength(1 + 19);
    expect(out.join("\n")).toMatch(/1 website was not checked/);
    expect(process.listenerCount("SIGINT")).toBe(0);
  }, 40_000);
});
