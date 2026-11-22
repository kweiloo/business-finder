// Finds an installed Chromium-based browser and launches it with a private,
// throwaway profile and a loopback-only DevTools port.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NO_DEBUG_LOG, type DebugLog } from "../../debugLog.js";
import { CancelledError, UserFacingError } from "../../errors.js";

type BrowserCandidates = { name: string; win: string; mac: string; linux: string[] };

// Lookup order after BUSINESS_FINDER_CHROME: Chrome, Edge, Brave, Chromium.
const BROWSERS: BrowserCandidates[] = [
  {
    name: "Google Chrome",
    win: "Google\\Chrome\\Application\\chrome.exe",
    mac: "Google Chrome.app/Contents/MacOS/Google Chrome",
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
  },
  {
    name: "Microsoft Edge",
    win: "Microsoft\\Edge\\Application\\msedge.exe",
    mac: "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    linux: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"],
  },
  {
    name: "Brave",
    win: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    mac: "Brave Browser.app/Contents/MacOS/Brave Browser",
    linux: ["/usr/bin/brave-browser", "/usr/bin/brave", "/opt/brave.com/brave/brave"],
  },
  {
    name: "Chromium",
    win: "Chromium\\Application\\chrome.exe",
    mac: "Chromium.app/Contents/MacOS/Chromium",
    linux: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
  },
];

const NOT_FOUND =
  "No Chromium-based browser found. Install Google Chrome, Microsoft Edge, Brave or Chromium, " +
  "or set BUSINESS_FINDER_CHROME to the full path of the browser's executable.";

/** Windows environment variable names are case-insensitive; a plain object is not. */
function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name]) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function candidatePaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const roots = [
      envVar(env, "PROGRAMFILES") ?? "C:\\Program Files",
      envVar(env, "PROGRAMFILES(X86)") ?? "C:\\Program Files (x86)",
      envVar(env, "LOCALAPPDATA"),
    ].filter((root): root is string => Boolean(root));
    return BROWSERS.flatMap((b) => roots.map((root) => path.win32.join(root, b.win)));
  }
  if (platform === "darwin") {
    const home = envVar(env, "HOME");
    const roots = ["/Applications", ...(home ? [path.posix.join(home, "Applications")] : [])];
    return BROWSERS.flatMap((b) => roots.map((root) => path.posix.join(root, b.mac)));
  }
  return BROWSERS.flatMap((b) => b.linux);
}

export function findBrowser(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  platform: NodeJS.Platform,
): { path: string } | { error: string; searched: string[] } {
  const override = envVar(env, "BUSINESS_FINDER_CHROME");
  if (override) {
    // An explicit choice that is wrong should be reported, not replaced by another browser.
    if (exists(override)) return { path: override };
    return { error: `BUSINESS_FINDER_CHROME is set to ${override}, but no file exists there.`, searched: [override] };
  }
  const searched = candidatePaths(env, platform);
  const found = searched.find((p) => exists(p));
  return found ? { path: found } : { error: NOT_FOUND, searched };
}

/** Google serves a reduced Maps page to "HeadlessChrome"; present as regular Chrome. */
export function chromeUserAgent(browserVersionUA: string): string {
  return browserVersionUA.replace(/HeadlessChrome/g, "Chrome");
}

export function browserArgs(profileDir: string, headless: boolean): string[] {
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--mute-audio",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,900",
    ...(headless ? ["--headless=new"] : []),
  ];
}

/**
 * Parses `<profile>/DevToolsActivePort` (line 1: port, line 2: browser target
 * path). Returns null while the browser has not finished writing it.
 */
export function parseDevToolsActivePort(text: string): string | null {
  const [portLine, pathLine] = text.split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!pathLine?.startsWith("/devtools/browser/")) return null;
  return `ws://127.0.0.1:${port}${pathLine.trim()}`;
}

const STARTUP_TIMEOUT_MS = 20_000;
const EXIT_GRACE_MS = 5_000;

/** Seams for tests; production uses the real process, file system and stderr. */
export type LaunchDeps = {
  spawn?: typeof spawn;
  rm?: typeof rm;
  warn?: (message: string) => void;
  /** Receives start-up and shut-down durations (no paths, no scraped values). */
  debug?: DebugLog;
};

/**
 * The profile folder is scratch space: failing to delete it must never fail a
 * search whose places were already read. Chromium's helper processes can hold
 * profile files open after the main process exits on Windows (EBUSY/EPERM), so
 * a failed delete is reported as a warning and the folder is left behind. The
 * warning names the error code only, never the temp path.
 */
export function profileRemover(
  profileDir: string,
  remove: typeof rm,
  warn: (message: string) => void,
): () => Promise<void> {
  return async () => {
    try {
      await remove(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name ?? "error";
      warn(`business-finder: could not delete the browser's temporary profile folder (${code}); it was left in the system temp folder.`);
    }
  };
}

/**
 * Starts the browser and waits until its DevTools port is open. Aborting
 * `opts.signal` during that wait closes the browser at once and rejects with
 * `CancelledError`; an already aborted signal starts nothing.
 */
export async function launchBrowser(
  browserPath: string,
  opts: { headless: boolean; signal?: AbortSignal },
  deps: LaunchDeps = {},
): Promise<{ wsUrl: string; close(): Promise<void> }> {
  if (opts.signal?.aborted) throw new CancelledError();
  const debug = deps.debug ?? NO_DEBUG_LOG;
  const since = (t: number) => Math.round(performance.now() - t);
  const launchStart = performance.now();
  const profileDir = await mkdtemp(path.join(tmpdir(), "business-finder-profile-"));
  const deleteProfile = profileRemover(profileDir, deps.rm ?? rm, deps.warn ?? ((m) => console.warn(m)));
  const removeProfile = async () => {
    const t = performance.now();
    await deleteProfile();
    debug("browser_profile_deleted", { ms: since(t) });
  };
  const start = deps.spawn ?? spawn;
  let child: ReturnType<typeof spawn>;
  try {
    child = start(browserPath, browserArgs(profileDir, opts.headless), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    // Invalid arguments throw synchronously instead of emitting "error".
    await removeProfile();
    throw new UserFacingError(`could not start ${browserPath}: ${(error as Error).message}`);
  }
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
  });

  let exited = false;
  let spawnError: Error | undefined;
  const exitedPromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", (error) => {
      spawnError = error;
      exited = true;
      resolve();
    });
  });

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (!exited) {
        const t = performance.now();
        child.kill();
        const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), EXIT_GRACE_MS));
        const forced = (await Promise.race([exitedPromise, timer])) === "timeout";
        if (forced) {
          child.kill("SIGKILL");
          await exitedPromise;
        }
        debug("browser_exited", { ms: since(t), forced });
      }
      // Never rejects: see profileRemover.
      await removeProfile();
    })());

  try {
    const wsUrl = await waitForDevToolsPort(
      profileDir,
      () => {
        if (spawnError) return `could not start ${browserPath}: ${spawnError.message}`;
        if (exited) return `${browserPath} exited during startup${stderrTail ? `: ${lastLine(stderrTail)}` : ""}`;
        return null;
      },
      opts.signal,
    );
    debug("browser_launched", { ms: since(launchStart) });
    return { wsUrl, close };
  } catch (error) {
    debug(error instanceof CancelledError ? "browser_launch_cancelled" : "browser_launch_failed", { ms: since(launchStart) });
    await close();
    throw error;
  }
}

async function waitForDevToolsPort(
  profileDir: string,
  failure: () => string | null,
  signal: AbortSignal | undefined,
): Promise<string> {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new CancelledError();
    const reason = failure();
    if (reason) throw new UserFacingError(reason);
    const text = await readFile(file, "utf8").catch(() => "");
    const wsUrl = parseDevToolsActivePort(text);
    if (wsUrl) return wsUrl;
    await pause(100, signal);
  }
  throw new UserFacingError(`The browser did not start within ${STARTUP_TIMEOUT_MS / 1000} s. Try again.`);
}

/** Waits `ms`, or less when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).at(-1) ?? "";
}
