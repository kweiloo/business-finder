// Shared list filtering, sorting and URL-query encoding.
// Imports nothing from Node or the DOM, so the server export and the web page
// run the exact same predicates and always agree on what is shown.

import { classifyEmail, type EmailType } from "../core/enrich/emailType.js";
import { hasEmail, hasPhone, hasWebsite, hasWhatsApp } from "../core/leads/contact.js";

export type SortBy = "default" | "rating" | "reviews" | "name";

export type ListFilter = {
  whatsapp: boolean;
  email: boolean;
  emailType: EmailType | null;
  website: boolean;
  phone: boolean;
  minRating: number | null;
  minReviews: number | null;
  hiddenCategories: string[];
  onlyNew: boolean;
  hideNotFound: boolean;
};

export type ListQuery = ListFilter & { sort: SortBy };

export const EMPTY_FILTER: ListFilter = {
  whatsapp: false,
  email: false,
  emailType: null,
  website: false,
  phone: false,
  minRating: null,
  minReviews: null,
  hiddenCategories: [],
  onlyNew: false,
  hideNotFound: false,
};

export const DEFAULT_LIST_QUERY: ListQuery = { ...EMPTY_FILTER, sort: "default" };

/** Any combined row (`CombinedLead`) or web row (`LeadRow`) satisfies this shape. */
export type FilterableLead = {
  title: string;
  phone?: string | null;
  whatsapp?: string | null;
  emails?: readonly string[] | null;
  email_types?: readonly EmailType[] | null;
  website?: string | null;
  category?: string | null;
  review_rating?: number | null;
  review_count?: number | null;
  new?: boolean;
  fresh?: boolean;
  not_found_last_time?: boolean;
  gone?: boolean;
};

export type CategoryCount = { name: string; count: number };

const isNew = (lead: FilterableLead): boolean => lead.new === true || lead.fresh === true;
const isNotFound = (lead: FilterableLead): boolean => lead.not_found_last_time === true || lead.gone === true;
const finiteNumber = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function hasEmailType(lead: FilterableLead, wanted: EmailType): boolean {
  const emails = lead.emails;
  if (!emails || emails.length === 0) return false;
  if (lead.email_types && lead.email_types.length === emails.length) {
    return lead.email_types.includes(wanted);
  }
  return emails.some((e) => classifyEmail(e) === wanted);
}

/** True when at least one filter toggle, threshold or hidden category is set. */
export function hasActiveFilters(filter: ListFilter): boolean {
  return (
    filter.whatsapp ||
    filter.email ||
    filter.emailType !== null ||
    filter.website ||
    filter.phone ||
    filter.minRating !== null ||
    filter.minReviews !== null ||
    filter.hiddenCategories.length > 0 ||
    filter.onlyNew ||
    filter.hideNotFound
  );
}

/** Count of active filter dimensions, for compact mobile filter triggers. */
export function activeFilterCount(filter: ListFilter): number {
  let count = moreFilterCount(filter);
  if (filter.whatsapp) count += 1;
  if (filter.email) count += 1;
  if (filter.website) count += 1;
  if (filter.phone) count += 1;
  return count;
}

/** Count of active filter dimensions kept behind More filters on desktop. */
export function moreFilterCount(filter: ListFilter): number {
  let count = 0;
  if (filter.emailType !== null) count += 1;
  if (filter.minRating !== null) count += 1;
  if (filter.minReviews !== null) count += 1;
  if (filter.hiddenCategories.length > 0) count += 1;
  if (filter.onlyNew) count += 1;
  if (filter.hideNotFound) count += 1;
  return count;
}

/** Resets all filters while keeping the current sort order. */
export function clearFilters(query: ListQuery): ListQuery {
  return { ...EMPTY_FILTER, hiddenCategories: [], sort: query.sort };
}

/**
 * A Google category name short and plain enough to hand to an agent:
 * letters, digits, spaces and light punctuation, at most 40 characters, no
 * link. Category names are scraped text, so anything else stays a count.
 */
const AGENT_CATEGORY = /^[\p{L}\p{M}\p{N} &'’.,()/-]{1,40}$/u;

/**
 * The list's categories for `business-finder lists --json`: names that read like a
 * Google category with their place counts, most common first, and how many
 * places carry a category name that does not (`otherPlaces`).
 */
export function categoriesForAgents(leads: readonly Pick<FilterableLead, "category">[]): { categories: { name: string; places: number }[]; otherPlaces: number } {
  const categories: { name: string; places: number }[] = [];
  let otherPlaces = 0;
  for (const { name, count } of categoryCounts(leads)) {
    if (AGENT_CATEGORY.test(name) && !/https?:|www\./i.test(name)) categories.push({ name, places: count });
    else otherPlaces += count;
  }
  return { categories, otherPlaces };
}

/** Categories present in the list with their counts, most common first. */
export function categoryCounts(leads: readonly Pick<FilterableLead, "category">[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const lead of leads) {
    const name = lead.category?.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Filters rows by every active toggle, threshold, hidden category and combined-list marker. */
export function filterLeads<T extends FilterableLead>(leads: readonly T[], filter: ListFilter): T[] {
  if (!hasActiveFilters(filter)) return [...leads];
  const hidden = new Set(filter.hiddenCategories.map((c) => c.trim()).filter(Boolean));
  return leads.filter((lead) => {
    if (filter.whatsapp && !hasWhatsApp(lead)) return false;
    if (filter.email && !hasEmail(lead)) return false;
    if (filter.emailType !== null && !hasEmailType(lead, filter.emailType)) return false;
    if (filter.website && !hasWebsite(lead)) return false;
    if (filter.phone && !hasPhone(lead)) return false;
    if (filter.minRating !== null) {
      if (!finiteNumber(lead.review_rating) || lead.review_rating < filter.minRating) return false;
    }
    if (filter.minReviews !== null) {
      if (!finiteNumber(lead.review_count) || lead.review_count < filter.minReviews) return false;
    }
    if (hidden.size > 0) {
      const cat = lead.category?.trim();
      if (cat && hidden.has(cat)) return false;
    }
    if (filter.onlyNew && !isNew(lead)) return false;
    if (filter.hideNotFound && isNotFound(lead)) return false;
    return true;
  });
}

function compareNullableDesc(a: number | null | undefined, b: number | null | undefined): number {
  const aOk = finiteNumber(a);
  const bOk = finiteNumber(b);
  if (aOk && bOk) return b - a;
  if (aOk) return -1;
  if (bOk) return 1;
  return 0;
}

/** Sorts rows by rating, reviews or name; `"default"` keeps the input order. Missing numbers go last. */
export function sortLeads<T extends FilterableLead>(leads: readonly T[], sort: SortBy): T[] {
  const copy = [...leads];
  switch (sort) {
    case "default":
      return copy;
    case "rating":
      return copy.sort((a, b) => compareNullableDesc(a.review_rating, b.review_rating));
    case "reviews":
      return copy.sort((a, b) => compareNullableDesc(a.review_count, b.review_count));
    case "name":
      return copy.sort((a, b) => a.title.trim().localeCompare(b.title.trim(), undefined, { sensitivity: "base" }));
  }
}

/** Filters and sorts a list's rows with the exact logic shared by page and download. */
export function applyListQuery<T extends FilterableLead>(leads: readonly T[], query: ListQuery): T[] {
  return sortLeads(filterLeads(leads, query), query.sort);
}

const QUERY_KEYS = ["wa", "email", "email_type", "website", "phone", "rating", "reviews", "hide_cat", "new", "hide_missing", "sort"] as const;

const SORTS = new Set<SortBy>(["default", "rating", "reviews", "name"]);
const EMAIL_TYPES = new Set<EmailType>(["generic", "personal", "not_sure"]);

function flag(params: URLSearchParams, key: string): boolean {
  const v = params.get(key);
  return v === "1" || v === "true";
}

function positiveNum(raw: string | null, max?: number): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

/** Reads filter and sort state from URL search params; invalid values fall back to defaults. */
export function parseListQuery(input: URLSearchParams | string): ListQuery {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const rawSort = params.get("sort") as SortBy | null;
  const rawEmailType = params.get("email_type") as EmailType | null;
  const rawReviews = positiveNum(params.get("reviews"));
  return {
    whatsapp: flag(params, "wa"),
    email: flag(params, "email"),
    emailType: rawEmailType && EMAIL_TYPES.has(rawEmailType) ? rawEmailType : null,
    website: flag(params, "website"),
    phone: flag(params, "phone"),
    minRating: positiveNum(params.get("rating"), 5),
    minReviews: rawReviews !== null ? Math.floor(rawReviews) : null,
    hiddenCategories: [...new Set(params.getAll("hide_cat").map((c) => c.trim()).filter(Boolean))],
    onlyNew: flag(params, "new"),
    hideNotFound: flag(params, "hide_missing"),
    sort: rawSort && SORTS.has(rawSort) ? rawSort : "default",
  };
}

/** Writes active filter and sort params into `params` (preserving unrelated keys such as `job`). */
export function writeListQuery(params: URLSearchParams, query: ListQuery): URLSearchParams {
  for (const key of QUERY_KEYS) params.delete(key);
  if (query.whatsapp) params.set("wa", "1");
  if (query.email) params.set("email", "1");
  if (query.emailType !== null) params.set("email_type", query.emailType);
  if (query.website) params.set("website", "1");
  if (query.phone) params.set("phone", "1");
  if (query.minRating !== null && Number.isFinite(query.minRating) && query.minRating > 0) {
    params.set("rating", String(query.minRating));
  }
  if (query.minReviews !== null && Number.isFinite(query.minReviews) && query.minReviews > 0) {
    params.set("reviews", String(Math.floor(query.minReviews)));
  }
  for (const cat of [...new Set(query.hiddenCategories.map((c) => c.trim()).filter(Boolean))]) {
    params.append("hide_cat", cat);
  }
  if (query.onlyNew) params.set("new", "1");
  if (query.hideNotFound) params.set("hide_missing", "1");
  if (query.sort !== "default") params.set("sort", query.sort);
  return params;
}
