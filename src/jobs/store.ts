// File-backed job state: one folder per job holding `job.json` (status,
// options, progress) and `leads.jsonl` (one lead per line). Files instead of
// a database keep the package free of native modules and the state readable.

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DataDirWriteError, formatWriteError, isFsError, UserFacingError } from "../core/errors.js";
import { classifyEmail } from "../core/enrich/emailType.js";
import { cleanStoredEmail } from "../core/enrich/extract.js";
import { addressWithoutTitle } from "../core/sources/browser/fields.js";
import type { CollectReason } from "../core/sources/source.js";
import type { EmailMxStatus, KeywordSummary, Lead, Progress, RunOptions, RunResult, Source } from "../core/types.js";

/**
 * `cancelled`: the user stopped the run. It keeps the rows it saved before
 * it stopped (`saved`), but it is not a complete search.
 */
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * The searched place's OpenStreetMap name and type, e.g. Bandaraya Melaka, city,
 * and its name with state and country for people (absent on older lists).
 */
export type JobPlace = { name: string; type: string; label?: string };

/**
 * The process running a job: a `business-finder serve` server or a `business-finder`
 * CLI command. A server starting up uses it to tell a job another process is
 * still running from one whose process has gone.
 */
export type JobOwner = { kind: "server" | "cli"; pid: number };

export type Job = {
  id: string;
  status: JobStatus;
  /** Absent on a job written before owners were recorded. */
  owner?: JobOwner;
  /** `web` for a list built from websites with `business-finder add --title`; absent for a Maps search. */
  source?: "maps" | "web";
  options: RunOptions;
  progress: Progress;
  /** Where the run searches, as OpenStreetMap names it; set once the place is looked up. */
  place?: JobPlace;
  reconciliation?: RunResult["reconciliation"];
  /** Per-keyword counts when more than one keyword was searched. */
  keywords?: KeywordSummary[];
  /** Plain-English reason the job failed, ready to show in the UI. */
  error?: string;
  /** Technical cause recorded on disk for diagnosis; never sent to or shown on the page. */
  cause?: string;
  /** Why the last search into this list stopped, e.g. `end-of-list` when Google Maps had no more places. */
  reason?: CollectReason;
  /** A plain-English warning about a run that still finished, e.g. Google returning names only. */
  warning?: string;
  /**
   * Set while a finished list is held to add rows to it (`scrape --into`,
   * `add --into`): the status and progress it goes back to afterwards.
   */
  held?: { status: JobStatus; progress: Progress };
  /**
   * Rows in `leads.jsonl`, written with every append. Rows are saved batch by
   * batch while a search runs, so this grows before the job ends. Absent on a
   * job written before it was recorded.
   */
  saved?: number;
  /** ISO 8601 time the job was created. */
  createdAt: string;
};

/** The file operations the store uses; replaceable so tests can simulate a crash. */
export type StoreFs = Pick<
  typeof nodeFs,
  | "appendFileSync"
  | "existsSync"
  | "mkdirSync"
  | "readFileSync"
  | "readdirSync"
  | "renameSync"
  | "rmSync"
  | "writeFileSync"
>;

export type StoreOptions = { fs?: StoreFs; now?: () => Date };

/** Job ids are UUIDs; anything else never reaches the filesystem. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isJobId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/**
 * True while process `pid` exists. Signal 0 checks without sending anything;
 * only `ESRCH` means the process is gone. `EPERM` means it exists but belongs
 * to another user, so it counts as alive.
 */
export function processAlive(pid: number, kill: (pid: number, signal: 0) => unknown = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The list is queued, running or already being added to, so rows cannot be added now. */
export class ListBusyError extends UserFacingError {
  override name = "ListBusyError";
}

export type CreateOptions = { owner?: JobOwner; source?: Job["source"] };

export const DATA_DIR_NAME = "business-finder";
export const LEGACY_DATA_DIR_NAME = "leadscout";
export const LEGACY_NOTICE_FILE = ".legacy-data-dir-noted";

function dataDirForName(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || path.win32.join(home, "AppData", "Local");
    return path.win32.join(local, name);
  }
  const data = env.XDG_DATA_HOME?.trim() || path.posix.join(home, ".local", "share");
  return path.posix.join(data, name);
}

/** `%LOCALAPPDATA%\leadscout` on Windows, `$XDG_DATA_HOME/leadscout` or `~/.local/share/leadscout` elsewhere. */
export function legacyDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return dataDirForName(LEGACY_DATA_DIR_NAME, env, platform, home);
}

/** `%LOCALAPPDATA%\business-finder` on Windows, `$XDG_DATA_HOME/business-finder` or `~/.local/share/business-finder` elsewhere. */
export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return dataDirForName(DATA_DIR_NAME, env, platform, home);
}

/** `<data dir>/jobs`: one folder per job. */
export function defaultJobsDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(defaultDataDir(env, platform, home), "jobs");
}

/** Ensures `dir` exists and is writable by creating and deleting a small probe file. Throws `DataDirWriteError`. */
export function ensureWritableDir(
  dir: string,
  fs: Pick<typeof nodeFs, "mkdirSync" | "writeFileSync" | "rmSync"> = nodeFs,
): void {
  const probe = path.join(dir, `.write-test-${process.pid}-${randomUUID()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "", "utf8");
  } catch (e) {
    throw new DataDirWriteError(formatWriteError(dir, e));
  } finally {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      // Best-effort cleanup if the probe was created.
    }
  }
}

export type MigrateFs = Pick<
  typeof nodeFs,
  "copyFileSync" | "existsSync" | "mkdirSync" | "readdirSync" | "readFileSync" | "renameSync" | "rmSync" | "statSync" | "writeFileSync"
>;

export type MigrateDataDirOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  fs?: MigrateFs;
  isServerAlive?: (record: ServerRecord) => Promise<boolean>;
};

export type MigrateDataDirResult =
  | { outcome: "none" }
  | { outcome: "only_new" }
  | { outcome: "migrated"; from: string; to: string }
  | { outcome: "both_kept_new"; oldDir: string; newDir: string; message?: string }
  | { outcome: "old_server_running"; oldDir: string; newDir: string; message: string }
  | { outcome: "installer_managed"; oldDir: string; newDir: string; message: string };

/** Thrown when migration must wait for an active legacy server or installer upgrade before continuing. */
export class MigrationBlockedError extends UserFacingError {
  override name = "MigrationBlockedError";
}

function renameDirWithRetries(fs: MigrateFs, from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < RENAME_RETRIES) {
        pause(10 * attempt);
        continue;
      }
      throw e;
    }
  }
}

function copyTree(fs: MigrateFs, src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    const dstPath = path.join(dst, name);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyTree(fs, srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function verifyTree(fs: MigrateFs, src: string, dst: string): void {
  if (!fs.existsSync(dst)) throw new Error(`Missing copied folder ${dst}`);
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    const dstPath = path.join(dst, name);
    const srcStat = fs.statSync(srcPath);
    const dstStat = fs.statSync(dstPath);
    if (srcStat.isDirectory()) {
      if (!dstStat.isDirectory()) throw new Error(`Expected directory at ${dstPath}`);
      verifyTree(fs, srcPath, dstPath);
    } else if (dstStat.size !== srcStat.size) {
      throw new Error(`Size mismatch for ${dstPath}`);
    }
  }
}

/**
 * Migrates the legacy `leadscout` data folder to `business-finder` on first run:
 * - only old exists: moves it in one atomic rename (or verified staging copy + atomic rename on EXDEV);
 * - both exist: uses the new folder, leaves the old folder untouched, and returns a one-time notice;
 * - only new or neither exists: no-op.
 */
export async function migrateDataDir(opts: MigrateDataDirOptions = {}): Promise<MigrateDataDirResult> {
  const fs = opts.fs ?? nodeFs;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const oldDir = legacyDataDir(env, platform, home);
  const newDir = defaultDataDir(env, platform, home);

  const oldExists = fs.existsSync(oldDir);
  const newExists = fs.existsSync(newDir);
  if (!oldExists && !newExists) return { outcome: "none" };
  if (!oldExists && newExists) return { outcome: "only_new" };
  if (oldExists && newExists) {
    const noticePath = path.join(newDir, LEGACY_NOTICE_FILE);
    let message: string | undefined;
    if (!fs.existsSync(noticePath)) {
      message = `Found an older leadscout data folder (${oldDir}); using ${newDir} and leaving the old folder alone.`;
      try {
        fs.writeFileSync(noticePath, `${new Date().toISOString()}\n`, "utf8");
      } catch {
        // Best effort: if the folder is read-only, still return the message.
      }
    }
    return message ? { outcome: "both_kept_new", oldDir, newDir, message } : { outcome: "both_kept_new", oldDir, newDir };
  }

  const running = await liveServerRecord(oldDir, fs, opts.isServerAlive);
  if (running) {
    return {
      outcome: "old_server_running",
      oldDir,
      newDir,
      message: "An older version is still running. Close it (or re-run the installer), then try again.",
    };
  }

  if (fs.existsSync(path.join(oldDir, "app"))) {
    return {
      outcome: "installer_managed",
      oldDir,
      newDir,
      message: `Found an older installer-managed leadscout folder (${oldDir}); re-run the installer to migrate it without breaking the existing command.`,
    };
  }

  try {
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    try {
      renameDirWithRetries(fs, oldDir, newDir);
      return { outcome: "migrated", from: oldDir, to: newDir };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      const staging = `${newDir}.migrating-${process.pid}-${randomUUID()}`;
      try {
        copyTree(fs, oldDir, staging);
        verifyTree(fs, oldDir, staging);
        renameDirWithRetries(fs, staging, newDir);
        return { outcome: "migrated", from: oldDir, to: newDir };
      } catch (copyErr) {
        try {
          fs.rmSync(staging, { recursive: true, force: true });
        } catch {
          // Ignore staging cleanup failure; oldDir remains intact.
        }
        throw copyErr;
      }
    }
  } catch (e) {
    throw e instanceof DataDirWriteError ? e : new DataDirWriteError(formatWriteError(newDir, e));
  }
}

/** `<data dir>/server.json`: the port of the running `business-finder serve`, so a CLI run can link to it. */
export const SERVER_FILE = "server.json";

export type ServerRecord = { pid: number; port: number };

/** Records the running server; a failed write only loses the link the CLI prints. */
export function writeServerRecord(dataDir: string, record: ServerRecord): void {
  try {
    nodeFs.mkdirSync(dataDir, { recursive: true });
    nodeFs.writeFileSync(path.join(dataDir, SERVER_FILE), JSON.stringify(record), "utf8");
  } catch {
    // Without the file the CLI says to run `business-finder serve` instead of linking.
  }
}

/** The recorded server, or null when there is none or the file is unreadable. */
export function readServerRecord(
  dataDir: string,
  fs: Pick<typeof nodeFs, "readFileSync"> = nodeFs,
): ServerRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dataDir, SERVER_FILE), "utf8")) as Partial<ServerRecord>;
    return Number.isInteger(r.pid) && Number.isInteger(r.port) ? { pid: r.pid!, port: r.port! } : null;
  } catch {
    return null;
  }
}

/** True when `record` names a live server whose `/api/v1/health` responds with matching `pid`. */
export async function probeServerHealth(record: ServerRecord): Promise<boolean> {
  if (!processAlive(record.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${record.port}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { ok?: unknown; pid?: unknown };
    return res.ok && body.ok === true && body.pid === record.pid;
  } catch {
    return false;
  }
}

/** Returns the recorded server only while it is alive and answers `/api/v1/health` with the same PID. */
export async function liveServerRecord(
  dataDir: string,
  fs: Pick<typeof nodeFs, "readFileSync"> = nodeFs,
  isAlive: (record: ServerRecord) => Promise<boolean> = probeServerHealth,
): Promise<ServerRecord | null> {
  const record = readServerRecord(dataDir, fs);
  if (!record) return null;
  return (await isAlive(record)) ? record : null;
}

/** Removes the record if it still names process `pid`; another server's record is left alone. */
export function clearServerRecord(dataDir: string, pid: number): void {
  if (readServerRecord(dataDir)?.pid !== pid) return;
  try {
    nodeFs.rmSync(path.join(dataDir, SERVER_FILE), { force: true });
  } catch {
    // A stale record is checked against the pid and the health route before use.
  }
}

const RENAME_RETRIES = 5;

/** Blocks the thread briefly; used only between rename retries. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class JobStore {
  readonly dir: string;
  private readonly fs: StoreFs;
  private readonly now: () => Date;

  constructor(dir: string = defaultJobsDir(), options: StoreOptions = {}) {
    this.dir = path.resolve(dir);
    this.fs = options.fs ?? nodeFs;
    this.now = options.now ?? (() => new Date());
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
    } catch (e) {
      if (isFsError(e)) throw new DataDirWriteError(formatWriteError(this.dir, e));
      throw e;
    }
  }

  create(options: RunOptions, extra: CreateOptions = {}): Job {
    const id = randomUUID();
    const job: Job = {
      id,
      status: "queued",
      ...(extra.owner ? { owner: extra.owner } : {}),
      ...(extra.source ? { source: extra.source } : {}),
      options,
      progress: { stage: "geocoding", places: 0, message: "Waiting to start…" },
      createdAt: this.now().toISOString(),
    };
    this.fs.mkdirSync(this.jobDir(id), { recursive: true });
    this.writeJob(job);
    return job;
  }

  get(id: string): Job | null {
    if (!isJobId(id)) return null;
    try {
      const job = JSON.parse(this.fs.readFileSync(this.jobFile(id), "utf8")) as Job;
      return job.id === id ? job : null;
    } catch {
      return null;
    }
  }

  /** Every readable job, newest first. */
  list(): Job[] {
    let names: string[];
    try {
      names = this.fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .map((name) => this.get(name))
      .filter((job): job is Job => job !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Merges `patch` into the job and writes it atomically; `id` and `createdAt` never change. */
  update(id: string, patch: Partial<Job>): Job {
    const current = this.get(id);
    if (!current) throw new Error(`No job ${JSON.stringify(id)}`);
    const next: Job = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
    this.writeJob(next);
    return next;
  }

  /**
   * Adds leads to `leads.jsonl` in one write, whole lines only, one JSON
   * object per line, then records the new row count on the job (`saved`).
   * A failed count write is dropped: the rows are what count, and the next
   * append writes it again.
   *
   * A file that ends in a line cut short by a crash (no trailing newline)
   * gets a newline first, so the cut line stays on its own line, `readLeads`
   * skips it as before, and the new rows keep the positions `RowWriter` and
   * `replaceLeads` count them at.
   */
  appendLeads(id: string, leads: Lead[]): void {
    if (!this.get(id)) throw new Error(`No job ${JSON.stringify(id)}`);
    if (leads.length === 0) return;
    const file = this.leadsFile(id);
    let current = "";
    try {
      current = this.fs.readFileSync(file, "utf8");
    } catch {
      // No file yet: the first append creates it.
    }
    const cut = current.length > 0 && !current.endsWith("\n");
    this.fs.appendFileSync(file, `${cut ? "\n" : ""}${toLines(leads)}`, "utf8");
    try {
      this.update(id, { saved: this.readRawLeads(id).length });
    } catch {
      // `saved` is a count for the page; the rows themselves are written.
    }
  }

  /**
   * Replaces rows in place by their position in `readLeads` order: row `n`
   * becomes `rows.get(n)`. Used when a row saved during a search is filled
   * in by its website check. The whole file is written to a temporary name
   * and renamed over `leads.jsonl`, so a reader sees either the old rows or
   * the new ones, never a half-written line and never a row twice. A line
   * cut short by a crash is dropped, which keeps positions the same as
   * `readLeads`. Positions past the end are ignored.
   */
  replaceLeads(id: string, rows: ReadonlyMap<number, Lead>): void {
    if (!this.get(id)) throw new Error(`No job ${JSON.stringify(id)}`);
    if (rows.size === 0) return;
    const leads = this.readRawLeads(id);
    let changed = false;
    for (const [n, lead] of rows) {
      if (!Number.isInteger(n) || n < 0 || n >= leads.length) continue;
      leads[n] = lead;
      changed = true;
    }
    if (changed) this.writeAtomic(this.leadsFile(id), toLines(leads));
  }

  /** The job's leads in write order, cleaned at read time without rewriting disk. */
  readLeads(id: string): Lead[] {
    return this.readRawLeads(id).map(cleanLead);
  }

  /** The raw JSONL rows as saved on disk. A line cut short by a crash is skipped. */
  private readRawLeads(id: string): Lead[] {
    if (!isJobId(id)) return [];
    let text: string;
    try {
      text = this.fs.readFileSync(this.leadsFile(id), "utf8");
    } catch {
      return [];
    }
    const leads: Lead[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        leads.push(JSON.parse(line) as Lead);
      } catch {
        // A partial line from an interrupted append.
      }
    }
    return leads;
  }

  /**
   * Holds a finished list while rows are added to it: the list shows as
   * `running`, owned by `owner`, the same way a running search does, so a
   * second run, the server and the web page all see it is busy. Returns null
   * when there is no such list; throws `ListBusyError` when it is queued,
   * running or held by a live process. A hold whose process has gone is taken
   * over, keeping the status the list had before it.
   *
   * The check and the write happen under an exclusive lock file, so two
   * processes cannot both take the list.
   */
  hold(id: string, owner: JobOwner, progress: Progress): Job | null {
    if (!this.get(id)) return null;
    const busy = () => new ListBusyError(`List ${id} is still running. Wait for it to finish, then add to it.`);
    if (!this.lock(id)) throw busy();
    try {
      const job = this.get(id);
      if (!job) return null;
      let held: NonNullable<Job["held"]>;
      if (job.status === "queued" || job.status === "running") {
        const stale = job.held && !(job.owner && processAlive(job.owner.pid));
        if (!stale) throw busy();
        held = job.held!;
      } else {
        held = { status: job.status, progress: job.progress };
      }
      return this.update(id, { status: "running", owner, progress, held });
    } finally {
      this.unlock(id);
    }
  }

  /** Ends a hold: the list gets back the status and progress it had, then `patch` on top. */
  release(id: string, patch: Partial<Job> = {}): Job {
    const job = this.get(id);
    if (!job) throw new Error(`No job ${JSON.stringify(id)}`);
    const back = job.held ? { status: job.held.status, progress: job.held.progress } : {};
    return this.update(id, { ...back, ...patch, held: undefined });
  }

  /** Takes `hold.lock`; false while a live process has it. A lock left by a process that has gone is replaced. */
  private lock(id: string): boolean {
    const file = path.join(this.jobDir(id), "hold.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.fs.writeFileSync(file, String(process.pid), { encoding: "utf8", flag: "wx" });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let pid = NaN;
      try {
        pid = Number(this.fs.readFileSync(file, "utf8"));
      } catch {
        // Removed between the two calls: try again.
      }
      if (processAlive(pid)) return false;
      this.fs.rmSync(file, { force: true });
    }
    return false;
  }

  private unlock(id: string): void {
    try {
      this.fs.rmSync(path.join(this.jobDir(id), "hold.lock"), { force: true });
    } catch {
      // A lock left behind names this process; once it has gone the lock is replaced.
    }
  }

  /** Removes the job's folder; false when there was no such job. */
  delete(id: string): boolean {
    if (!isJobId(id) || !this.fs.existsSync(this.jobDir(id))) return false;
    this.fs.rmSync(this.jobDir(id), { recursive: true, force: true });
    return true;
  }

  private jobDir(id: string): string {
    if (!isJobId(id)) throw new Error(`Invalid job id ${JSON.stringify(id)}`);
    return path.join(this.dir, id);
  }

  private jobFile(id: string): string {
    return path.join(this.jobDir(id), "job.json");
  }

  private leadsFile(id: string): string {
    return path.join(this.jobDir(id), "leads.jsonl");
  }

  private writeJob(job: Job): void {
    this.writeAtomic(this.jobFile(job.id), JSON.stringify(job, null, 2));
  }

  /**
   * Writes the whole file to a temporary name, then renames it over `file`
   * (`job.json` or `leads.jsonl`), so a reader or a crash never leaves a
   * half-written file. Windows refuses the rename while another handle has
   * the file open, so a busy rename is retried a few times.
   */
  private writeAtomic(file: string, text: string): void {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    this.fs.writeFileSync(temp, text, "utf8");
    for (let attempt = 1; ; attempt++) {
      try {
        this.fs.renameSync(temp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < RENAME_RETRIES) {
          pause(10 * attempt);
          continue;
        }
        try {
          this.fs.rmSync(temp, { force: true });
        } catch {
          // The temp file is ignored by readers; leaving it behind is harmless.
        }
        throw e;
      }
    }
  }
}

/** Whole JSONL lines, one lead per line, each ending in a newline. */
function toLines(leads: readonly Lead[]): string {
  return leads.map((l) => `${JSON.stringify(l)}\n`).join("");
}

/**
 * Applies the current address and email rules to a stored lead at read time,
 * leaving the row on disk untouched. Dropped or trimmed emails update
 * `sources`, `email_source_url` and `email_status` to stay consistent.
 */
function cleanLead(lead: Lead): Lead {
  const address = lead.address ? addressWithoutTitle(lead.address, lead.title ?? "") : lead.address;
  const fallbackUrl = lead.email_source_url || lead.website;
  const rawEmails = Array.isArray(lead.emails) ? lead.emails : [];
  const rawMx = Array.isArray(lead.email_mx) ? lead.email_mx : null;
  const emails: string[] = [];
  const email_mx: EmailMxStatus[] | undefined = rawMx ? [] : undefined;
  rawEmails.forEach((raw, index) => {
    const key = raw.trim().toLowerCase();
    const sourceUrl = lead.sources?.find((s) => s.field === "email" && s.value.trim().toLowerCase() === key)?.url;
    const cleaned = cleanStoredEmail(raw, sourceUrl || fallbackUrl);
    if (cleaned && !emails.includes(cleaned)) {
      emails.push(cleaned);
      if (email_mx && rawMx) email_mx.push(rawMx[index] ?? "unknown");
    }
  });
  const email_types = emails.map(classifyEmail);

  let sources: Source[] | undefined = lead.sources;
  if (lead.sources !== undefined) {
    const seenEmails = new Set<string>();
    const nextSources: Source[] = [];
    for (const s of lead.sources) {
      if (s.field !== "email") {
        nextSources.push(s);
        continue;
      }
      const cleaned = cleanStoredEmail(s.value, s.url || fallbackUrl);
      if (!cleaned || seenEmails.has(cleaned)) continue;
      seenEmails.add(cleaned);
      nextSources.push(cleaned === s.value ? s : { ...s, value: cleaned });
    }
    sources = nextSources;
  }

  const email_source_url = emails.length === 0
    ? ""
    : (sources?.find((s) => s.field === "email" && s.value === emails[0])?.url || lead.email_source_url);
  const email_status = rawEmails.length > 0 && emails.length === 0 && lead.email_status === "found"
    ? "not_on_site"
    : lead.email_status;

  return {
    ...lead,
    ...(address !== undefined ? { address } : {}),
    emails,
    email_types,
    ...(email_mx !== undefined ? { email_mx } : {}),
    email_source_url,
    email_status,
    ...(sources !== undefined ? { sources } : {}),
  };
}
