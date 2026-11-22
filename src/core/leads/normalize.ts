import type { Lead, RawPlace } from "../types.js";
import { toE164, whatsappLink } from "./phone.js";

/**
 * Builds a lead from a raw place. Enrichment fields start empty with status
 * `skipped_by_option`; the enrichment step overwrites them when it runs.
 * `fetchedAt` is the ISO 8601 time stamped on the lead; the pipeline passes
 * its injected clock so runs are reproducible.
 */
export function toLead(p: RawPlace, country: string, fetchedAt: string = new Date().toISOString()): Lead {
  return {
    ...p,
    whatsapp: p.phone ? whatsappLink(p.phone, country) : "",
    emails: [],
    email_types: [],
    email_source_url: "",
    email_status: "skipped_by_option",
    website_status: "skipped_by_option",
    instagram: "",
    facebook: "",
    linkedin: "",
    tiktok: "",
    youtube: "",
    x: "",
    fetched_at: fetchedAt,
  };
}

/**
 * Identity used to drop duplicate places: `place_id`, else `data_id`, else
 * the phone in E.164, else `title|address` lowercased. `country` is used to
 * read national-format phones; without it only `+`-prefixed phones normalise.
 */
export function dedupeKey(
  p: Pick<RawPlace, "title" | "address" | "phone" | "place_id" | "data_id">,
  country = "",
): string {
  if (p.place_id) return `place_id:${p.place_id}`;
  if (p.data_id) return `data_id:${p.data_id}`;
  const e164 = p.phone ? toE164(p.phone, country) : null;
  if (e164) return `phone:${e164}`;
  return `${p.title.trim()}|${(p.address ?? "").trim()}`.toLowerCase();
}
