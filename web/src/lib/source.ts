// Where each place came from: Google Maps (the default, unmarked) or a
// website an agent found with its own web search and handed in with
// `business-finder add`.

import type { Job, LeadRow, LeadSource } from "../types.js";

/** The fields a row shows, in the lean export's order, plus `source`. */
const ROW_FIELDS = [
  "title",
  "phone",
  "whatsapp",
  "emails",
  "email_types",
  "email_mx",
  "website",
  "category",
  "address",
  "review_rating",
  "review_count",
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube",
  "x",
  "source",
] as const satisfies readonly (keyof LeadRow)[];

const SOURCES = new Set<string>(["browser", "fixture", "web"] satisfies LeadSource[]);

/**
 * One row as the page keeps it, from a saved lead: only the fields the page
 * shows, so the reviews, images and other extra place columns are dropped as soon as
 * they arrive. An unknown `source` reads as null (Maps). `unchecked` is true
 * for a row saved before its website was checked (`not_checked`). `fresh`
 * and `gone` are the combined list's new and not-found-last-time markers.
 */
export function toLeadRow(full: Record<string, unknown>): LeadRow {
  const row = Object.fromEntries(ROW_FIELDS.map((f) => [f, full[f] ?? null])) as LeadRow;
  if (typeof row.source !== "string" || !SOURCES.has(row.source)) row.source = null;
  row.unchecked = full.email_status === "not_checked" || full.website_status === "not_checked";
  row.fresh = full.new === true;
  row.gone = full.not_found_last_time === true;
  return row;
}

/** The row came from a web search, not Google Maps. */
export const fromWeb = (lead: Pick<LeadRow, "source">) => lead.source === "web";

/**
 * A list made only by `business-finder add --title` has no city: it is not a search
 * the page can run again.
 */
export const searchable = (job: Pick<Job, "options">) => job.options.city.trim() !== "";
