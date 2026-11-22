import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm as rmReal } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CancelledError } from "../src/core/errors.js";
import { chooseHit } from "../src/core/geo/geocode.js";
import { runScrape } from "../src/core/pipeline.js";
import {
  browserArgs,
  chromeUserAgent,
  findBrowser,
  launchBrowser,
  parseDevToolsActivePort,
  type LaunchDeps,
} from "../src/core/sources/browser/launch.js";
import type { PlaceSource } from "../src/core/sources/source.js";
import { JobStore } from "../src/jobs/store.js";
import { JobWorker } from "../src/jobs/worker.js";
import { hit, MELAKA_CITY, MELAKA_STATE } from "./fixtures/nominatim.js";
import { run20Enrich, run20Source } from "./fixtures/run20.js";

const winEnv = {
  PROGRAMFILES: "C:\\Program Files",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
};

describe("findBrowser", () => {
  it("finds Edge on Windows when Chrome is absent", () => {
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const result = findBrowser(winEnv, (p) => p === edge, "win32");
    expect(result).toEqual({ path: edge });
  });

  it("prefers Chrome over Edge, Brave and Chromium", () => {
    const result = findBrowser(winEnv, (p) => /chrome\.exe$|msedge\.exe$|brave\.exe$/.test(p), "win32");
    expect(result).toEqual({ path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" });
  });

  it("looks under LOCALAPPDATA for per-user installs", () => {
    const chrome = "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
    expect(findBrowser(winEnv, (p) => p === chrome, "win32")).toEqual({ path: chrome });
  });

  it("reads Windows environment variables case-insensitively", () => {
    const env = { ProgramFiles: "D:\\Apps" };
    const chrome = "D:\\Apps\\Google\\Chrome\\Application\\chrome.exe";
    expect(findBrowser(env, (p) => p === chrome, "win32")).toEqual({ path: chrome });
  });

  it("uses BUSINESS_FINDER_CHROME before any installed browser", () => {
    const custom = "C:\\Tools\\chromium\\chrome.exe";
    const result = findBrowser({ ...winEnv, BUSINESS_FINDER_CHROME: custom }, () => true, "win32");
    expect(result).toEqual({ path: custom });
  });

  it("reports a BUSINESS_FINDER_CHROME that does not exist instead of silently using another browser", () => {
    const custom = "C:\\Tools\\missing.exe";
    const result = findBrowser({ ...winEnv, BUSINESS_FINDER_CHROME: custom }, (p) => p !== custom, "win32");
    expect(result).toMatchObject({ searched: [custom] });
    expect("error" in result && result.error).toMatch(/BUSINESS_FINDER_CHROME/);
  });

  it("returns every searched path and a plain-words error when no browser is installed", () => {
    const result = findBrowser(winEnv, () => false, "win32");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/Chrome/);
    expect(result.error).toMatch(/Edge/);
    expect(result.error).toMatch(/BUSINESS_FINDER_CHROME/);
    expect(result.searched.length).toBeGreaterThanOrEqual(4);
    expect(result.searched.some((p) => p.includes("Program Files (x86)"))).toBe(true);
    expect(result.searched.some((p) => p.startsWith(winEnv.LOCALAPPDATA))).toBe(true);
  });

  it("searches the standard locations on macOS and Linux", () => {
    const mac = findBrowser({ HOME: "/Users/test" }, () => false, "darwin");
    const linux = findBrowser({}, () => false, "linux");
    expect("searched" in mac && mac.searched).toContain("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    expect("searched" in linux && linux.searched).toContain("/usr/bin/chromium");
    expect(findBrowser({}, (p) => p === "/usr/bin/brave-browser", "linux")).toEqual({ path: "/usr/bin/brave-browser" });
  });
});

describe("chromeUserAgent", () => {
  it("replaces HeadlessChrome with Chrome", () => {
    const ua = chromeUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
    );
    expect(ua).toContain("Chrome/131.0");
    expect(ua).not.toContain("Headless");
  });

  it("leaves a regular user agent unchanged", () => {
    const ua = "Mozilla/5.0 AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
    expect(chromeUserAgent(ua)).toBe(ua);
  });
});

describe("browserArgs", () => {
  it("uses a loopback DevTools port, the private profile and the reference flags", () => {
    expect(browserArgs("/tmp/profile", true)).toEqual([
      "--remote-debugging-port=0",
      "--user-data-dir=/tmp/profile",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--mute-audio",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,900",
      "--headless=new",
    ]);
  });

  it("omits --headless when a visible window is requested", () => {
    expect(browserArgs("/tmp/profile", false)).not.toContain("--headless=new");
  });
});

describe("launchBrowser", () => {
  it.each([
    ["a missing executable", path.join(tmpdir(), "business-finder-no-such-browser.exe")],
    ["an empty path", ""],
  ])("rejects for %s and leaves no profile folder behind", async (_label, browserPath) => {
    // Track this launch's own folder: a listing of the temp folder also sees
    // profiles of any other Business Finder process running at the same time.
    const removed: string[] = [];
    const rm = (async (p: string, o: Parameters<typeof rmReal>[1]) => {
      removed.push(p);
      return rmReal(p, o);
    }) as LaunchDeps["rm"];
    await expect(launchBrowser(browserPath, { headless: true }, { rm })).rejects.toThrow(/could not start/);
    expect(removed).toHaveLength(1);
    expect(path.basename(removed[0]!)).toMatch(/^business-finder-profile-/);
    expect(existsSync(removed[0]!)).toBe(false);
  });
});

describe("parseDevToolsActivePort", () => {
  it("builds the browser WebSocket URL from port and path", () => {
    expect(parseDevToolsActivePort("54321\n/devtools/browser/abc-123\n")).toBe(
      "ws://127.0.0.1:54321/devtools/browser/abc-123",
    );
  });

  it("returns null while the file is incomplete", () => {
    expect(parseDevToolsActivePort("")).toBeNull();
    expect(parseDevToolsActivePort("54321")).toBeNull();
    expect(parseDevToolsActivePort("0\n/devtools/browser/x")).toBeNull();
  });
});

/**
 * A stand-in for the browser process: it writes DevToolsActivePort into the
 * profile it was given, as Chromium does, and exits when killed.
 */
const fakeSpawn = ((_file: string, args: readonly string[]) => {
  const profile = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
  writeFileSync(path.join(profile, "DevToolsActivePort"), "54321\n/devtools/browser/fake\n");
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    kill: () => {
      setImmediate(() => child.emit("exit", 0, null));
      return true;
    },
  });
  return child;
}) as unknown as typeof spawn;

/** An `rm` that always fails the way Windows does while Chromium still holds a file. */
const busyRm = (async (p: string) => {
  throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${p}'`), { code: "EBUSY" });
}) as LaunchDeps["rm"];

describe("launchBrowser profile cleanup", () => {
  const leftovers: string[] = [];
  const realRmThenBusy = (async (p: string) => {
    leftovers.push(p);
    return busyRm!(p);
  }) as LaunchDeps["rm"];
  afterEach(() => {
    for (const p of leftovers.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  it("closes without an error when the profile folder stays locked, and warns without the temp path", async () => {
    const warnings: string[] = [];
    const browser = await launchBrowser("fake-chrome", { headless: true }, { spawn: fakeSpawn, rm: realRmThenBusy, warn: (m) => warnings.push(m) });
    expect(browser.wsUrl).toBe("ws://127.0.0.1:54321/devtools/browser/fake");
    await expect(browser.close()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/EBUSY/);
    expect(warnings[0]).not.toMatch(/business-finder-profile-/);
    expect(warnings[0]).not.toContain(tmpdir());
  });

  it("reports the startup error, not the cleanup error, when the browser cannot start", async () => {
    const throwingSpawn = (() => {
      throw new Error("spawn EINVAL");
    }) as unknown as typeof spawn;
    const run = launchBrowser("fake-chrome", { headless: true }, { spawn: throwingSpawn, rm: realRmThenBusy, warn: () => {} });
    await expect(run).rejects.toThrow(/could not start fake-chrome: spawn EINVAL/);
    await expect(run).rejects.not.toThrow(/EBUSY|business-finder-profile-/);
  });
});

describe("launchBrowser cancellation", () => {
  /** A browser that never opens its DevTools port, as during a slow start-up. */
  function slowSpawn(killed: string[]) {
    return ((_file: string, _args: readonly string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        kill: (sig?: string) => {
          killed.push(sig ?? "SIGTERM");
          setImmediate(() => child.emit("exit", 0, null));
          return true;
        },
      });
      return child;
    }) as unknown as typeof spawn;
  }
  const trackRm = (removed: string[]) =>
    (async (p: string, o: Parameters<typeof rmReal>[1]) => {
      removed.push(p);
      return rmReal(p, o);
    }) as LaunchDeps["rm"];

  it("stops waiting for start-up, closes the browser and rejects with CancelledError when the signal aborts", async () => {
    const killed: string[] = [];
    const removed: string[] = [];
    const abort = new AbortController();
    const run = launchBrowser("fake-chrome", { headless: true, signal: abort.signal }, { spawn: slowSpawn(killed), rm: trackRm(removed) });
    setTimeout(() => abort.abort(), 30);
    const started = performance.now();
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    // The start-up wait allows 20 s; a cancel must not sit it out.
    expect(performance.now() - started).toBeLessThan(500);
    expect(killed).toEqual(["SIGTERM"]);
    expect(removed).toHaveLength(1);
    expect(existsSync(removed[0]!)).toBe(false);
  });

  it("does not start the browser when the signal is already aborted", async () => {
    const killed: string[] = [];
    let spawned = 0;
    const spawnCount = ((file: string, args: readonly string[]) => {
      spawned++;
      return slowSpawn(killed)(file, args);
    }) as unknown as typeof spawn;
    const removed: string[] = [];
    const abort = new AbortController();
    abort.abort();
    await expect(
      launchBrowser("fake-chrome", { headless: true, signal: abort.signal }, { spawn: spawnCount, rm: trackRm(removed) }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(spawned).toBe(0);
    expect(removed.every((p) => !existsSync(p))).toBe(true);
  });
});

describe("a job whose browser profile cannot be deleted", () => {
  let dir: string;
  const profiles: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "business-finder-jobs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const p of profiles.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  it("still ends done with its rows", async () => {
    const rm = (async (p: string) => {
      profiles.push(p);
      return busyRm!(p);
    }) as LaunchDeps["rm"];
    // Same shape as browserSource: launch, read the places, close in `finally`.
    const source: PlaceSource = {
      async search(q, onProgress) {
        const browser = await launchBrowser("fake-chrome", { headless: true }, { spawn: fakeSpawn, rm, warn: () => {} });
        try {
          return await run20Source().search(q, onProgress);
        } finally {
          await browser.close();
        }
      },
    };
    const store = new JobStore(dir);
    const worker = new JobWorker(store, (opts, onProgress) =>
      runScrape(
        opts,
        { source, geocode: async () => chooseHit([hit(MELAKA_STATE), hit(MELAKA_CITY)]), enrich: run20Enrich, now: () => new Date() },
        onProgress,
      ),
    );
    const job = store.create({ keyword: "souvenir shop", city: "Melaka", depth: 1, lang: "en", emails: true, socials: true, deep: false, maxSeconds: 600 });
    worker.enqueue(job.id);
    await worker.idle();

    const done = store.get(job.id)!;
    expect(profiles).toHaveLength(1);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe("done");
    expect(store.readLeads(job.id)).toHaveLength(19);
  });
});
