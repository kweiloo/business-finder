// Runs queued jobs one at a time. One browser and one crawl at a time keeps
// the load on Google Maps and on the sites being checked at a single
// user's level.

import { debugLogFromEnv } from "../core/debugLog.js";
import { CANCELLED_MESSAGE, CancelledError, INTERRUPTED_MESSAGE, ReconciliationError, UserFacingError } from "../core/errors.js";
import { citiesOf, keywordsOf } from "../core/keywords.js";
import { BLOCKED_MESSAGE, type RowSink, type ScrapeProgress } from "../core/pipeline.js";
import { BrowserNotFoundError } from "../core/sources/browser/index.js";
import type { Lead, Progress, Reconciliation, RunOptions, RunResult } from "../core/types.js";
import { countryFromLeads, leadCandidate, ListIndex, NAMES_ONLY_WARNING, namesOnly } from "./dedupe.js";
import { processAlive, type Job, type JobStore } from "./store.js";

/**
 * Runs one scrape; in production this is `runScrape` with real or fixture
 * dependencies. `signal` is aborted when the user cancels the job; `runJob`
 * always passes one, a direct call (a CLI run without a list) may not.
 * `rows` gets the rows while the run goes (see `RowSink`); a runner that
 * never calls it has its result saved in one write at the end.
 */
export type Runner = (
  options: RunOptions,
  onProgress: (p: ScrapeProgress) => void,
  signal?: AbortSignal,
  rows?: RowSink,
) => Promise<RunResult>;

/**
 * What `JobWorker.cancel` did:
 *
 * - `cancelled`: the job had not started (or nothing was running it) and is now cancelled.
 * - `cancelling`: the job is running here; it is aborted and ends `cancelled` shortly.
 * - `finished`: the job had already ended.
 * - `elsewhere`: another live process (a CLI command, another server) runs it; this worker cannot stop it.
 * - `unknown`: there is no such job.
 */
export type CancelOutcome = "cancelled" | "cancelling" | "finished" | "elsewhere" | "unknown";

export { INTERRUPTED_MESSAGE };

function failureMessage(e: unknown): string {
  if (e instanceof UserFacingError) return e.message;
  if (e instanceof ReconciliationError) return "Something went wrong while checking the search results. Try again.";
  if (e instanceof BrowserNotFoundError) {
    return "No supported browser was found on this computer. Install Google Chrome, Microsoft Edge, or Brave and try again.";
  }
  return "The search stopped because something went wrong. Try again.";
}

const ALLOWED_CAUSE_HOSTS = new Set([
  "www.google.com",
  "google.com",
  "maps.google.com",
  "nominatim.openstreetmap.org",
  "127.0.0.1",
  "localhost",
]);

function sanitizeCauseText(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const withoutUrls = collapsed.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
    try {
      const host = new URL(match).hostname.toLowerCase();
      if (ALLOWED_CAUSE_HOSTS.has(host)) return match;
    } catch {
      // Invalid URL; redact as well.
    }
    return "[url]";
  });
  const withoutEmails = withoutUrls.replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, "[email]");
  return withoutEmails.length > 300 ? `${withoutEmails.slice(0, 297)}...` : withoutEmails;
}

function formatCausePart(e: unknown): string {
  if (e instanceof Error) {
    const name = /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(e.name) ? e.name : "Error";
    const msg = sanitizeCauseText(e.message);
    return msg ? `${name}: ${msg}` : name;
  }
  const text = sanitizeCauseText(String(e));
  return text || "Unknown error";
}

/** Technical failure cause without scraped URLs or emails, kept in job.json and debug logs. */
export function failureCause(e: unknown): string {
  const main = formatCausePart(e);
  if (e instanceof Error && e.cause !== undefined && e.cause !== e) {
    const inner = formatCausePart(e.cause);
    return inner ? `${main} <- ${inner}` : main;
  }
  return main;
}

export class JobWorker {
  private readonly queue: string[] = [];
  private current: string | null = null;
  private abort: AbortController | null = null;
  private draining: Promise<void> | null = null;

  constructor(
    private readonly store: JobStore,
    private readonly runner: Runner,
  ) {
    // A job left queued or running by a process that has stopped has nothing
    // behind it any more. Resuming is not supported yet, so it fails with a
    // message instead of showing as running forever. A job whose owner is
    // still alive (a CLI scrape, another server) is left to that process. A
    // job with no owner was written before owners were recorded and is
    // treated as orphaned, as it always was.
    // Rows are saved batch by batch, so either way the rows saved before
    // the process stopped are kept. A finished list held to add rows to it
    // goes back to the status it had, with those rows added.
    for (const job of store.list()) {
      if (job.status !== "queued" && job.status !== "running") continue;
      if (job.owner && processAlive(job.owner.pid)) continue;
      if (job.held) tryRelease(store, job.id);
      else this.tryUpdate(job.id, { status: "failed", error: INTERRUPTED_MESSAGE });
    }
  }

  /** The id of the job being run, or null when idle. */
  get running(): string | null {
    return this.current;
  }

  /** Queues a job and records this process as the one running it. */
  enqueue(id: string): void {
    this.tryUpdate(id, { owner: { kind: "server", pid: process.pid } });
    this.queue.push(id);
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  /** Drops a job that has not started; false when it is not waiting in the queue. */
  dequeue(id: string): boolean {
    const at = this.queue.indexOf(id);
    if (at === -1) return false;
    this.queue.splice(at, 1);
    return true;
  }

  /**
   * Stops a job: a queued one never starts, a running one is aborted. The
   * rows it saved before it stopped are kept, and the job reads `cancelled`.
   */
  cancel(id: string): CancelOutcome {
    if (this.current === id) {
      this.abort?.abort();
      return "cancelling";
    }
    const job = this.store.get(id);
    if (!job) return "unknown";
    if (job.status !== "queued" && job.status !== "running") return "finished";
    const queuedHere = this.dequeue(id);
    if (!queuedHere && job.owner && processAlive(job.owner.pid)) return "elsewhere";
    if (job.held) {
      // The process adding rows to a finished list has gone; the list was finished.
      tryRelease(this.store, id);
      return "finished";
    }
    // Queued here, or left behind by a process that has gone. A failed write throws.
    this.store.update(id, cancelledPatch(job.progress));
    return "cancelled";
  }

  /** Resolves when the queue is empty. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
      this.current = id;
      this.abort = new AbortController();
      try {
        await this.run(id, this.abort.signal);
      } finally {
        this.current = null;
        this.abort = null;
      }
    }
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    try {
      await runJob(this.store, id, this.runner, () => {}, signal);
    } catch {
      // runJob has already written the failure or the cancellation onto the job.
    }
  }

  private tryUpdate(id: string, patch: Partial<Job>): boolean {
    return tryUpdate(this.store, id, patch);
  }
}

function tryUpdate(store: JobStore, id: string, patch: Partial<Job>): boolean {
  try {
    store.update(id, patch);
    return true;
  } catch {
    return false;
  }
}

function tryRelease(store: JobStore, id: string): void {
  try {
    store.release(id);
  } catch {
    // Left held; the next start-up or hold puts it back.
  }
}

/** The final write must land; it is retried once before giving up. */
function finish(store: JobStore, id: string, patch: Partial<Job>): void {
  if (tryUpdate(store, id, patch)) return;
  tryUpdate(store, id, patch);
}

function cancelledPatch(progress: Progress): Partial<Job> {
  return { status: "cancelled", progress: { ...progress, message: CANCELLED_MESSAGE } };
}

/** How long a filled-in row may wait before it is written; rows checked together share one rewrite. */
export const ROW_FLUSH_MS = 1_000;

/**
 * Saves one run's rows into a job while the run goes: each batch is appended
 * as whole lines (`JobStore.appendLeads`) the moment it arrives, and a row
 * filled in by its website check replaces its own line (`replaceLeads`, a
 * whole-file rename) instead of being appended again. Replacements wait up
 * to `ROW_FLUSH_MS`, so a burst of checks costs one rewrite; `flush` writes
 * what is waiting.
 *
 * `accept` decides which rows go into the list at all (`runInto` drops
 * places the list already has). After the first failed write nothing more is
 * written and `error` says why, so row positions never drift.
 */
export class RowWriter implements RowSink {
  /** For each row the run added, its position in `leads.jsonl`, or undefined when it was not kept. */
  private readonly slots: (number | undefined)[] = [];
  /** The newest version of each kept row, by position, in the order they were saved. */
  private readonly latest = new Map<number, Lead>();
  private readonly waiting = new Map<number, Lead>();
  private lastFlush: number;
  error: string | undefined;

  constructor(
    private readonly store: JobStore,
    private readonly id: string,
    /** Where the next row goes: the rows the list had before this run. */
    private next: number,
    private readonly accept: (lead: Lead) => boolean = () => true,
    private readonly now: () => number = Date.now,
  ) {
    this.lastFlush = now();
  }

  /** Rows this run handed over, kept or not. */
  get seen(): number {
    return this.slots.length;
  }

  /** The rows this run saved, as they are now (checked or not), in order. */
  get kept(): Lead[] {
    return [...this.latest.values()];
  }

  added(leads: Lead[]): void {
    const keep: Lead[] = [];
    for (const lead of leads) {
      if (this.error || !this.accept(lead)) {
        this.slots.push(undefined);
        continue;
      }
      this.slots.push(this.next + keep.length);
      keep.push(lead);
    }
    if (keep.length === 0) return;
    try {
      this.store.appendLeads(this.id, keep);
    } catch {
      this.error = "Could not save the places to this computer. Check free space and try again.";
      return;
    }
    keep.forEach((lead, i) => this.latest.set(this.next + i, lead));
    this.next += keep.length;
  }

  checked(row: number, lead: Lead): void {
    const slot = this.slots[row];
    if (slot === undefined || !this.latest.has(slot) || this.error) return;
    this.latest.set(slot, lead);
    this.waiting.set(slot, lead);
    if (this.now() - this.lastFlush >= ROW_FLUSH_MS) this.flush();
  }

  /** Writes every row filled in since the last write. */
  flush(): void {
    this.lastFlush = this.now();
    if (this.waiting.size === 0 || this.error) return;
    try {
      this.store.replaceLeads(this.id, this.waiting);
      this.waiting.clear();
    } catch {
      this.error = "Could not save the places to this computer. Check free space and try again.";
    }
  }
}

/** "Search cancelled. 12 places were found before it stopped." */
export function stoppedEarly(n: number): string {
  if (n === 0) return `${CANCELLED_MESSAGE} No places were found before it stopped.`;
  return `${CANCELLED_MESSAGE} ${n} ${n === 1 ? "place was" : "places were"} found before it stopped.`;
}

/** What a stored run produced: the result, and why the leads could not be saved if they were not. */
export type JobRun = { result: RunResult; saveError?: string };

/**
 * Runs one queued job and keeps its `job.json` and `leads.jsonl` current:
 * `running`, every progress update, the searched place once it is looked up,
 * then `done` or `failed`. The server's worker and the CLI both run jobs
 * through here, so a list looks the same whichever started it.
 *
 * Rows are saved batch by batch while the run goes (`RowWriter`), so the
 * list fills as places are found, and a row is filled in when its website
 * check ends. The job's `saved` count grows with every batch.
 *
 * `onProgress` sees every update as well. Returns null when the job is not
 * queued. When the runner throws, the job is failed, keeps the rows saved
 * before it, and the error is rethrown. Once `signal` is aborted the job ends
 * `cancelled`, keeping the rows saved so far (checked or not), even if the
 * runner finished first, and `CancelledError` is thrown.
 */
export async function runJob(
  store: JobStore,
  id: string,
  runner: Runner,
  onProgress: (p: ScrapeProgress) => void = () => {},
  signal: AbortSignal = new AbortController().signal,
): Promise<JobRun | null> {
  const job = store.get(id);
  if (!job || job.status !== "queued") return null;
  if (!tryUpdate(store, id, { status: "running" })) return null;

  let last: Progress = job.progress;
  // A progress write that fails (disk full, file locked) is dropped; the
  // next one or the final write carries the state. runScrape also swallows
  // listener errors, so a failing write can never stop the run.
  // The searched place goes on the job when it changes (each city of a
  // several-city search), not into every progress write.
  let placed = "";
  const record = (update: ScrapeProgress) => {
    const { location, ...p } = update;
    last = p;
    const place =
      location && location.label !== placed ? { place: { name: location.name, type: location.addresstype, label: location.label } } : {};
    if (tryUpdate(store, id, { progress: p, ...place }) && location) placed = location.label;
    onProgress(update);
  };

  const rows = new RowWriter(store, id, store.readLeads(id).length);
  const cancelled = () => {
    rows.flush();
    const n = rows.kept.length;
    finish(store, id, { ...cancelledPatch(last), progress: { ...last, places: n, message: stoppedEarly(n) } });
  };

  let result: RunResult;
  try {
    result = await runner(job.options, record, signal, rows);
  } catch (e) {
    if (signal.aborted || e instanceof CancelledError) {
      cancelled();
      throw e instanceof CancelledError ? e : new CancelledError();
    }
    rows.flush();
    const cause = failureCause(e);
    debugLogFromEnv()("run_failed", { cause });
    finish(store, id, { status: "failed", progress: last, error: failureMessage(e), cause });
    throw e;
  }
  if (signal.aborted) {
    cancelled();
    throw new CancelledError();
  }

  // The saved rows are the result: added batch by batch, then filled in. A
  // runner that never handed rows over has them saved in one write here.
  if (rows.seen === 0) rows.added(result.leads);
  rows.flush();
  if (rows.error) {
    finish(store, id, { status: "failed", progress: last, error: rows.error });
    return { result, saveError: rows.error };
  }
  // A blocked search keeps the places read so far, but the list is not
  // complete, so the job fails with the blocked message (the CLI exits 1).
  const blocked = result.reason === "blocked";
  finish(store, id, {
    status: blocked ? "failed" : "done",
    progress: last,
    reconciliation: result.reconciliation,
    ...(result.keywords ? { keywords: result.keywords } : {}),
    reason: result.reason,
    ...(namesOnly(result.leads) ? { warning: NAMES_ONLY_WARNING } : {}),
    ...(blocked ? { error: BLOCKED_MESSAGE } : {}),
  });
  return { result };
}

/** What a search into an existing list produced. */
export type IntoRun = JobRun & {
  /** The places this search added to the list. */
  added: Lead[];
  /** Places the search found that the list already had. */
  alreadyInList: number;
  /** Places in the list afterwards. */
  total: number;
};

/**
 * Runs one more search into a finished list (`business-finder scrape --into`).
 * The list is held while the search runs (`JobStore.hold`), so it shows as
 * running and a second run is refused with `ListBusyError`. The places the
 * list does not have yet (the `ListIndex` rule, the same as `add --into`)
 * are appended batch by batch as the search finds them and filled in when
 * their websites are checked, the same way as `runJob`; the list's title,
 * place and options stay as they were, and its counts grow by this search's.
 *
 * Returns null when there is no such list. When the search throws, the list
 * gets its status back, keeps the places this search saved before it threw,
 * and the error is rethrown. A blocked search keeps the places read so far
 * and leaves the list's status as it was.
 */
export async function runInto(
  store: JobStore,
  id: string,
  options: RunOptions,
  runner: Runner,
  onProgress: (p: ScrapeProgress) => void = () => {},
): Promise<IntoRun | null> {
  const list = store.hold(id, { kind: "cli", pid: process.pid }, { stage: "geocoding", places: 0, message: "Waiting to start…" });
  if (!list) return null;
  const record = (update: ScrapeProgress) => {
    const { location: _location, ...p } = update;
    tryUpdate(store, id, { progress: p });
    onProgress(update);
  };

  const existing = store.readLeads(id);
  // Built at the first row, so a list with no rows yet reads its country from the search's own rows.
  let index: ListIndex | undefined;
  const accept = (lead: Lead) => {
    index ??= new ListIndex(existing, options.country ?? list.options.country ?? (countryFromLeads(existing) || countryFromLeads([lead])));
    if (index.match(leadCandidate(lead))) return false;
    index.add(leadCandidate(lead));
    return true;
  };
  const rows = new RowWriter(store, id, existing.length, accept);

  let result: RunResult;
  try {
    result = await runner(options, record, undefined, rows);
  } catch (e) {
    rows.flush();
    tryRelease(store, id);
    throw e;
  }

  if (rows.seen === 0) rows.added(result.leads);
  rows.flush();
  const added = rows.kept;
  const alreadyInList = rows.seen - added.length;
  if (rows.error) {
    tryRelease(store, id);
    return { result, added: [], alreadyInList, total: existing.length, saveError: rows.error };
  }

  const total = existing.length + added.length;
  const r = result.reconciliation;
  const n = added.length;
  try {
    store.release(id, {
      reconciliation: mergeCounts(list.reconciliation, r, n, alreadyInList),
      reason: result.reason,
      ...(namesOnly(result.leads) ? { warning: NAMES_ONLY_WARNING } : {}),
      progress: {
        stage: "done",
        places: total,
        message: `Added ${n} ${n === 1 ? "place" : "places"} for "${keywordsOf(options).join(", ")}" in ${citiesOf(options).join(", ")}.`,
      },
    });
  } catch {
    return { result, added, alreadyInList, total, saveError: "Could not update the list on this computer. Check free space and try again." };
  }
  return { result, added, alreadyInList, total };
}

/** The list's counts plus one search's; places the list already had count as duplicates, so the sums still balance. */
function mergeCounts(prev: Reconciliation | undefined, r: Reconciliation, added: number, alreadyInList: number): Reconciliation {
  const p = prev ?? { found: 0, kept: 0, filtered: 0, duplicates: 0, toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 };
  return {
    found: p.found + r.found,
    kept: p.kept + added,
    filtered: p.filtered + r.filtered,
    duplicates: p.duplicates + r.duplicates + alreadyInList,
    toCheck: p.toCheck + r.toCheck,
    fetched: p.fetched + r.fetched,
    unreachable: p.unreachable + r.unreachable,
    mismatched: p.mismatched + r.mismatched,
    skipped: p.skipped + r.skipped,
    ...((p.notChecked ?? 0) + (r.notChecked ?? 0) > 0 ? { notChecked: (p.notChecked ?? 0) + (r.notChecked ?? 0) } : {}),
  };
}
