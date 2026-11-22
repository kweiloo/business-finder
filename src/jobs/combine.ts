// A search's runs combined into one list when it is read. Nothing here
// writes: every run keeps its own files, so a combining rule that turns out
// wrong can be changed and the list read again, with nothing lost.

import { toE164 } from "../core/leads/phone.js";
import type { Lead } from "../core/types.js";
import { countryFromLeads, leadCandidate, ListIndex, nameKey, siteHost } from "./dedupe.js";
import { groupOf, groupRuns, listedJob, type RunGroup } from "./lists.js";
import type { Job, JobStore } from "./store.js";

/**
 * Which business a row is, in the order of `dedupe.ts`'s rule: the same
 * Google place, else the same website, else the same phone and name. A row
 * with none of these is known by its name. The key reads only the row and the
 * country, so it stays the same however often the list is read; a marker kept
 * per business (such as "contacted") can be stored against it. A combined
 * business is known by the key of the first row seen for it: `combineRuns`
 * matches rows with `ListIndex`, so a later row can join it through any key
 * it shares (a data id alone, or a website when one side has no id).
 */
export function businessKey(lead: Pick<Lead, "title" | "website" | "phone" | "place_id" | "data_id">, country = ""): string {
  if (lead.place_id) return `place_id:${lead.place_id}`;
  if (lead.data_id) return `data_id:${lead.data_id}`;
  const host = siteHost(lead.website);
  if (host) return `site:${host}`;
  const name = nameKey(lead.title ?? "");
  const phone = lead.phone ? toE164(lead.phone, country) : null;
  return phone ? `phone:${phone}|${name}` : `name:${name}`;
}

/** A combined row: the business as its newest run saw it, and what the runs say about it. */
export type CombinedLead = Lead & {
  /** When the run that first found it was started (ISO 8601). */
  first_seen: string;
  /** First found by the newest finished run, and not by any earlier one. */
  new: boolean;
  /** Found before, but not by the newest run, which read Google's results to the end. */
  not_found_last_time: boolean;
};

export type CombinedList = {
  rows: CombinedLead[];
  /** How many runs the list combines. */
  runs: number;
  /**
   * The newest finished run with rows (done, cancelled, or failed) that the
   * markers are judged against; null when no run has finished with rows yet.
   */
  latest: Job | null;
  /** Start times of all finished runs with rows, oldest first, so the UI can tell whether runs share one day. */
  runDates: string[];
  /** Rows marked new. */
  fresh: number;
  /** Rows marked not found last time. */
  missing: number;
};

export type RunRows = { job: Job; leads: Lead[] };

// Filled in by the website check. A row the newest run saved before checking
// its website keeps an older run's checked values, so a re-run in progress or
// a cancelled one never blanks emails that were found before.
const CHECKED_FIELDS = [
  "emails",
  "email_types",
  "email_mx",
  "email_source_url",
  "email_status",
  "website_status",
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube",
  "x",
  "sources",
] as const;

const unchecked = (l: Lead) => l.email_status === "not_checked" || l.website_status === "not_checked";

function newer(older: Lead, next: Lead): Lead {
  if (!unchecked(next) || unchecked(older)) return next;
  const kept = Object.fromEntries(CHECKED_FIELDS.filter((f) => Object.hasOwn(older, f)).map((f) => [f, older[f]]));
  return { ...next, ...kept };
}

const finishedWithRows = (r: RunRows) =>
  r.leads.length > 0 && (r.job.status === "done" || r.job.status === "cancelled" || r.job.status === "failed");

/** Only a search that finished and read Google's results to the end with places can say a place is gone. */
const readToEnd = (r: RunRows) => r.job.status === "done" && r.job.reason === "end-of-list" && r.leads.length > 0;

/**
 * One row per business across the runs of one search (each run's rows
 * already cleaned by `JobStore.readLeads`), in the order businesses were
 * first found, each with its newest run's values.
 */
export function combineRuns(runs: readonly RunRows[]): CombinedList {
  const ordered = runs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Date.parse(a.r.job.createdAt) - Date.parse(b.r.job.createdAt) || b.i - a.i)
    .map(({ r }) => r);
  const country = ordered.find((r) => r.job.options.country)?.job.options.country ?? countryFromLeads(ordered.flatMap((r) => r.leads));
  let latest = -1;
  ordered.forEach((r, i) => {
    if (finishedWithRows(r)) latest = i;
  });

  // One business per entry, matched with dedupe.ts's own rule (`ListIndex`):
  // the same place id or data id, else, when either row has no id, the same
  // website or the same phone and name. Every row a business was seen with is
  // remembered, so a later row can match on any of its keys.
  type Entry = { lead: Lead; first: number; seen: Set<number> };
  const entries: Entry[] = [];
  const index = new ListIndex([], country);
  const owner: Entry[] = [];
  ordered.forEach((run, i) => {
    for (const lead of run.leads) {
      const candidate = leadCandidate(lead);
      // A business already met in this run is passed over: two rows of one
      // run that match were both let in by dedupe.ts, so both are kept.
      const found = index.find(candidate, (at) => !owner[at]!.seen.has(i));
      const entry = found ? owner[found.at]! : undefined;
      if (!entry) {
        const fresh: Entry = { lead, first: i, seen: new Set([i]) };
        entries.push(fresh);
        index.add(candidate);
        owner.push(fresh);
        continue;
      }
      entry.lead = newer(entry.lead, lead);
      entry.seen.add(i);
      index.add(candidate);
      owner.push(entry);
    }
  });

  const marks = latest > 0 && ordered.slice(0, latest).some((r) => r.leads.length > 0);
  const proves = marks && readToEnd(ordered[latest]!);
  const rows = entries.map(({ lead, first, seen }) => ({
    ...lead,
    first_seen: ordered[first]!.job.createdAt,
    new: marks && first === latest,
    not_found_last_time: proves && first < latest && ![...seen].some((i) => i >= latest),
  }));
  return {
    rows,
    runs: ordered.length,
    latest: latest >= 0 ? ordered[latest]!.job : null,
    runDates: ordered.filter(finishedWithRows).map((r) => r.job.createdAt),
    fresh: rows.filter((r) => r.new).length,
    missing: rows.filter((r) => r.not_found_last_time).length,
  };
}

const readGroup = (store: JobStore, group: RunGroup<Job>) =>
  combineRuns(group.runs.map((job) => ({ job, leads: store.readLeads(job.id) })));

/** The list run `id` belongs to, combined; null when there is no such job. */
export function readList(store: JobStore, id: string): { group: RunGroup<Job>; list: CombinedList } | null {
  const group = groupOf(store.list(), id);
  return group ? { group, list: readGroup(store, group) } : null;
}

/** A saved list as the rail and `business-finder lists` show it: the run it follows, plus the combined counts. */
export type ListSummary = Job & {
  title: string;
  /** How many runs the list combines. */
  runs: number;
  /** Places in the combined list. */
  count: number;
  /** Places marked new. */
  fresh: number;
  /** When the newest run was started (ISO 8601). */
  lastRun: string;
};

/** Every saved list, one per search, newest first. */
export function listSummaries(store: JobStore): ListSummary[] {
  return groupRuns(store.list()).map((group) => {
    const list = readGroup(store, group);
    return {
      ...listedJob(group),
      runs: group.runs.length,
      count: list.rows.length,
      fresh: list.fresh,
      lastRun: group.runs[0]!.createdAt,
    };
  });
}
