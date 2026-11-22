// Shared data shapes for the scrape pipeline.

import type { EmailType } from "./enrich/emailType.js";
import type { EmailMxStatus } from "./enrich/mx.js";
import type { CollectReason } from "./sources/source.js";

export type { EmailType, EmailMxStatus };

/** One place as read from a source, before normalisation or enrichment. */
export type RawPlace = {
  title: string;
  phone?: string;
  website?: string;
  category?: string;
  address?: string;
  review_rating?: number;
  review_count?: number;
  latitude?: number;
  longitude?: number;
  place_id?: string;
  data_id?: string;
  cid?: string;
  link?: string;
  // Extra place columns, named as the export names them.
  reviews_link?: string;
  /** Business status text, e.g. "Permanently closed". */
  status?: string;
  thumbnail?: string;
  /** IANA time zone, e.g. `Asia/Kuala_Lumpur`. */
  timezone?: string;
  price_range?: string;
  descriptions?: string;
  /** Every category, joined with " | "; `category` is the first. */
  categories?: string;
  /** 10-digit Open Location Code computed from latitude and longitude. */
  plus_code?: string;
  // Structured extra place columns, each stored as JSON text.
  /** `{"Monday":["9 AM–6 PM"],…}`, Monday first. */
  open_hours?: string;
  /** `{"borough","street","city","postal_code","state","country"}`. */
  complete_address?: string;
  /** `[{"id","name","options":[{"name","enabled","values"?}]}]`. */
  about?: string;
  /** Values of the "Credit cards" payment option, joined with ", " (plain text). */
  credit_cards_accepted?: string;
  /** `[{"link","source"}]`. */
  reservations?: string;
  /** `[{"link","source"}]`. */
  order_online?: string;
  /** `{"link","source"}`. */
  menu?: string;
  /** Up to 20 `[{"title","image"}]`. */
  images?: string;
  /**
   * Where the place came from: `browser` is Google Maps, `fixture` is a
   * recorded Maps run in tests, `web` is a website an agent found itself and
   * handed in with `business-finder add`.
   */
  source: "browser" | "fixture" | "web";
  query: string;
  city: string;
};

/** Why an enriched field holds the value it does. */
export type FieldStatus =
  | "found"
  | "not_on_site"
  | "no_website"
  | "site_unreachable"
  | "website_mismatch"
  | "skipped_by_option"
  /** Saved while the run was still going; the website check had not reached it (yet). */
  | "not_checked";

/** The social networks enrichment reads links for; each is also a lead column. */
export type SocialNetwork = "instagram" | "facebook" | "linkedin" | "tiktok" | "youtube" | "x";

/** Where one email, social link or website phone was found. */
export type Source = {
  field: "email" | SocialNetwork | "phone";
  value: string;
  /** The page it was read from, after redirects. */
  url: string;
  /** ISO 8601 time that page was fetched. */
  fetched_at: string;
};

/** A normalised place plus the fields filled in by enrichment. */
export type Lead = RawPlace & {
  /** `https://wa.me/<digits>` for mobile numbers, otherwise empty. */
  whatsapp: string;
  emails: string[];
  /** Type of each email in `emails` (`generic`, `personal`, or `not_sure`), in the same order. */
  email_types?: EmailType[];
  /** Domain mail-server (MX/A) check for each email in `emails`, in the same order. */
  email_mx?: EmailMxStatus[];
  /** The page the first email was found on; `sources` has every one. */
  email_source_url: string;
  email_status: FieldStatus;
  website_status: FieldStatus;
  instagram: string;
  facebook: string;
  linkedin: string;
  tiktok: string;
  youtube: string;
  x: string;
  /**
   * One entry per email, per social link and for a phone read from the
   * website, in that order, set by enrichment (`[]` when nothing was found). Absent on a lead that was never
   * enriched, such as one saved before this field existed.
   */
  sources?: Source[];
  /** Free text handed in with a `business-finder add` line; absent otherwise. */
  note?: string;
  /** ISO 8601 time the lead was built. */
  fetched_at: string;
};


/** What one scrape run is asked to do. */
export type RunOptions = {
  keyword: string;
  /** All keywords to search in one run when more than one is given; `keyword` is the first. */
  keywords?: string[];
  city: string;
  /** All cities to search in one run when more than one is given; `city` is the first. */
  cities?: string[];
  /** Maximum number of result batches (~20 places each). */
  depth: number;
  /** Interface language for Google Maps, e.g. `en`. */
  lang: string;
  /** ISO 3166-1 alpha-2; defaults to the geocoded city's country. */
  country?: string;
  emails: boolean;
  socials: boolean;
  /** Also read contact or about pages when the homepage gives nothing. */
  deep: boolean;
  maxSeconds: number;
  /** Keep at most this many places; the rest count as filtered. */
  limit?: number;
  /** Cover the city's bounding box as a sequential grid of cells past the ~120 cap. */
  wholeCity?: boolean;
};

/** A progress update; `message` is plain English, ready to show in the UI. */
export type Progress = {
  stage: "geocoding" | "searching" | "checking_websites" | "done";
  places: number;
  checked?: number;
  toCheck?: number;
  /** Set once the website checks were stopped early: how many websites were not checked. */
  notChecked?: number;
  cell?: number;
  cells?: number;
  keywordIndex?: number;
  keywordsTotal?: number;
  currentKeyword?: string;
  cityIndex?: number;
  citiesTotal?: number;
  currentCity?: string;
  retryInSeconds?: number;
  retry?: number;
  retries?: number;
  message: string;
};

/** Per-keyword counts for a multi-keyword run. */
export type KeywordSummary = {
  keyword: string;
  found: number;
  added: number;
  duplicates: number;
};

/**
 * Every place and every website accounted for:
 * `found = kept + filtered + duplicates` and
 * `toCheck = fetched + unreachable + mismatched + skipped + notChecked`.
 */
export type Reconciliation = {
  found: number;
  kept: number;
  filtered: number;
  duplicates: number;
  toCheck: number;
  fetched: number;
  unreachable: number;
  mismatched: number;
  skipped: number;
  /** Websites whose check was stopped before it ended; absent when every check ended. */
  notChecked?: number;
};

export type RunResult = { leads: Lead[]; reason: CollectReason; reconciliation: Reconciliation; keywords?: KeywordSummary[] };
