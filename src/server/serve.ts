// Starts the local server: the job API plus the web UI's static files, on
// 127.0.0.1 only, moving to the next free port when the asked one is taken.

import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { checkWebsites } from "../core/enrich/isolated.js";
import { DataDirWriteError, formatWriteError, isFsError } from "../core/errors.js";
import { createGeocoder, GEOCODE_CACHE_FILE } from "../core/geo/geocoder.js";
import { runScrape, type RunDeps } from "../core/pipeline.js";
import { browserSource } from "../core/sources/browser/index.js";
import { loadFixtureDeps } from "../core/sources/fixture-file.js";
import { defaultDataDir, defaultJobsDir, ensureWritableDir, JobStore, migrateDataDir, MigrationBlockedError } from "../jobs/store.js";
import type { Runner } from "../jobs/worker.js";
import { createApp } from "./app.js";

export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 8080;

/** The built web UI (`bun run build:web`), found relative to this source file. */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const WEB_DIST_DIR = path.basename(moduleDir) === "dist"
  ? path.join(moduleDir, "web")
  : path.resolve(moduleDir, "..", "..", "web", "dist");

const NOT_BUILT_PAGE =
  "The Business Finder web UI has not been built yet. Run `bun run build:web` in the business-finder folder, then reload this page.\n";

/** How many ports above the asked one are tried before giving up. */
const PORT_ATTEMPTS = 100;

export type ServerOptions = {
  /** First port to try; the next free one is used when it is taken. Default 8080. */
  port?: number;
  /** Open the UI in the default browser once listening. */
  open: boolean;
  /** Folder holding the built web UI (`index.html` and assets). Default: `web/dist`. */
  staticDir?: string;
  /** Where job folders live. Default: the per-user data folder. */
  jobsDir?: string;
  /** Where Nominatim's answers are kept between runs. Default: `geocode-cache.json` in the per-user data folder. */
  geocodeCacheFile?: string;
  /** `browser` (default) scrapes Google Maps; `fixture` replays `fixtureFile`. */
  source?: "browser" | "fixture";
  /** The fixture JSON file, required when `source` is `fixture`. */
  fixtureFile?: string;
  /** Opens a URL in the default browser; replaceable in tests. */
  openUrl?: (url: string) => Promise<void>;
};

export type RunningServer = { url: string; port: number; address: string; close(): Promise<void> };

export type PortState = "free" | "in_use" | "reserved";

/** EADDRINUSE: another program listens there. EACCES: on Windows, an excluded (reserved) port. */
function takenAs(e: NodeJS.ErrnoException): PortState | undefined {
  return e.code === "EADDRINUSE" ? "in_use" : e.code === "EACCES" ? "reserved" : undefined;
}

function listenOnce(port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", (e: NodeJS.ErrnoException) => (takenAs(e) ? resolve(null) : reject(e)));
    probe.listen(port, HOST, () => {
      const { port: bound } = probe.address() as AddressInfo;
      probe.close(() => resolve(bound));
    });
  });
}

/** Whether 127.0.0.1 can listen on `port` right now, and if not, why. */
export function probePort(port: number): Promise<PortState> {
  checkPort(port);
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", (e: NodeJS.ErrnoException) => {
      const state = takenAs(e);
      if (state) resolve(state);
      else reject(e);
    });
    probe.listen(port, HOST, () => probe.close(() => resolve("free")));
  });
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Port must be 0 to 65535, got ${port}.`);
}

/** The first port at or above `start` that 127.0.0.1 can listen on. */
export async function findFreePort(start: number): Promise<number> {
  checkPort(start);
  const last = Math.min(65_535, start + PORT_ATTEMPTS);
  for (let port = start; port <= last; port++) {
    const bound = await listenOnce(port);
    if (bound !== null) return bound;
    if (start === 0) break;
  }
  throw new Error(`No free port between ${start} and ${last}.`);
}

/** Opens `url` with the platform's default handler and does not wait for the browser. */
export function openInBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args as string[], { detached: true, stdio: "ignore", windowsVerbatimArguments: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function makeRunner(opts: ServerOptions): Promise<Runner> {
  let deps: Omit<RunDeps, "now">;
  if (opts.source === "fixture") {
    if (!opts.fixtureFile) throw new Error("The fixture source needs a fixture file.");
    // Loaded now so a bad fixture file stops the server at startup.
    deps = await loadFixtureDeps(opts.fixtureFile);
  } else {
    const cacheFile = opts.geocodeCacheFile ?? path.join(defaultDataDir(), GEOCODE_CACHE_FILE);
    deps = { source: browserSource(), geocode: createGeocoder({ cacheFile }), enrich: checkWebsites };
  }
  return (options, onProgress, signal, rows) => runScrape(options, { ...deps, now: () => new Date() }, onProgress, signal, rows);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const start = opts.port ?? DEFAULT_PORT;
  checkPort(start);
  if (!opts.jobsDir) {
    const migration = await migrateDataDir();
    if (migration.outcome === "old_server_running" || migration.outcome === "installer_managed") {
      throw new MigrationBlockedError(migration.message);
    }
    if (migration.outcome === "both_kept_new" && migration.message) {
      console.warn(migration.message);
    }
  }
  const runner = await makeRunner(opts);
  if (!opts.jobsDir) {
    ensureWritableDir(defaultDataDir());
  }
  const jobsDir = opts.jobsDir ?? defaultJobsDir();
  let store: JobStore;
  try {
    ensureWritableDir(jobsDir);
    store = new JobStore(jobsDir);
  } catch (e) {
    if (e instanceof DataDirWriteError) throw e;
    if (isFsError(e)) throw new DataDirWriteError(formatWriteError(jobsDir, e));
    throw e;
  }
  const app = createApp({ store, runner });
  const staticDir = path.resolve(opts.staticDir ?? WEB_DIST_DIR);
  app.use("/*", serveStatic({ root: staticDir }));
  // Without a built page every path would be a bare 404; say how to fix it instead.
  app.get("*", (c) =>
    existsSync(path.join(staticDir, "index.html"))
      ? c.text("Not found.\n", 404)
      : c.text(NOT_BUILT_PAGE, 503, { "Cache-Control": "no-store" }),
  );

  const server = createAdaptorServer({ fetch: app.fetch });
  const last = Math.min(65_535, start + PORT_ATTEMPTS);
  let port: number | null = null;
  // Listen directly instead of probing first, so another program cannot take
  // the port between the check and the listen.
  for (let candidate = start; candidate <= last && port === null; candidate++) {
    port = await new Promise<number | null>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (takenAs(e)) resolve(null);
        else reject(e);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidate, HOST);
    });
    if (start === 0) break;
  }
  if (port === null) throw new Error(`No free port between ${start} and ${last}.`);

  const url = `http://${HOST}:${port}`;
  // Closing an already stopped server counts as success: Bun stops the
  // listener inside closeAllConnections(), and a second close() is harmless.
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((e) => (!e || (e as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING" ? resolve() : reject(e)));
      if ("closeAllConnections" in server) server.closeAllConnections();
    });

  if (opts.open) {
    try {
      await (opts.openUrl ?? openInBrowser)(url);
    } catch {
      // The server is up either way; the caller prints the URL to open by hand.
    }
  }
  return { url, port, address: (server.address() as AddressInfo).address, close };
}
