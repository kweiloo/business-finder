// The one rule for "is this business already in the list?", used whenever
// rows are added to a list that already exists: `business-finder scrape --into`
// (more Maps places) and `business-finder add --into` (websites an agent found).
//
// - Two Maps places are the same only when Google gives them the same id.
//   Branches of one group can share a website and a phone; their ids differ.
// - Otherwise a row is already in the list when its website host matches,
//   or when its phone AND its name both match. A phone alone is not enough:
//   clinic groups and shared switchboards put one number on several
//   businesses, and dropping one of them loses a real lead.

import { parsePhoneNumberFromString } from "libphonenumber-js";
import { toE164 } from "../core/leads/phone.js";
import type { Lead, RawPlace } from "../core/types.js";

/** Why a row counts as already in the list. */
export type DuplicateReason = "same place" | "same website" | "same phone and name";

/** What the rule looks at in a row; every field but the name is optional. */
export type Candidate = { name: string; website?: string; phone?: string; placeId?: string; dataId?: string };

type Row = { places: string[]; host: string; phone: string; name: string };

/** The website's host without `www.`, lowercased; "" when it has none. */
export function siteHost(website: string | undefined): string {
  const raw = (website ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A name for comparing: accents, case, punctuation and spacing do not count. */
export function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The country of the first lead whose WhatsApp link holds an international number; "" when none does. */
export function countryFromLeads(leads: Lead[]): string {
  for (const lead of leads) {
    const digits = /^https:\/\/wa\.me\/(\d+)$/.exec(lead.whatsapp)?.[1];
    const country = digits ? parsePhoneNumberFromString(`+${digits}`)?.country : undefined;
    if (country) return country;
  }
  return "";
}

/** A raw place or stored lead as the duplicate rule sees it. */
export function placeCandidate(
  place: Pick<RawPlace, "title" | "website" | "phone" | "place_id" | "data_id">,
): Candidate {
  return {
    name: place.title,
    ...(place.website ? { website: place.website } : {}),
    ...(place.phone ? { phone: place.phone } : {}),
    ...(place.place_id ? { placeId: place.place_id } : {}),
    ...(place.data_id ? { dataId: place.data_id } : {}),
  };
}

/** A stored lead as the rule sees it. */
export function leadCandidate(lead: Lead): Candidate {
  return placeCandidate(lead);
}

/** The rows of one list, checked one candidate at a time; `add` remembers a row that was kept. */
export class ListIndex {
  private readonly rows: Row[] = [];

  constructor(
    existing: Lead[],
    private readonly country: string,
  ) {
    for (const lead of existing) this.add(leadCandidate(lead));
  }

  private row(c: Candidate): Row {
    const places = [c.placeId && `place_id:${c.placeId}`, c.dataId && `data_id:${c.dataId}`].filter((p): p is string => Boolean(p));
    return {
      places,
      host: siteHost(c.website),
      phone: (c.phone && toE164(c.phone, this.country)) || "",
      name: nameKey(c.name),
    };
  }

  /** Why `c` is already in the list, or null when it is new. */
  match(c: Candidate): DuplicateReason | null {
    return this.find(c)?.reason ?? null;
  }

  /**
   * The first remembered row `c` matches, by its position in the order rows
   * were added, and why; null when it is new. Lets a caller that keeps its
   * own record per row (combining a search's runs) use the same rule; rows
   * for which `open` is false are passed over.
   */
  find(c: Candidate, open: (at: number) => boolean = () => true): { at: number; reason: DuplicateReason } | null {
    const next = this.row(c);
    for (const [at, row] of this.rows.entries()) {
      if (!open(at)) continue;
      if (next.places.length > 0 && row.places.length > 0) {
        if (next.places.some((p) => row.places.includes(p))) return { at, reason: "same place" };
        continue;
      }
      if (next.host && next.host === row.host) return { at, reason: "same website" };
      if (next.phone && next.phone === row.phone && next.name && next.name === row.name) return { at, reason: "same phone and name" };
    }
    return null;
  }

  add(c: Candidate): void {
    this.rows.push(this.row(c));
  }
}

/**
 * True when Google gave names only: there is at least one place and not one
 * of them has a website, a phone or an address. A real search almost never
 * looks like this; Google limiting the computer does.
 */
export function namesOnly(leads: readonly Pick<Lead, "website" | "phone" | "address">[]): boolean {
  return leads.length > 0 && leads.every((l) => !l.website?.trim() && !l.phone?.trim() && !l.address?.trim());
}

/** The warning a names-only run shows in the CLI and on the job. */
export const NAMES_ONLY_WARNING =
  "Google returned names only (no website, phone or address for any place), which usually means it is limiting this computer. Try again in a few minutes.";
