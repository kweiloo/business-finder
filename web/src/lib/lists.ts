// Past searches shown as lists.

import { searchKey } from "../../../src/jobs/lists.js";
import type { Job } from "../types.js";
import { urlForJob } from "./route.js";
import { when } from "./view.js";

// Grouping is shared with the API, the exports and the CLI, so every one of
// them shows the same lists; this file adds only what the page displays.
export { collapseLists, listTitle, searchKey, searchText } from "../../../src/jobs/lists.js";

/**
 * A past search as the rail shows it: the run it follows, titled as the
 * search was first typed. From the server it also carries the combined place
 * count of every run of the search (`count`) and how many runs it combines.
 */
export type Listed = Job & { title: string; count?: number; runs?: number };

/**
 * How many places the list holds; null while it runs, and when it stopped
 * before keeping any. From the server's lists, the count of every run of the
 * search combined. A cancelled search counts the places it saved before
 * it stopped. `saved` is the rows on disk; a list written before it was
 * recorded falls back to its reconciliation.
 */
export function listCount(job: Job & { count?: number }): number | null {
  if (job.status === "queued" || job.status === "running") return null;
  // A list that combines runs counts each business once across them.
  if (job.count !== undefined) return job.count > 0 ? job.count : job.status === "done" ? 0 : null;
  if (job.status === "cancelled") return job.saved ? job.saved : null;
  return job.saved ?? job.reconciliation?.kept ?? null;
}

/** The search has ended: done, failed or cancelled. */
export const finished = (job: Job) => job.status === "done" || job.status === "failed" || job.status === "cancelled";

/**
 * When two rail entries share the same title, returns what distinguishes this
 * entry (its typed city when cities differ, else its run count when > 1);
 * null when the title is unique or nothing besides the date differs.
 */
export function railDetail(job: Listed, lists: readonly Listed[]): string | null {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const sameTitle = lists.filter((l) => norm(l.title) === norm(job.title));
  if (sameTitle.length <= 1) return null;
  const cities = new Set(sameTitle.map((l) => norm(l.options.city)));
  const city = job.options.city.trim();
  if (cities.size > 1 && city) return city;
  return (job.runs ?? 1) > 1 ? `${job.runs} runs` : null;
}

/**
 * When a list ran, for the rail's second line: "Today, 17:42", "Yesterday,
 * 09:10", "12 Nov, 17:42". Two runs that share a title (say "Kuala Lumpur"
 * and "Kuala Lumpur, Malaysia") are told apart by it.
 */
export function railWhen(job: Job, now?: Date, locale?: string, timeZone?: string): string {
  return when(new Date(job.createdAt), now, locale, timeZone);
}

export type DeleteState = {
  /** Remaining lists in the rail, newest first. */
  lists: Listed[];
  /** Next list to show, or null when no lists remain. */
  nextId: string | null;
  /** URL to replace the deleted list's entry with. */
  url: string;
};

/**
 * Updates the rail and chooses the next destination after deleting a list:
 * removes the deleted search from `lists`, then moves to the next list (or
 * previous when deleting the last), or to New list when none remain.
 */
export function afterDelete(
  lists: readonly Listed[],
  deleted: { id: string; options: { keyword: string; keywords?: string[]; city: string; cities?: string[] } },
): DeleteState {
  const key = searchKey(deleted);
  const index = lists.findIndex((l) => searchKey(l) === key);
  const remaining = index === -1 ? [...lists] : lists.filter((_, i) => i !== index);
  const next = remaining.length === 0 ? null : remaining[Math.min(index === -1 ? 0 : index, remaining.length - 1)]!;
  const nextId = next?.id ?? null;
  return {
    lists: remaining,
    nextId,
    url: urlForJob(nextId),
  };
}
