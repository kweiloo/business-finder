#!/usr/bin/env node
// The `business-finder` command line. It prints progress, counts and file paths
// only, never a scraped value, so an AI agent running it keeps result text
// out of its context. Exit codes: 0 complete, 1 run failed, 2 setup problem.

import { existsSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AddInputError, addToList, readWebFile, type AddTarget } from "./add.js";
import { enrichLeads } from "../core/enrich/enrich.js";
import { checkWebsites } from "../core/enrich/isolated.js";
import {
  CancelledError,
  DataDirWriteError,
  formatWriteError,
  isFsError,
  plainOsReason,
  ReconciliationError,
  UserFacingError,
} from "../core/errors.js";
import { resolveColumns, toCsv, toJson, UnknownColumnError } from "../core/export/csv.js";
import { countSamePhone } from "../core/export/same-phone.js";
import { defaultOutPath, EXPORT_SUBFOLDER } from "../core/export/downloads.js";
import { defaultFileName } from "../core/export/filename.js";
import { createGeocoder, GEOCODE_CACHE_FILE } from "../core/geo/geocoder.js";
import { dedupeTerms, parseKeywords } from "../core/keywords.js";
import { BLOCKED_MESSAGE, runScrape, skippedWebsitesLine, type RunDeps, type ScrapeProgress } from "../core/pipeline.js";
import { MAX_WHOLE_CITY_LIMIT, SEARCH_SIZES, SINGLE_SEARCH_LIMIT, usesWholeCityGrid } from "../core/searchSize.js";
import { browserSource, BrowserNotFoundError } from "../core/sources/browser/index.js";
import { findBrowser } from "../core/sources/browser/launch.js";
import { FixtureFileError, loadFixtureDeps } from "../core/sources/fixture-file.js";
import type { Lead, RunOptions, RunResult } from "../core/types.js";
import {
  clearServerRecord,
  defaultDataDir,
  defaultJobsDir,
  ensureWritableDir,
  isJobId,
  JobStore,
  ListBusyError,
  migrateDataDir,
  MigrationBlockedError,
  processAlive,
  readServerRecord,
  writeServerRecord,
} from "../jobs/store.js";
import { listSummaries, readList } from "../jobs/combine.js";
import { categoriesForAgents } from "../jobs/filter.js";
import { NAMES_ONLY_WARNING, namesOnly } from "../jobs/dedupe.js";
import { groupOf } from "../jobs/lists.js";
import { runInto, runJob, type Runner } from "../jobs/worker.js";
import { DEFAULT_PORT, openInBrowser, probePort, startServer, WEB_DIST_DIR } from "../server/serve.js";
import { VERSION } from "../version.js";
import { askYesNo, uninstallBusinessFinder } from "./uninstall.js";

export { defaultFileName, slug } from "../core/export/filename.js";

export const USAGE = `Usage:
  business-finder      open the page (starts Business Finder if it is not running)
  business-finder serve [--port 8080] [--no-open]
  business-finder scrape "<keyword[,keyword2,...]>" --city "<place>" [options]
  business-finder add <file> (--title "<text>" | --into <list-id>) [options]
  business-finder lists [--json]
  business-finder delete <list-id>
  business-finder doctor
  business-finder uninstall [--delete-lists]
  business-finder --version

serve options:
  --port <n>           first port to try; the next free one is used if taken (default 8080)
  --no-open            do not open the web UI in the default browser

scrape options:
  --keyword <text>     keyword to search (repeatable, or comma-separated)
  --city <place>       city or place to search (repeatable for several cities)
  --depth <n>          result batches to read, about 20 places each (default 1)
  --whole-city         search the city as a grid to pass the ~120-place cap (up to ${MAX_WHOLE_CITY_LIMIT})
  --lang <code>        Google Maps language (default en)
  --country <XX>       two-letter country: the place is looked up there (a place
                       found elsewhere stops the search) and phone numbers
                       are read for it (default: the city's)
  --no-email           do not look for emails on websites
  --no-socials         do not look for social profiles on websites
  --no-deep-emails     read only the homepage, not contact or about pages
  --max-time <s>       stop searching after this many seconds (default 600; 1800 for --whole-city)
  --limit <n>          keep at most this many places (up to ${MAX_WHOLE_CITY_LIMIT}; above ${SINGLE_SEARCH_LIMIT} turns on the grid)
  --out <file>         output file ending in .csv or .json
                       (default: Business Finder\business-finder-<keyword>-<city>-<yyyymmdd-hhmm>.csv inside Downloads)
  --json               write JSON instead of CSV
  --full               write every column, not only the lean set
  --fields <a,b,…>     write only these columns, in this order
                       (an unknown name lists the valid ones)
  --no-save            write only the file; do not save the run as a list
  --into <list-id>     add the places to an existing list instead of a new one;
                       a place already in it is skipped (the file holds the
                       places added)
  --source <name>      browser (default) or fixture (reads BUSINESS_FINDER_FIXTURE)

lists options:
  --json               print the lists as JSON (for agents)

add options:
  <file>               .csv with a header row, or .jsonl with one object per line;
                       columns name and website (http/https) are required,
                       phone, city and note are optional
  --title <text>       save the websites as a new list with this title
  --into <list-id>     add the websites to an existing list; a website, or a
                       phone with the same name, already in it is skipped
  --country <XX>       two-letter country for phone numbers (default: the list's)
  --no-socials         do not look for social profiles on websites
  --source <name>      web (default) or fixture (reads BUSINESS_FINDER_FIXTURE's websites)`;

/** Exit codes. */
const OK = 0;
const RUN_FAILED = 1;
/** Exit code after a second Ctrl-C, as a shell reports a run stopped by SIGINT. */
const INTERRUPTED = 130;
const SETUP_PROBLEM = 2;

/** A bad command line: printed with the usage text, exit 2. */
class UsageError extends Error {}

/** The machine is not ready to run (no browser, no fixture): exit 2. */
class SetupError extends Error {}

export type ScrapeCommand = {
  command: "scrape";
  options: RunOptions;
  source: "browser" | "fixture";
  format: "csv" | "json";
  /** The export columns, from `--full` or `--fields`, checked before any scrape. */
  columns: string[];
  /** Also save the run as a list in the job store, as the web UI does. */
  save: boolean;
  /** Add the places to this existing list instead of creating one. */
  into?: string;
  out?: string;
};

/** `reuse`: a bare `business-finder` opens the page of a server that is already running instead of starting another. */
export type ServeCommand = { command: "serve"; port: number; open: boolean; reuse?: true };

export type AddCommand = {
  command: "add";
  file: string;
  target: AddTarget;
  country?: string;
  socials: boolean;
  source: "web" | "fixture";
};

export type ListsCommand = { command: "lists"; json: boolean };

export type DeleteCommand = { command: "delete"; id: string };

export type Command =
  | ScrapeCommand
  | ServeCommand
  | AddCommand
  | ListsCommand
  | DeleteCommand
  | { command: "doctor" }
  | { command: "uninstall"; deleteLists: boolean }
  | { command: "version" }
  | { command: "help" };

function positiveInt(name: string, raw: string | undefined, fallback: number, min = 1): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    throw new UsageError(`--${name} must be a whole number of at least ${min}, got "${raw}".`);
  }
  return Number(raw);
}

function parseScrape(args: string[]): ScrapeCommand {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      keyword: { type: "string", multiple: true },
      city: { type: "string", multiple: true },
      depth: { type: "string" },
      "whole-city": { type: "boolean" },
      lang: { type: "string" },
      country: { type: "string" },
      "no-email": { type: "boolean" },
      "no-socials": { type: "boolean" },
      "no-deep-emails": { type: "boolean" },
      "max-time": { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean" },
      full: { type: "boolean" },
      fields: { type: "string" },
      source: { type: "string" },
      "no-save": { type: "boolean" },
      into: { type: "string" },
    },
  });

  if (positionals.length > 1) {
    throw new UsageError(`Expected one keyword argument, got ${positionals.length}. Quote a keyword with spaces or separate keywords with commas.`);
  }
  if (positionals.length === 1 && values.keyword !== undefined) throw new UsageError("Give the keyword once, not both as text and --keyword.");
  const rawKeywords = positionals.length === 1 ? [positionals[0]!] : (values.keyword ?? []);
  const keywords = dedupeTerms(rawKeywords.flatMap((k) => parseKeywords(k)));
  if (keywords.length === 0) throw new UsageError("Missing the keyword, e.g. business-finder scrape \"dentist\" --city \"Lisbon, Portugal\".");
  const keyword = keywords[0]!;
  const rawCities = values.city ?? [];
  if (rawCities.some((c) => !c.trim())) throw new UsageError("Missing --city.");
  const cities = dedupeTerms(rawCities);
  if (cities.length === 0) throw new UsageError("Missing --city.");
  const city = cities[0]!;

  const country = values.country?.trim();
  if (country !== undefined && !/^[a-z]{2}$/i.test(country)) {
    throw new UsageError(`--country must be a two-letter code such as PT, got "${values.country}".`);
  }
  const source = values.source ?? "browser";
  if (source !== "browser" && source !== "fixture") throw new UsageError(`--source must be browser or fixture, got "${source}".`);

  let format: "csv" | "json" = values.json ? "json" : "csv";
  if (values.out !== undefined) {
    const ext = path.extname(values.out).toLowerCase();
    if (ext !== ".csv" && ext !== ".json") throw new UsageError(`--out must end in .csv or .json, got "${values.out}".`);
    if (values.json && ext !== ".json") throw new UsageError("--json writes JSON; give --out a .json file name.");
    format = ext === ".json" ? "json" : "csv";
  }

  const into = values.into?.trim();
  if (into !== undefined && !isJobId(into)) throw new UsageError(`--into must be a list id as printed by scrape or add, got "${values.into}".`);
  if (into !== undefined && values["no-save"]) throw new UsageError("--into adds to a saved list; leave out --no-save.");

  if (values.full && values.fields !== undefined) throw new UsageError("Use --full or --fields, not both.");
  // Throws UnknownColumnError for a misspelt name, before anything is scraped.
  const columns = resolveColumns({ full: Boolean(values.full), ...(values.fields !== undefined ? { fields: values.fields } : {}) });

  const limit = values.limit !== undefined ? positiveInt("limit", values.limit, 0, 0) : undefined;
  if (limit !== undefined && limit > MAX_WHOLE_CITY_LIMIT) {
    throw new UsageError(`--limit must be at most ${MAX_WHOLE_CITY_LIMIT}, got "${values.limit}".`);
  }
  const wholeCity = Boolean(values["whole-city"]);
  const grid = usesWholeCityGrid({ wholeCity, limit });

  const options: RunOptions = {
    keyword,
    ...(keywords.length > 1 ? { keywords } : {}),
    city,
    ...(cities.length > 1 ? { cities } : {}),
    depth: positiveInt("depth", values.depth, grid ? SEARCH_SIZES.wholeCity.depth : 1),
    lang: values.lang?.trim() || "en",
    emails: !values["no-email"],
    socials: !values["no-socials"],
    deep: !values["no-deep-emails"],
    maxSeconds: positiveInt("max-time", values["max-time"], grid ? SEARCH_SIZES.wholeCity.maxSeconds : 600),
    ...(wholeCity ? { wholeCity: true } : {}),
  };
  if (country) options.country = country.toUpperCase();
  if (limit !== undefined) options.limit = limit;

  return {
    command: "scrape",
    options,
    source,
    format,
    columns,
    save: !values["no-save"],
    ...(into !== undefined ? { into } : {}),
    ...(values.out !== undefined ? { out: values.out } : {}),
  };
}

function parseAdd(args: string[]): AddCommand {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      title: { type: "string" },
      into: { type: "string" },
      country: { type: "string" },
      "no-socials": { type: "boolean" },
      source: { type: "string" },
    },
  });
  if (positionals.length !== 1) throw new UsageError(`Expected one file, got ${positionals.length}.`);
  const file = positionals[0]!;
  const title = values.title?.trim();
  const into = values.into?.trim();
  if (values.title !== undefined && values.into !== undefined) throw new UsageError("Give --title or --into, not both.");
  if (!title && !into) throw new UsageError("Give --title \"<text>\" for a new list or --into <list-id> to add to one.");
  if (into !== undefined && !isJobId(into)) throw new UsageError(`--into must be a list id as printed by scrape or add, got "${values.into}".`);
  const country = values.country?.trim();
  if (country !== undefined && !/^[a-z]{2}$/i.test(country)) {
    throw new UsageError(`--country must be a two-letter code such as PT, got "${values.country}".`);
  }
  const source = values.source ?? "web";
  if (source !== "web" && source !== "fixture") throw new UsageError(`--source must be web or fixture, got "${source}".`);
  return {
    command: "add",
    file,
    target: into ? { into } : { title: title! },
    ...(country ? { country: country.toUpperCase() } : {}),
    socials: !values["no-socials"],
    source,
  };
}

function parseServe(args: string[]): ServeCommand {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: { port: { type: "string" }, "no-open": { type: "boolean" } },
  });
  const port = positiveInt("port", values.port, DEFAULT_PORT, 0);
  if (port > 65_535) throw new UsageError(`--port must be at most 65535, got "${values.port}".`);
  return { command: "serve", port, open: !values["no-open"] };
}

/** Turns argv (without the runtime and script) into a command; throws `UsageError`. */
export function parseCli(argv: string[]): Command {
  const [first, ...rest] = argv;
  switch (first) {
    case "scrape":
      return parseScrape(rest);
    case "serve":
      return parseServe(rest);
    case "add":
      return parseAdd(rest);
    case "lists": {
      const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { json: { type: "boolean" } } });
      return { command: "lists", json: Boolean(values.json) };
    }
    case "delete": {
      const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {} });
      if (positionals.length !== 1) throw new UsageError("Give one list id, e.g. business-finder delete <list-id>.");
      const id = positionals[0]!.trim();
      if (!isJobId(id)) throw new UsageError(`List id must be as printed by scrape or lists, got "${positionals[0]}".`);
      return { command: "delete", id };
    }
    case "doctor":
      parseArgs({ args: rest, strict: true, allowPositionals: false, options: {} });
      return { command: "doctor" };
    case "uninstall": {
      const { values } = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: { "delete-lists": { type: "boolean" } },
      });
      return { command: "uninstall", deleteLists: Boolean(values["delete-lists"]) };
    }
    case "--version":
    case "-v":
      return { command: "version" };
    case "--help":
    case "-h":
    case "help":
      return { command: "help" };
    case undefined:
      return { ...parseServe([]), reuse: true };
    default:
      throw new UsageError(`Unknown command "${first}".`);
  }
}

/** The browser error and every path looked at, one per line. */
function browserProblem(error: string, searched: string[]): string {
  return [error, "  searched:", ...searched.map((p) => `    ${p}`)].join("\n");
}

/** Fixture mode: `BUSINESS_FINDER_FIXTURE` names the fixture JSON file. */
async function fixtureDeps(env: NodeJS.ProcessEnv): Promise<Omit<RunDeps, "now">> {
  const file = env.BUSINESS_FINDER_FIXTURE?.trim();
  if (!file) throw new SetupError("--source fixture needs BUSINESS_FINDER_FIXTURE set to the path of a fixture JSON file.");
  return loadFixtureDeps(file);
}

/**
 * Prints each progress stage in its documented shape, skipping repeats.
 * The "Searching around" line names the place from OpenStreetMap, never from Google.
 */
function progressPrinter(city: string, out: (line: string) => void): (p: ScrapeProgress) => void {
  let last = "";
  let lastLocKey = "";
  return (p) => {
    if (p.location) {
      const { label, lat, lon } = p.location;
      const locKey = `${label}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
      if (locKey !== lastLocKey) {
        lastLocKey = locKey;
        out(`  Searching around ${label}`);
      }
    }
    let line: string | null = null;
    if (p.stage === "geocoding") line = `▶ Geocoding ${p.currentCity ?? city}…`;
    else if (p.stage === "searching" && p.retryInSeconds !== undefined) {
      line = `  Google is limiting this computer; trying again in ${p.retryInSeconds} s (${p.retry} of ${p.retries})`;
    } else if (p.stage === "searching") {
      const scope: string[] = [];
      if (p.keywordIndex !== undefined && p.keywordsTotal !== undefined && p.keywordsTotal > 1) {
        scope.push(`keyword ${p.keywordIndex}/${p.keywordsTotal}`);
      }
      if (p.cityIndex !== undefined && p.citiesTotal !== undefined && p.citiesTotal > 1) {
        scope.push(`city ${p.cityIndex}/${p.citiesTotal}`);
      }
      if (p.cell !== undefined && p.cells !== undefined) {
        scope.push(`cell ${p.cell}/${p.cells}`);
      }
      const suffix = scope.length > 0 ? ` (${scope.join(", ")})` : "";
      line = `  searching: ${p.places} places${suffix}`;
    } else if (p.stage === "checking_websites" && p.toCheck !== undefined && p.checked !== undefined) {
      line = `  checking websites: ${p.checked}/${p.toCheck}${p.notChecked ? `, ${p.notChecked} not checked` : ""}`;
    }
    if (line !== null && line !== last) {
      last = line;
      out(line);
    }
  };
}

/** The counts line; a scrape also counts the leads that share a phone with another. */
function summary(leads: Lead[], o: { samePhone?: boolean } = {}): string {
  const n = leads.length;
  const count = (has: (l: Lead) => boolean) => leads.filter(has).length;
  const samePhone = o.samePhone ? `, same phone ${countSamePhone(leads)}/${n}` : "";
  return (
    `✓ ${n} ${n === 1 ? "lead" : "leads"} (emails ${count((l) => l.emails.length > 0)}/${n}, ` +
    `phones ${count((l) => Boolean(l.phone))}/${n}, WhatsApp ${count((l) => Boolean(l.whatsapp))}/${n}${samePhone})`
  );
}

/** Shown when a search reached the end of Google Maps' results, which stop at about 100–120 places. */
export function endOfListLine(listId: string | null): string {
  const more = listId ? ` with --into ${listId}` : "";
  return `  reached the end of Google Maps' results: one search shows at most about 100–120 places. For more, search other words or a nearby area${more}.`;
}

/** Writes through a temporary file so a reader never sees a half-written export. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temp, text, "utf8");
    await rename(temp, file);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => {});
    throw new UserFacingError(`Could not save ${file} (${plainOsReason(e)}). If an AI agent is running this, allow it to write there and try again.`);
  }
}

export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => Date;
  /** Resolves when `serve` should stop. Default: the first Ctrl-C (SIGINT) or SIGTERM. */
  untilStopped?: () => Promise<void>;
  /** Confirms a yes/no prompt (used by `uninstall`). Default: reads stdin, defaulting to false. */
  confirm?: (question: string) => Promise<boolean>;
  /** Opens a page in the browser (a bare `business-finder` reusing a running server). Default: the system browser. */
  openUrl?: (url: string) => Promise<void>;
  /** The built web UI folder `serve` hands to the server. Default: `web/dist`. */
  webDir?: string;
  /** Overrides the user's Downloads folder in tests. Default: OS known-folder lookup. */
  downloadsDir?: () => string | Promise<string>;
};

/**
 * The port of a running `business-finder serve` that uses this data folder, or
 * null. The server must answer health with the recorded pid: after a pid is
 * reused, another Business Finder can be answering on the recorded port.
 */
export async function findServer(dataDir: string): Promise<number | null> {
  const record = readServerRecord(dataDir);
  if (!record || !processAlive(record.pid)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${record.port}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { ok?: unknown; pid?: unknown };
    return res.ok && body.ok === true && body.pid === record.pid ? record.port : null;
  } catch {
    return null;
  }
}

/** The line that names a saved list, with its address when a server is running. */
export async function listLine(id: string, env: NodeJS.ProcessEnv): Promise<string> {
  const port = await findServer(defaultDataDir(env));
  return port === null
    ? `  saved as list ${id}; run \`business-finder serve\` to see it`
    : `  saved as list ${id}; open http://127.0.0.1:${port}/?job=${id} while business-finder serve is running`;
}

/** The job store, or a plain error naming the folder when it cannot be opened or written. */
export function openStore(env: NodeJS.ProcessEnv): JobStore {
  const dataDir = defaultDataDir(env);
  ensureWritableDir(dataDir);
  const dir = defaultJobsDir(env);
  ensureWritableDir(dir);
  try {
    return new JobStore(dir);
  } catch (e) {
    if (e instanceof DataDirWriteError) throw e;
    throw new DataDirWriteError(formatWriteError(dir, e));
  }
}

/** Runs `fn` and turns any OS filesystem write error inside the data folder into a plain `DataDirWriteError`. */
function withStoreWrite<T>(dir: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (isFsError(e)) throw new DataDirWriteError(formatWriteError(dir, e));
    throw e;
  }
}

async function scrape(cmd: ScrapeCommand, io: Io): Promise<number> {
  let deps: Omit<RunDeps, "now">;
  if (cmd.source === "fixture") {
    deps = await fixtureDeps(io.env);
  } else {
    // Check before geocoding so a machine without a browser fails fast.
    const found = findBrowser(io.env, existsSync, process.platform);
    if ("error" in found) throw new SetupError(browserProblem(found.error, found.searched));
    const geocode = createGeocoder({ cacheFile: path.join(defaultDataDir(io.env), GEOCODE_CACHE_FILE) });
    deps = { source: browserSource(), geocode, enrich: checkWebsites };
  }

  const startedAt = io.now();
  // Ctrl-C while the websites are checked stops the checks and still writes
  // the file with every place found; a second Ctrl-C quits at once.
  const finishChecks = new AbortController();
  const onInterrupt = () => {
    if (finishChecks.signal.aborted) process.exit(INTERRUPTED);
    io.out("  stopping: finishing with the websites checked so far (Ctrl-C again to quit now)");
    finishChecks.abort();
  };
  let listening = false;
  const printProgress = progressPrinter(cmd.options.city, io.out);
  const printer = (p: ScrapeProgress) => {
    if (p.stage === "checking_websites" && !listening) {
      listening = true;
      process.on("SIGINT", onInterrupt);
    }
    printProgress(p);
  };
  const runner: Runner = (options, onProgress, signal, rows) =>
    runScrape(options, { ...deps, now: io.now, finishChecks: finishChecks.signal }, onProgress, signal, rows);
  try {
    return await scrapeWith(cmd, io, runner, printer, startedAt, () => finishChecks.signal.aborted);
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

async function scrapeWith(
  cmd: ScrapeCommand,
  io: Io,
  runner: Runner,
  printer: (p: ScrapeProgress) => void,
  startedAt: Date,
  interrupted: () => boolean,
): Promise<number> {

  // A saved run goes through the same job code as the web UI, so the list is
  // written, updated and finished exactly like a search started there.
  let result: RunResult;
  let leads: Lead[];
  let list: { id: string; saveError?: string } | null = null;
  let intoLine: string | null = null;
  let combinedLine: string | null = null;
  let alreadyInList = 0;
  if (cmd.into) {
    const store = openStore(io.env);
    let run: Awaited<ReturnType<typeof runInto>>;
    try {
      run = await runInto(store, cmd.into, cmd.options, runner, printer);
    } catch (e) {
      if (e instanceof ListBusyError) throw new SetupError(e.message);
      if (isFsError(e)) throw new DataDirWriteError(formatWriteError(store.dir, e));
      throw e;
    }
    if (!run) throw new SetupError(`No list ${cmd.into} in ${store.dir}.`);
    result = run.result;
    leads = run.added;
    alreadyInList = run.alreadyInList;
    list = { id: cmd.into, ...(run.saveError ? { saveError: run.saveError } : {}) };
    intoLine = `  list: ${run.added.length} added, ${run.alreadyInList} already in it, ${run.total} ${run.total === 1 ? "place" : "places"} in all`;
  } else if (cmd.save) {
    const store = openStore(io.env);
    const job = withStoreWrite(store.dir, () => store.create(cmd.options, { owner: { kind: "cli", pid: process.pid } }));
    const run = await runJob(store, job.id, runner, printer);
    if (!run) throw new UserFacingError(`Could not start list ${job.id} in ${store.dir}.`);
    result = run.result;
    leads = result.leads;
    list = { id: job.id, ...(run.saveError ? { saveError: run.saveError } : {}) };
    // The same search run before is one list: the file holds all of it, as the page's download does.
    const combined = run.saveError ? null : readList(store, job.id);
    if (combined && combined.list.runs > 1) {
      leads = combined.list.rows;
      const { rows, runs, fresh } = combined.list;
      combinedLine = `  list: ${rows.length} ${rows.length === 1 ? "place" : "places"} in all from ${runs} runs of this search, ${fresh} new`;
    }
  } else {
    result = await runner(cmd.options, printer);
    leads = result.leads;
  }

  const r = result.reconciliation;
  // Echoes only the flag value, never anything scraped.
  if (result.reason === "timeout") io.out(`  stopped at the time limit (--max-time ${cmd.options.maxSeconds})`);
  io.out(summary(combinedLine ? result.leads : leads, { samePhone: true }));
  if (namesOnly(result.leads)) io.out(`  warning: ${NAMES_ONLY_WARNING}`);
  // Places the list already had count as duplicates, so the line still balances.
  io.out(`  reconciliation: found ${r.found} = kept ${r.kept - alreadyInList} + filtered ${r.filtered} + duplicates ${r.duplicates + alreadyInList}`);
  if (result.keywords && result.keywords.length > 1) {
    for (const k of result.keywords) {
      io.out(`  keyword "${k.keyword}": ${k.added} added, ${k.duplicates} duplicates (${k.found} found)`);
    }
  }
  const notChecked = r.notChecked ?? 0;
  if (notChecked > 0) {
    const websites = notChecked === 1 ? "1 website was" : `${notChecked} websites were`;
    io.out(interrupted() ? `  stopped: ${websites} not checked` : `  ${skippedWebsitesLine(notChecked)}`);
  }
  if (intoLine) io.out(intoLine);
  if (combinedLine) io.out(combinedLine);
  const grid = usesWholeCityGrid(cmd.options);
  if (result.reason === "end-of-list" && !grid) io.out(endOfListLine(list?.id ?? null));

  const { columns } = cmd;
  const file = cmd.out
    ? path.resolve(io.cwd, cmd.out)
    : io.downloadsDir
      ? path.join(await io.downloadsDir(), EXPORT_SUBFOLDER, defaultFileName(cmd.options.keyword, cmd.options.city, startedAt, cmd.format))
      : defaultOutPath(cmd.options.keyword, cmd.options.city, startedAt, cmd.format, { env: io.env });
  await writeAtomic(file, cmd.format === "json" ? toJson(leads, columns) : toCsv(leads, columns));
  io.out(`  saved → ${file}`);

  if (list?.saveError) {
    // The file is written, but the list is not: say so and exit 1.
    io.err(list.saveError);
    return RUN_FAILED;
  }
  if (list) io.out(await listLine(list.id, io.env));

  if (result.reason === "blocked") {
    // The places read before the block are saved, but the file is not complete.
    io.err(BLOCKED_MESSAGE);
    return RUN_FAILED;
  }
  if (interrupted() && notChecked > 0) {
    io.err("Stopped before every website was checked. The file has every place found; the unchecked ones have no email yet.");
    return RUN_FAILED;
  }
  return OK;
}

async function add(cmd: AddCommand, io: Io): Promise<number> {
  const enrich = cmd.source === "fixture" ? (await fixtureDeps(io.env)).enrich : enrichLeads;
  // The whole file is checked before anything is saved.
  const file = path.resolve(io.cwd, cmd.file);
  const { entries, skipped } = await readWebFile(file);
  for (const s of skipped) io.out(`  line ${s.line} skipped: ${s.reason}`);

  const store = openStore(io.env);
  let last = "";
  let result: Awaited<ReturnType<typeof addToList>>;
  try {
    result = await addToList(
      entries,
      { target: cmd.target, socials: cmd.socials, ...(cmd.country ? { country: cmd.country } : {}) },
      {
        store,
        enrich,
        now: io.now,
        onProgress: (p) => {
          const line = `  checking websites: ${p.checked}/${p.toCheck}`;
          if (line !== last) io.out((last = line));
        },
      },
    );
  } catch (e) {
    if (isFsError(e)) throw new DataDirWriteError(formatWriteError(store.dir, e));
    throw e;
  }
  for (const d of result.duplicates) io.out(`  line ${d.line} skipped: ${d.reason}`);
  io.out(summary(result.added));
  const lines = entries.length + skipped.length;
  io.out(`  lines: ${lines} = added ${result.added.length} + invalid ${skipped.length} + duplicates ${result.duplicates.length}`);
  io.out(await listLine(result.job.id, io.env));
  return OK;
}

/** "2026-11-19 17:42" in the computer's own clock. */
function runDate(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Every saved list, one per search (repeated runs of a search are one list),
 * newest first: its title, place count, last run and id; `--json` adds the
 * places per Google category. Titles are the
 * searches as typed, never scraped text. The id is the run the list follows;
 * any run's id opens the same list.
 */
function lists(cmd: ListsCommand, io: Io): number {
  const store = openStore(io.env);
  const all = listSummaries(store);
  if (cmd.json) {
    // Google's category names with counts, so an agent can check a search
    // stayed on topic without reading the rows; a name that does not read like
    // a category is only counted.
    const categoriesOf = (id: string) => categoriesForAgents(readList(store, id)?.list.rows ?? []);
    const rows = all.map((l) => ({
      id: l.id,
      title: l.title,
      keyword: l.options.keyword,
      ...(l.options.keywords ? { keywords: l.options.keywords } : {}),
      city: l.options.city,
      ...(l.options.cities ? { cities: l.options.cities } : {}),
      places: l.count,
      ...categoriesOf(l.id),
      runs: l.runs,
      lastRun: l.lastRun,
      status: l.status,
    }));
    io.out(JSON.stringify(rows, null, 2));
    return OK;
  }
  if (all.length === 0) {
    io.out("No saved lists yet.");
    return OK;
  }
  for (const l of all) {
    const places = `${l.count} ${l.count === 1 ? "place" : "places"}`;
    const runs = l.runs > 1 ? `, ${l.runs} runs` : "";
    const status = l.status === "queued" || l.status === "running" ? ", running" : "";
    io.out(`${l.title} · ${places}${runs}${status} · last run ${runDate(l.lastRun)} · ${l.id}`);
  }
  return OK;
}

/** Deletes a saved list and every run of its search; refuses when any run is still running. */
function deleteListCommand(cmd: DeleteCommand, io: Io): number {
  const store = openStore(io.env);
  const group = groupOf(store.list(), cmd.id);
  if (!group) throw new SetupError(`No list ${cmd.id} in ${store.dir}.`);
  const active = group.runs.some(
    (r) => (r.status === "running" || r.status === "queued") && (!r.owner || processAlive(r.owner.pid)),
  );
  if (active) throw new UserFacingError("This search is still running. Cancel it first.");
  let removed = 0;
  for (const run of [...group.runs].reverse()) {
    if (withStoreWrite(store.dir, () => store.delete(run.id))) removed += 1;
  }
  io.out(`✓ Deleted ${group.title} (${removed} ${removed === 1 ? "run" : "runs"} removed)`);
  return OK;
}

/** Resolves on the first SIGINT (Ctrl-C) or SIGTERM. */
function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

async function serve(cmd: ServeCommand, io: Io): Promise<number> {
  if (cmd.reuse) {
    const running = await findServer(defaultDataDir(io.env));
    if (running !== null) {
      const url = `http://127.0.0.1:${running}`;
      io.out(`✓ Business Finder is already running at ${url}`);
      if (cmd.open) {
        try {
          await (io.openUrl ?? openInBrowser)(url);
        } catch {
          io.out("  open that address in your browser");
        }
      }
      return OK;
    }
  }
  const webDir = path.resolve(io.webDir ?? WEB_DIST_DIR);
  // Listen for Ctrl-C before starting, so an early one still closes the server.
  const stopped = (io.untilStopped ?? untilSignal)();
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    ensureWritableDir(defaultDataDir(io.env));
    server = await startServer({
      port: cmd.port,
      open: cmd.open,
      staticDir: webDir,
      jobsDir: defaultJobsDir(io.env),
      geocodeCacheFile: path.join(defaultDataDir(io.env), GEOCODE_CACHE_FILE),
    });
  } catch (e) {
    if (e instanceof MigrationBlockedError || e instanceof FixtureFileError || e instanceof SetupError) throw e;
    if (e instanceof DataDirWriteError) throw new UserFacingError(`Could not start the server: ${e.message}`);
    // Nothing has been scraped yet, so the message holds no page text.
    throw new UserFacingError(`Could not start the server: ${plainOsReason(e)}`);
  }
  // Lets a CLI run in another terminal link to this server.
  const dataDir = defaultDataDir(io.env);
  writeServerRecord(dataDir, { pid: process.pid, port: server.port });
  io.out(`✓ Business Finder running at ${server.url}`);
  if (cmd.port !== 0 && server.port !== cmd.port) io.out(`  port ${cmd.port} was in use`);
  if (!existsSync(path.join(webDir, "index.html"))) {
    io.out(`  the web UI is not built yet: run \`bun run build:web\` in ${path.resolve(WEB_DIST_DIR, "..", "..")}, then reload the page`);
  }
  io.out("  press Ctrl-C to stop");
  await stopped;
  clearServerRecord(dataDir, process.pid);
  await server.close();
  io.out("  stopped");
  return OK;
}

/** The error's type name if it is a plain identifier, else "Error"; never its message. */
function errorName(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) ? name : "Error";
}

async function doctor(io: Io): Promise<number> {
  io.out(`business-finder ${VERSION}`);
  const dataDir = defaultDataDir(io.env);
  io.out(`  data: ${dataDir}`);
  ensureWritableDir(dataDir);
  const found = findBrowser(io.env, existsSync, process.platform);
  try {
    const port = await probePort(DEFAULT_PORT);
    io.out(
      port === "free"
        ? `✓ port ${DEFAULT_PORT}: free`
        : `  port ${DEFAULT_PORT}: ${port === "reserved" ? "reserved by Windows" : "in use"} (serve will pick the next free port)`,
    );
  } catch (e) {
    io.out(`  port ${DEFAULT_PORT}: could not check (${plainOsReason(e)})`);
  }
  if ("error" in found) {
    io.out(`✗ ${browserProblem(found.error, found.searched)}`);
    return SETUP_PROBLEM;
  }
  io.out(`✓ browser: ${found.path}`);
  return OK;
}

function invokedAsLeadscout(env: NodeJS.ProcessEnv): boolean {
  if (env.BUSINESS_FINDER_ALIASED_FROM === "leadscout") return true;
  const script = process.argv[1];
  if (!script) return false;
  return path.basename(script).replace(/\.(cmd|bat|exe|mjs|cjs|js|ts)$/i, "").toLowerCase() === "leadscout";
}

/** Runs one command line and returns the exit code. Never throws. */
export async function main(argv: string[], io: Io): Promise<number> {
  if (invokedAsLeadscout(io.env)) {
    io.err("leadscout is now called business-finder");
  }
  let cmd: Command;
  try {
    cmd = parseCli(argv);
  } catch (e) {
    // The valid column names are the help for a misspelt --fields name.
    io.err(e instanceof UnknownColumnError ? e.message : `${(e as Error).message}\n\n${USAGE}`);
    return SETUP_PROBLEM;
  }
  try {
    if (cmd.command !== "version" && cmd.command !== "help" && cmd.command !== "uninstall") {
      const migration = await migrateDataDir({ env: io.env });
      if (migration.outcome === "old_server_running" || migration.outcome === "installer_managed") {
        throw new MigrationBlockedError(migration.message);
      }
      if (migration.outcome === "both_kept_new" && migration.message) {
        io.err(migration.message);
      }
    }
    switch (cmd.command) {
      case "version":
        io.out(`business-finder ${VERSION}`);
        return OK;
      case "help":
        io.out(USAGE);
        return OK;
      case "doctor":
        return await doctor(io);
      case "uninstall":
        return await uninstallBusinessFinder({
          env: io.env,
          out: io.out,
          confirm: io.confirm ?? askYesNo,
          deleteLists: cmd.deleteLists,
        });
      case "scrape":
        return await scrape(cmd, io);
      case "add":
        return await add(cmd, io);
      case "lists":
        return lists(cmd, io);
      case "delete":
        return deleteListCommand(cmd, io);
      case "serve":
        return await serve(cmd, io);
    }
  } catch (e) {
    // Only the message is printed: no stack trace, no cause.
    if (
      e instanceof SetupError ||
      e instanceof FixtureFileError ||
      e instanceof AddInputError ||
      e instanceof MigrationBlockedError
    ) {
      io.err(e.message);
      return SETUP_PROBLEM;
    }
    if (e instanceof BrowserNotFoundError) {
      io.err(browserProblem(e.message, e.searched));
      return SETUP_PROBLEM;
    }
    if (e instanceof DataDirWriteError) {
      io.err(e.message);
      return cmd.command === "doctor" ? SETUP_PROBLEM : RUN_FAILED;
    }
    if (e instanceof CancelledError) {
      io.err(e.message);
      return RUN_FAILED;
    }
    if (e instanceof ReconciliationError) {
      io.err("Something went wrong while checking the search results. Try again.");
      return RUN_FAILED;
    }
    // Any other message may carry page text from the browser, so only the
    // error's type is shown.
    io.err(e instanceof UserFacingError ? e.message : `business-finder failed unexpectedly (${errorName(e)})`);
    return RUN_FAILED;
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await main(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
  });
  process.exitCode = code;
}
