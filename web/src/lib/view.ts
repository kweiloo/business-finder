// Which state the open list is in, and the plain words its header shows.

import { keywordsOf } from "../../../src/core/keywords.js";
import { usesWholeCityGrid } from "../../../src/core/searchSize.js";
import type { Job, LeadRow } from "../types.js";
import { hasWhatsApp } from "./contact.js";
import { expectedDuration } from "./search.js";
import { fromWeb } from "./source.js";
import { skippedLine } from "./summary.js";

export type View =
  | { kind: "new" }
  | { kind: "unknown" }
  | { kind: "loading" }
  | { kind: "running"; job: Job; leads: LeadRow[] | null }
  | { kind: "empty"; job: Job }
  | { kind: "done"; job: Job; leads: LeadRow[] | null }
  | { kind: "failed"; job: Job; leads: LeadRow[] | null }
  | { kind: "cancelled"; job: Job; leads: LeadRow[] | null };

type Inputs = {
  /** The job in the URL, or null for the new-list form. */
  jobId: string | null;
  /** The last answer for a job; ignored unless it is the job in the URL. */
  job: Job | null;
  /** The server does not have the job in the URL. */
  missing: boolean;
  leads: LeadRow[] | null;
};

export function viewOf({ jobId, job, missing, leads }: Inputs): View {
  if (jobId === null) return { kind: "new" };
  if (missing) return { kind: "unknown" };
  if (!job || job.id !== jobId) return { kind: "loading" };
  if (job.status === "queued" || job.status === "running") return { kind: "running", job, leads };
  if (job.status === "failed") return { kind: "failed", job, leads };
  if (job.status === "cancelled") return { kind: "cancelled", job, leads };
  // A list that combines runs holds the earlier runs' places even when the newest found none.
  if (job.reconciliation?.kept === 0 && !job.saved && !leads?.length && !((job.runs ?? 1) > 1)) return { kind: "empty", job };
  return { kind: "done", job, leads };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What a cancelled list says: the search was stopped early, and how many
 * places it kept. A search cancelled before it found any says that instead.
 */
export function cancelledLine(kept: number): string {
  if (kept === 0) return "You stopped this search early, before it found any places.";
  return `You stopped this search early. It kept the ${count(kept, "place", "places")} it had found; the list may be missing some.`;
}

/** What a running search is doing, e.g. "Looking for emails on websites: 3 of 12". */
export function stageLine(job: Job): string {
  if (job.status === "queued") return "Waiting to start…";
  const { stage, places, checked, toCheck, cell, cells, keywordIndex, keywordsTotal, currentCity } = job.progress;
  if (stage === "geocoding") return `Finding ${currentCity ?? job.options.city} on the map…`;
  if (stage === "searching") {
    if (job.progress.retryInSeconds !== undefined) return job.progress.message;
    const parts: string[] = [];
    if (keywordIndex !== undefined && keywordsTotal !== undefined && keywordsTotal > 1) {
      parts.push(`keyword ${keywordIndex} of ${keywordsTotal}`);
    }
    if (cell !== undefined && cells !== undefined) {
      parts.push(`area ${cell} of ${cells}`);
    }
    const scope = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    return places > 0 ? `Searching Google Maps${scope}… ${count(places, "place", "places")} so far` : `Searching Google Maps${scope}…`;
  }
  const skipped = job.progress.notChecked;
  if (toCheck && skipped) return `Looking for emails on websites: ${checked ?? 0} of ${toCheck}. ${skippedLine(skipped)}`;
  if (toCheck) return `Looking for emails on websites: ${checked ?? 0} of ${toCheck}`;
  return "Looking for emails on websites…";
}

/** Where the search looks, once the place is found: "Searching around Petaling Jaya, Selangor, Malaysia"; null before. */
export function aroundLine(job: Job): string | null {
  const where = job.place?.label || job.place?.name;
  return where ? `Searching around ${where}` : null;
}

/** Expected duration shown for a single search while running; null on whole-city grid searches. */
export function expectedTimeLine(job: Job): string | null {
  return expectedDuration(job.options);
}

const dayKey = (d: Date, timeZone?: string) => new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(d);

/** "Today, 17:42", "Yesterday, 09:10" or "12 Nov, 17:42", in the reader's own clock. */
export function when(at: Date, now = new Date(), locale?: string, timeZone?: string): string {
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (dayKey(at, timeZone) === dayKey(now, timeZone)) return `Today, ${time}`;
  if (dayKey(at, timeZone) === dayKey(yesterday, timeZone)) return `Yesterday, ${time}`;
  const day = new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short" }).format(at);
  return `${day}, ${time}`;
}

/** One fact on the properties line: a number in strong type and its words, or words alone. */
export type Fact = { value?: string; label: string };

/**
 * "5 places · 3 on WhatsApp · 1 with email · 2 new · 2 from web search ·
 * Today, 17:42 · Bandaraya Melaka". When `totalCount` is given (a filter is
 * active), the first fact reads e.g. "32 of 140 shown". The new count shows
 * only on a list that combines runs and has new places; the web-search count
 * only when the list has such rows. Counts only, no scraped text.
 */
export function listFacts(job: Job, leads: readonly LeadRow[], now?: Date, locale?: string, timeZone?: string, totalCount?: number): Fact[] {
  const whatsapp = leads.filter(hasWhatsApp).length;
  const email = leads.filter((l) => l.emails?.length).length;
  const web = leads.filter(fromWeb).length;
  const fresh = leads.filter((l) => l.fresh).length;
  const first: Fact =
    totalCount !== undefined
      ? { value: String(leads.length), label: `of ${totalCount} shown` }
      : { value: String(leads.length), label: leads.length === 1 ? "place" : "places" };
  const facts: Fact[] = [
    first,
    { value: String(whatsapp), label: "on WhatsApp" },
    { value: String(email), label: "with email" },
  ];
  if (fresh > 0) facts.push({ value: String(fresh), label: "new since the last search" });
  if (web > 0) facts.push({ value: String(web), label: "from web search" });
  facts.push({ label: when(new Date(job.createdAt), now, locale, timeZone) });
  if (job.place?.name) facts.push({ label: job.place.name });
  const kws = keywordsOf(job.options);
  if (kws.length > 1) facts.push({ label: kws.join(", ") });
  return facts;
}

/** Shown on a finished single-search list whose search reached the end of Google Maps' results; null otherwise. */
export function endOfListLine(job: Job): string | null {
  if (job.status !== "done") return null;
  if (job.reason !== "end-of-list") return null;
  if (usesWholeCityGrid(job.options)) return null;
  return "That's everything Google Maps shows for one search.";
}

/** "19 Nov": the day of the run a combined list's markers are judged against. */
export function markerDay(iso: string, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short" }).format(new Date(iso));
}

export type MarkerContext = { sameDay: true } | { sameDay: false; day: string };

/**
 * Whether combined-list markers need a date: when all finished runs happened
 * on the same day, the date adds nothing and markers say "since the last
 * search" / "in the last search". When runs span different days, keeps the date.
 */
export function markerContext(
  latestIso: string | null,
  runDates: readonly string[] | undefined,
  runs: number,
  locale?: string,
  timeZone?: string,
): MarkerContext | null {
  if (runs <= 1 || !latestIso) return null;
  const day = markerDay(latestIso, locale, timeZone);
  if (!runDates || runDates.length <= 1) return { sameDay: false, day };
  const days = new Set(runDates.map((iso) => dayKey(new Date(iso), timeZone)));
  return days.size <= 1 ? { sameDay: true } : { sameDay: false, day };
}

/**
 * The muted words under a place on a list that combines runs: "New since the
 * last search" (or "New on 19 Nov" when runs span different days) when the
 * newest run found it first; "Not in the last search" (or "Not in the 19 Nov
 * search") when that run read Google's results to the end without it.
 */
export function rowMarker(lead: Pick<LeadRow, "fresh" | "gone">, marker: MarkerContext | string | null): string | null {
  if (!marker) return null;
  if (typeof marker === "string") {
    if (lead.fresh) return `New on ${marker}`;
    if (lead.gone) return `Not in the ${marker} search`;
    return null;
  }
  if (lead.fresh) return marker.sameDay ? "New since the last search" : `New on ${marker.day}`;
  if (lead.gone) return marker.sameDay ? "Not in the last search" : `Not in the ${marker.day} search`;
  return null;
}

/** Plain-English heading and body for the delete confirmation AlertDialog. */
export function deleteConfirmMessage(opts: {
  title: string;
  runs: number;
  places: number;
  shownPlaces?: number | null;
}): { heading: string; description: string } {
  const heading = `Delete "${opts.title}"?`;
  const parts: string[] = [];
  const placesWord = count(opts.places, "place", "places");
  if (opts.runs > 1 && opts.places > 0) {
    parts.push(`Its ${opts.runs} searches and ${placesWord} will be removed from this computer.`);
  } else if (opts.runs > 1) {
    parts.push(`Its ${opts.runs} searches will be removed from this computer.`);
  } else if (opts.places > 0) {
    parts.push(`Its ${placesWord} will be removed from this computer.`);
  } else {
    parts.push("It will be removed from this computer.");
  }
  if (opts.shownPlaces !== null && opts.shownPlaces !== undefined) {
    parts.push(`This deletes the whole list, not only the ${count(opts.shownPlaces, "place", "places")} shown.`);
  }
  parts.push("This can't be undone.");
  return { heading, description: parts.join(" ") };
}
