// The job API's shapes, shared by the page and by the unit tests (which run
// outside the browser, so this file stays free of DOM code).

import type { EmailMxStatus, EmailType, Progress, Reconciliation, RunOptions } from "../../src/core/types.js";

export type { EmailMxStatus, EmailType, Progress, Reconciliation };

/** `cancelled`: the person stopped the search; it keeps the places saved before it stopped (`saved`). */
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type Job = {
  id: string;
  status: JobStatus;
  /** `web` for a list made by `business-finder add --title` (it has no city); absent for a Maps search. */
  source?: "maps" | "web";
  options: RunOptions;
  progress: Progress;
  /** Where the run searches, as OpenStreetMap names it; set once the place is looked up. */
  /** `label` names the place with its state and country, e.g. "Petaling Jaya, Selangor, Malaysia"; absent on older lists. */
  place?: { name: string; type: string; label?: string };
  reconciliation?: Reconciliation;
  error?: string;
  /** Why the last search into this list stopped; `end-of-list` when Google Maps had no more places. */
  reason?: string;
  /** Rows saved so far; grows batch by batch while the search runs. Absent on an older list. */
  saved?: number;
  /** On a list from the server: how many runs of the search it combines. */
  runs?: number;
  createdAt: string;
};

/**
 * Where a lead came from: `web` is a website an agent found and handed in
 * with `business-finder add`; `browser` (or `fixture`, in tests) is Google Maps.
 */
export type LeadSource = "browser" | "fixture" | "web";

/** One row of the lean JSON export plus where it came from; missing values are null. */
export type LeadRow = {
  title: string;
  phone: string | null;
  whatsapp: string | null;
  emails: string[] | null;
  email_types: EmailType[] | null;
  email_mx: EmailMxStatus[] | null;
  website: string | null;
  category: string | null;
  address: string | null;
  review_rating: number | null;
  review_count: number | null;
  instagram: string | null;
  facebook: string | null;
  linkedin: string | null;
  tiktok: string | null;
  youtube: string | null;
  x: string | null;
  source: LeadSource | null;
  /** Saved before its website was checked: emails and links may still come (or never will, after a cancel). */
  unchecked: boolean;
  /** First found by the newest finished run of the search, and by no earlier run. */
  fresh: boolean;
  /** Found by an earlier run but not by the newest, which read Google's results to the end. */
  gone: boolean;
};

/** A list as the page follows it: the run whose status it shows, its title and how many runs it combines. */
export type ListInfo = Job & { title: string; runs: number };

/** What a list's markers are judged against, sent with its rows. */
export type RowsMeta = {
  /** How many runs the list combines; markers show only when there is more than one. */
  runs: number;
  /** When the newest finished run started (ISO 8601); the markers' date. Null before any finished. */
  latest: string | null;
  /** Start times of finished runs with rows, used to tell whether all runs happened on the same day. */
  runDates?: string[];
  /** Rows marked new. */
  fresh: number;
  /** Rows marked not found last time. */
  missing: number;
};

