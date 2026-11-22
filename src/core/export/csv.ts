// Writes leads as CSV (for spreadsheets) or JSON (for programs and agents).

import { emailMxCsvLabel, emailTypeCsvLabel } from "../enrich/emailType.js";
import type { Lead } from "../types.js";
import { samePhoneAs } from "./same-phone.js";

/** Default export columns, in the order users see them. */
export const LEAN_COLUMNS: string[] = [
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
];

/**
 * The extra place columns: Google Maps place details, in a fixed order.
 * Lead fields carry these names, so most need no mapping. Some stay empty
 * until Business Finder reads them.
 */
export const EXTRA_PLACE_COLUMNS: string[] = [
  "input_id",
  "link",
  "title",
  "category",
  "address",
  "open_hours",
  "popular_times",
  "website",
  "phone",
  "plus_code",
  "review_count",
  "review_rating",
  "reviews_per_rating",
  "latitude",
  "longitude",
  "cid",
  "status",
  "descriptions",
  "reviews_link",
  "thumbnail",
  "timezone",
  "price_range",
  "data_id",
  "street_view_url",
  "place_id",
  "images",
  "reservations",
  "order_online",
  "menu",
  "owner",
  "complete_address",
  "credit_cards_accepted",
  "about",
  "user_reviews",
  "user_reviews_extended",
  "emails",
];

/** Business Finder's own columns after the lean set, before the extra place columns. */
const OWN_EXTRA_COLUMNS: string[] = [
  "place_id",
  "data_id",
  "cid",
  "latitude",
  "longitude",
  "source",
  "email_source_url",
  "email_status",
  "website_status",
  "fetched_at",
  "query",
  "city",
  "link",
  "sources",
  "same_phone_as",
  // Set when a list combines several runs of one search: when the business
  // was first found, whether the newest run found it first, and whether the
  // newest run (which read Google's results to the end) no longer found it.
  "first_seen",
  "new",
  "not_found_last_time",
];

/**
 * Columns appended after the lean set for a full export: Business Finder's own,
 * then every extra place column not already present (in its order), then
 * `categories`. Extra place columns Business Finder cannot read yet stay empty.
 */
export const FULL_EXTRA_COLUMNS: string[] = (() => {
  const present = new Set([...LEAN_COLUMNS, ...OWN_EXTRA_COLUMNS]);
  return [...OWN_EXTRA_COLUMNS, ...EXTRA_PLACE_COLUMNS.filter((c) => !present.has(c)), "categories"];
})();

/** Every column an export can hold, in full-export order. */
export const ALL_COLUMNS: string[] = [...LEAN_COLUMNS, ...FULL_EXTRA_COLUMNS];

/** Columns read from a lead field of another name. */
export const COLUMN_SOURCES: Record<string, string> = { input_id: "query" };

/** `--fields` named columns that do not exist (or none at all). */
export class UnknownColumnError extends Error {
  constructor(readonly unknown: string[]) {
    super(
      unknown.length
        ? `Unknown column(s): ${unknown.join(", ")}. Valid columns: ${ALL_COLUMNS.join(", ")}`
        : `No columns given. Valid columns: ${ALL_COLUMNS.join(", ")}`,
    );
    this.name = "UnknownColumnError";
  }
}

/**
 * The columns to write: `fields` (comma-separated, trimmed, deduplicated in
 * order) when given, else the full or the lean set. Throws
 * `UnknownColumnError` naming every unknown column, or for an empty list.
 */
export function resolveColumns(o: { full: boolean; fields?: string }): string[] {
  if (o.fields === undefined) return o.full ? ALL_COLUMNS : LEAN_COLUMNS;
  const names = [...new Set(o.fields.split(",").map((f) => f.trim()).filter(Boolean))];
  const valid = new Set(ALL_COLUMNS);
  const unknown = names.filter((n) => !valid.has(n));
  if (unknown.length || names.length === 0) throw new UnknownColumnError(unknown);
  return names;
}

const BOM = "﻿";
const EOL = "\r\n";

// Columns holding records rather than text, written as JSON text in CSV so
// they parse back; `[]` stays visible as "checked, nothing found".
const JSON_COLUMNS = new Set(["sources"]);

// List columns whose items may themselves contain ", " (place names), joined
// like `categories` so the cell splits back into its items. Other lists, such
// as `emails`, are joined with ", ".
const PIPE_LIST_COLUMNS = new Set(["same_phone_as"]);

// Leading characters that make Excel, LibreOffice or Google Sheets evaluate a
// cell as a formula (OWASP CSV injection list).
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** Values computed across all leads rather than read from one, by column. */
type Computed = Map<string, unknown[]>;

function computeColumns(leads: Lead[], columns: string[]): Computed {
  const computed: Computed = new Map();
  if (columns.includes("same_phone_as")) computed.set("same_phone_as", samePhoneAs(leads));
  return computed;
}

function valueOf(lead: Lead, column: string, row: number, computed: Computed): unknown {
  const values = computed.get(column);
  if (values) return values[row];
  const field = Object.hasOwn(COLUMN_SOURCES, column) ? COLUMN_SOURCES[column]! : column;
  return Object.hasOwn(lead, field) ? (lead as Record<string, unknown>)[field] : undefined;
}

/**
 * Turns one value into the text of a CSV cell. Numbers are written as
 * numbers and never prefixed, since a numeric value cannot hold a formula.
 * Every string that starts with a formula trigger gets a leading `'`, so a
 * phone like `+60123456789` stays text instead of being read as a number.
 */
const CSV_HEADERS: Record<string, string> = {
  email_types: "Email type",
  email_mx: "Can receive mail",
};

function csvHeader(column: string): string {
  return CSV_HEADERS[column] ?? column;
}

function formatCsvArray(items: unknown[], column: string): string {
  if (column === "email_types") {
    const labels = items.map(emailTypeCsvLabel);
    return labels.every((l) => l === "") ? "" : labels.join(", ");
  }
  if (column === "email_mx") {
    const labels = items.map(emailMxCsvLabel);
    return labels.every((l) => l === "") ? "" : labels.join(", ");
  }
  return items.map(String).join(PIPE_LIST_COLUMNS.has(column) ? " | " : ", ");
}

function cellText(value: unknown, column: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = JSON_COLUMNS.has(column)
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? formatCsvArray(value, column)
      : String(value);
  return FORMULA_TRIGGERS.has(text.charAt(0)) ? `'${text}` : text;
}

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * CSV for spreadsheets: UTF-8 with a byte order mark so Excel reads Chinese
 * and Malay text correctly, CRLF after every record, RFC 4180 quoting, and
 * formula-looking cells prefixed with `'`. `emails` is joined with ", ",
 * `same_phone_as` with " | "; `sources` is written as JSON text.
 * A column that is not a lead field is written as an empty cell.
 */
export function toCsv(leads: Lead[], columns: string[]): string {
  const lines = [columns.map(csvHeader).map(quote).join(",")];
  const computed = computeColumns(leads, columns);
  leads.forEach((lead, row) => {
    lines.push(
      columns
        .map((column) => {
          const raw = valueOf(lead, column, row, computed);
          const value = (column === "email_types" || column === "email_mx") && lead.emails.length === 0 ? undefined : raw;
          return quote(cellText(value, column));
        })
        .join(","),
    );
  });
  return BOM + lines.join(EOL) + EOL;
}

/**
 * JSON for programs: an array with one object per lead holding exactly the
 * given columns in order. Values keep their types (`emails` stays an array)
 * and are not prefixed; missing, unknown or non-finite values become null.
 */
export function toJson(leads: Lead[], columns: string[]): string {
  const computed = computeColumns(leads, columns);
  const rows = leads.map((lead, row) =>
    Object.fromEntries(
      columns.map((column) => {
        const value = valueOf(lead, column, row, computed);
        const missing = value === undefined || (typeof value === "number" && !Number.isFinite(value));
        return [column, missing ? null : value];
      }),
    ),
  );
  return JSON.stringify(rows, null, 2);
}
