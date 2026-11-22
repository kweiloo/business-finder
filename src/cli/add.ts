// `business-finder add`: businesses an agent found with its own web search, handed
// in as a CSV or JSONL file of names and websites. Each website goes through
// the same enrichment as a Maps scrape, and the leads are saved as a new list
// or appended to an existing one. Like the rest of the CLI it prints counts,
// line numbers and ids only, never a value read from the file or a website.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { enrichLeads, EnrichCounts } from "../core/enrich/enrich.js";
import { UserFacingError } from "../core/errors.js";
import { toLead } from "../core/leads/normalize.js";
import type { Lead, RawPlace, Reconciliation, RunOptions } from "../core/types.js";
import { countryFromLeads, ListIndex } from "../jobs/dedupe.js";
import { ListBusyError, type Job, type JobStore } from "../jobs/store.js";

export { countryFromLeads, siteHost } from "../jobs/dedupe.js";

/** The file or the target list cannot be used, so nothing was saved: exit 2. */
export class AddInputError extends UserFacingError {
  override name = "AddInputError";
}

/** One business from the file, checked. */
export type WebEntry = { line: number; name: string; website: string; phone?: string; city?: string; note?: string };

/** A line that was not used, and why; the reason never quotes the line. */
export type SkippedLine = { line: number; reason: string };

export type ParsedFile = { entries: WebEntry[]; skipped: SkippedLine[] };

const COLUMNS = ["name", "website", "phone", "city", "note"] as const;
type Column = (typeof COLUMNS)[number];

/**
 * Splits CSV text into records (RFC 4180: quoted fields may hold commas,
 * quotes as `""` and line breaks). Each record carries the line it starts on.
 */
export function parseCsvRecords(text: string): { line: number; fields: string[] }[] {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let any = false;
  const endRecord = () => {
    fields.push(field);
    if (any || fields.length > 1 || field !== "") records.push({ line: start, fields });
    fields = [];
    field = "";
    any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      any = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
      any = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      start = line;
    } else {
      field += c;
    }
  }
  if (field !== "" || fields.length > 0 || any) endRecord();
  return records;
}

/** Checks one business; returns why it is not usable, or the entry. */
function checkEntry(line: number, raw: Partial<Record<Column, unknown>>): WebEntry | SkippedLine {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const name = text(raw.name);
  if (!name) return { line, reason: "no name" };
  const website = text(raw.website);
  if (!website) return { line, reason: "no website" };
  let url: URL;
  try {
    url = new URL(website);
  } catch {
    return { line, reason: "the website is not a full http:// or https:// address" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { line, reason: "the website must start with http:// or https://" };
  }
  if (!url.hostname) return { line, reason: "the website has no host name" };
  const entry: WebEntry = { line, name, website };
  for (const key of ["phone", "city", "note"] as const) {
    const value = text(raw[key]);
    if (value) entry[key] = value;
  }
  return entry;
}

function isEntry(v: WebEntry | SkippedLine): v is WebEntry {
  return "name" in v;
}

/** Reads a CSV (with a header row) or JSONL file of businesses. Throws `UserFacingError` for a file it cannot use at all. */
export function parseWebFile(text: string, format: "csv" | "jsonl"): ParsedFile {
  const body = text.replace(/^﻿/, "");
  const results: (WebEntry | SkippedLine)[] = [];
  if (format === "csv") {
    const [header, ...rows] = parseCsvRecords(body);
    if (!header) throw new AddInputError("The file is empty.");
    const names = header.fields.map((f) => f.trim().toLowerCase());
    for (const required of ["name", "website"]) {
      if (!names.includes(required)) throw new AddInputError(`The CSV header has no "${required}" column.`);
    }
    for (const row of rows) {
      const raw: Partial<Record<Column, string>> = {};
      names.forEach((n, i) => {
        if ((COLUMNS as readonly string[]).includes(n)) raw[n as Column] = row.fields[i];
      });
      results.push(checkEntry(row.line, raw));
    }
  } else {
    body.split("\n").forEach((rawLine, i) => {
      if (!rawLine.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(rawLine);
      } catch {
        results.push({ line: i + 1, reason: "not valid JSON" });
        return;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        results.push({ line: i + 1, reason: "not a JSON object" });
        return;
      }
      results.push(checkEntry(i + 1, value as Partial<Record<Column, unknown>>));
    });
  }
  return { entries: results.filter(isEntry), skipped: results.filter((r): r is SkippedLine => !isEntry(r)) };
}

/** The file's format from its extension; null for anything else. */
export function webFileFormat(file: string): "csv" | "jsonl" | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".jsonl" || ext === ".ndjson") return "jsonl";
  return null;
}

/** Reads and checks the file; throws `UserFacingError` when it is missing or has no usable line. */
export async function readWebFile(file: string): Promise<ParsedFile> {
  const format = webFileFormat(file);
  if (!format) throw new AddInputError(`The file must end in .csv or .jsonl, got ${path.basename(file)}.`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    throw new AddInputError(`Could not read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  const parsed = parseWebFile(text, format);
  if (parsed.entries.length === 0) {
    throw new AddInputError(`No usable line in ${file}: each line needs a name and an http:// or https:// website.`);
  }
  return parsed;
}

/** Splits entries into new ones and ones already in the list (see `ListIndex`), earlier lines first. */
export function dedupeEntries(
  entries: WebEntry[],
  existing: Lead[],
  country: string,
): { fresh: WebEntry[]; duplicates: SkippedLine[] } {
  const index = new ListIndex(existing, country);
  const fresh: WebEntry[] = [];
  const duplicates: SkippedLine[] = [];
  for (const entry of entries) {
    const candidate = { name: entry.name, website: entry.website, ...(entry.phone ? { phone: entry.phone } : {}) };
    const reason = index.match(candidate);
    if (reason) {
      duplicates.push({ line: entry.line, reason: `already in the list (${reason})` });
      continue;
    }
    index.add(candidate);
    fresh.push(entry);
  }
  return { fresh, duplicates };
}

/** A lead for one web entry, before enrichment. */
export function webLead(entry: WebEntry, query: string, country: string, fetchedAt: string): Lead {
  const raw: RawPlace = { title: entry.name, website: entry.website, source: "web", query, city: entry.city ?? "" };
  if (entry.phone) raw.phone = entry.phone;
  const lead = toLead(raw, country, fetchedAt);
  return entry.note ? { ...lead, note: entry.note } : lead;
}

export type AddTarget = { title: string } | { into: string };

export type AddOptions = {
  target: AddTarget;
  /** Two-letter country for phone numbers; else the list's, else its leads'. */
  country?: string;
  socials: boolean;
};

export type AddDeps = {
  store: JobStore;
  enrich: typeof enrichLeads;
  now: () => Date;
  onProgress: (p: { checked: number; toCheck: number }) => void;
};

export type AddResult = {
  job: Job;
  /** The leads added by this run, after enrichment. */
  added: Lead[];
  duplicates: SkippedLine[];
  counts: EnrichCounts;
};

/** The list options for a new web list: the title is the keyword, there is no city. */
export function webListOptions(title: string, opts: AddOptions): RunOptions {
  return {
    keyword: title,
    city: "",
    depth: 1,
    lang: "en",
    emails: true,
    socials: opts.socials,
    deep: true,
    maxSeconds: 600,
    ...(opts.country ? { country: opts.country } : {}),
  };
}

function addCounts(prev: Reconciliation | undefined, found: number, kept: number, duplicates: number, c: EnrichCounts): Reconciliation {
  const p = prev ?? { found: 0, kept: 0, filtered: 0, duplicates: 0, toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 };
  return {
    found: p.found + found,
    kept: p.kept + kept,
    filtered: p.filtered,
    duplicates: p.duplicates + duplicates,
    toCheck: p.toCheck + c.toCheck,
    fetched: p.fetched + c.fetched,
    unreachable: p.unreachable + c.unreachable,
    mismatched: p.mismatched + c.mismatched,
    skipped: p.skipped + c.skipped,
  };
}

/**
 * Enriches the entries and saves them. A new list is created only after the
 * file has been checked, is `running` while the websites are read and `done`
 * at the end. An existing list must have finished; it is held (shown as
 * `running`) while the websites are read, so a second run cannot add the
 * same sites, and gets its status back once the new leads are appended.
 */
export async function addToList(entries: WebEntry[], opts: AddOptions, deps: AddDeps): Promise<AddResult> {
  const { store } = deps;
  let job: Job;
  let existing: Lead[] = [];
  let country = opts.country ?? "";
  if ("into" in opts.target) {
    let found: Job | null;
    try {
      found = store.hold(opts.target.into, { kind: "cli", pid: process.pid }, { stage: "checking_websites", places: 0, message: "Checking websites…" });
    } catch (e) {
      throw e instanceof ListBusyError ? new AddInputError(e.message) : e;
    }
    if (!found) throw new AddInputError(`No list ${opts.target.into} in ${store.dir}.`);
    job = found;
    existing = store.readLeads(job.id);
    country ||= job.options.country ?? countryFromLeads(existing);
  } else {
    job = store.create(webListOptions(opts.target.title, opts), { owner: { kind: "cli", pid: process.pid }, source: "web" });
    store.update(job.id, { status: "running", progress: { stage: "checking_websites", places: 0, message: "Checking websites…" } });
  }

  const { fresh, duplicates } = dedupeEntries(entries, existing, country);
  const fetchedAt = deps.now().toISOString();
  const leads = fresh.map((e) => webLead(e, job.options.keyword, country, fetchedAt));
  const places = existing.length + leads.length;
  const isNew = !("into" in opts.target);
  const end = (patch: Partial<Job>): Job => (isNew ? store.update(job.id, patch) : store.release(job.id, patch));

  let enriched: Awaited<ReturnType<typeof enrichLeads>>;
  try {
    enriched = await deps.enrich(leads, { emails: true, socials: opts.socials, deep: true, country }, (p) => {
      deps.onProgress(p);
      try {
        store.update(job.id, {
          progress: { stage: "checking_websites", places, checked: p.checked, toCheck: p.toCheck, message: `Checking websites… ${p.checked}/${p.toCheck}` },
        });
      } catch {
        // A dropped progress write is carried by the next one or the final write.
      }
    });
    store.appendLeads(job.id, enriched.leads);
  } catch (e) {
    try {
      if (isNew) store.update(job.id, { status: "failed", error: `Could not add the websites: ${(e as Error).message}` });
      else store.release(job.id);
    } catch {
      // The list stays held; the next start-up or add puts it back.
    }
    throw e;
  }

  const n = enriched.leads.length;
  const reconciliation = addCounts(job.reconciliation, entries.length, n, duplicates.length, enriched.counts);
  const message = `Added ${n} ${n === 1 ? "website" : "websites"}.`;
  const done = end({
    reconciliation,
    ...(isNew ? { status: "done" as const, progress: { stage: "done" as const, places, message } } : {}),
  });
  return { job: done, added: enriched.leads, duplicates, counts: enriched.counts };
}
