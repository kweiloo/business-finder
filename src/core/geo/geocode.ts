// Looks a place name up on OpenStreetMap's Nominatim and decides where to
// search. A name such as "Melaka" first resolves to the state; the city of
// that name usually comes later in the same answer, inside the state's box.

import { USER_AGENT } from "../../version.js";

/** One Nominatim hit, trimmed to the geographic facts Business Finder uses. */
export type GeoHit = {
  name: string;
  addresstype: string;
  lat: number;
  lon: number;
  /** ISO 3166-1 alpha-2, uppercase. */
  countryCode: string;
  /** The state or province, as OpenStreetMap names it; absent when Nominatim gives none. */
  state?: string;
  /** ISO 3166-2 code of the state, e.g. `MY-07`; absent when Nominatim gives none. */
  stateCode?: string;
  /** The country, as OpenStreetMap names it (often in its own language). */
  country?: string;
  bbox: { south: number; north: number; west: number; east: number };
};

/**
 * `place`: search at `hit`; `region` is the state or country the name
 * resolved to first, when the search moved to a city inside it.
 * `region`: the name is a state or country with no city of that name; it is
 * too large to search. `null`: not found.
 */
export type GeocodeResult = { kind: "place"; hit: GeoHit; region?: GeoHit } | { kind: "region"; hit: GeoHit } | null;

/** `countryCode`: look within this country first (ISO 3166-1 alpha-2, any case). */
export type GeocodeOptions = { countryCode?: string };

export type Geocode = (place: string, opts?: GeocodeOptions) => Promise<GeocodeResult>;

/**
 * Where a run searches, as OpenStreetMap names it; safe to print.
 * `label` is the place with its state and country, e.g. "Petaling Jaya, Selangor, Malaysia".
 */
export type ResolvedPlace = { name: string; addresstype: string; lat: number; lon: number; label: string };

export const REGION_TYPES: readonly string[] = ["country", "state", "region", "province", "state_district", "county", "district"];
export const SETTLEMENT_TYPES: readonly string[] = ["city", "town"];
/** A region whose bounding box is no longer than this on either side is searched as it is. */
export const MAX_AREA_SIDE_KM = 40;

const KM_PER_DEGREE = 111.32;

function num(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Nominatim `jsonv2` entries as hits; entries without coordinates or a country code are skipped. */
export function parseHits(json: unknown): GeoHit[] {
  if (!Array.isArray(json)) return [];
  const hits: GeoHit[] = [];
  for (const entry of json) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as {
      name?: unknown;
      addresstype?: unknown;
      lat?: unknown;
      lon?: unknown;
      boundingbox?: unknown;
      address?: { country_code?: unknown; state?: unknown; "ISO3166-2-lvl4"?: unknown; country?: unknown };
    };
    const lat = num(e.lat);
    const lon = num(e.lon);
    const cc = e.address?.country_code;
    if (lat === null || lon === null || typeof cc !== "string" || !cc.trim()) continue;
    // Nominatim's box is [south, north, west, east]; a point stands in when it is missing.
    const box = Array.isArray(e.boundingbox) ? e.boundingbox.map(num) : [];
    const [south, north, west, east] = box.length === 4 && box.every((b) => b !== null) ? (box as number[]) : [lat, lat, lon, lon];
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const state = text(e.address?.state);
    const stateCode = text(e.address?.["ISO3166-2-lvl4"]);
    const country = text(e.address?.country);
    hits.push({
      name: typeof e.name === "string" ? e.name : "",
      addresstype: typeof e.addresstype === "string" ? e.addresstype : "",
      lat,
      lon,
      countryCode: cc.trim().toUpperCase(),
      ...(state ? { state } : {}),
      ...(stateCode ? { stateCode } : {}),
      ...(country ? { country } : {}),
      bbox: { south: south!, north: north!, west: west!, east: east! },
    });
  }
  return hits;
}

/** The country's English name, e.g. "Brazil" for `BR`; the code itself when the runtime has no name for it. */
export function countryName(code: string): string {
  const upper = code.trim().toUpperCase();
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(upper) ?? upper;
  } catch {
    return upper;
  }
}

/**
 * The place with its state and country in English, for people:
 * "Petaling Jaya, Selangor, Malaysia". A part already named is not repeated
 * ("Kuala Lumpur, Malaysia").
 */
export function placeLabel(hit: Pick<GeoHit, "name" | "state" | "country" | "countryCode">): string {
  const parts: string[] = [];
  const named = new Set<string>();
  for (const part of [hit.name, hit.state, countryName(hit.countryCode)]) {
    const segments = (part ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    for (const segment of segments) {
      const key = fold(segment);
      if (named.has(key)) continue;
      named.add(key);
      parts.push(segment);
    }
  }
  return parts.join(", ");
}

/** Lowercase without accents, so "Melaka" matches "Bandaraya Melaka". */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function inside(h: GeoHit, box: GeoHit["bbox"]): boolean {
  return h.lat >= box.south && h.lat <= box.north && h.lon >= box.west && h.lon <= box.east;
}

/** The longer side of the box in km (an equirectangular estimate, accurate enough at this scale). */
function longerSideKm({ south, north, west, east }: GeoHit["bbox"]): number {
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  return Math.max((north - south) * KM_PER_DEGREE, (east - west) * KM_PER_DEGREE * Math.cos(midLat));
}

/**
 * Picks where to search from Nominatim's hits, in their order:
 * a first hit that is not a region is used as it is. For a region, the first
 * later city or town in the same country, inside the region's box and
 * carrying the region's name (Melaka → Bandaraya Melaka) is used; another
 * town that happens to lie in the box is not. A region with none is searched
 * only when it is small (Kuala Lumpur); otherwise it is refused, never
 * searched at its centroid.
 */
export function chooseHit(hits: GeoHit[]): GeocodeResult {
  const [first, ...rest] = hits;
  if (!first) return null;
  if (!REGION_TYPES.includes(first.addresstype)) return { kind: "place", hit: first };
  const regionName = fold(first.name);
  const city = rest.find(
    (h) =>
      SETTLEMENT_TYPES.includes(h.addresstype) &&
      h.countryCode === first.countryCode &&
      inside(h, first.bbox) &&
      regionName !== "" &&
      fold(h.name).includes(regionName),
  );
  if (city) return { kind: "place", hit: city, region: first };
  if (longerSideKm(first.bbox) <= MAX_AREA_SIDE_KM) return { kind: "place", hit: first };
  return { kind: "region", hit: first };
}

/**
 * Nominatim answered, but not with a usable list (an HTTP error such as 429
 * or 5xx, or a body that is not JSON). Not the same as "not found": the
 * caller must not remember it as an answer.
 */
export class GeocodeUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GeocodeUnavailableError";
  }
}

export type LookUpOptions = GeocodeOptions & {
  /** Awaited before every request to Nominatim, so a caller can keep to its rate limit. */
  pace?: () => Promise<void>;
};

/**
 * Looks `place` up; null only when Nominatim returns no hits. With
 * `countryCode` it asks within that country first and worldwide only when the
 * country has no hit, so a short name such as "PJ" finds the Malaysian city
 * before a town abroad. An HTTP error or a body that is not JSON throws
 * `GeocodeUnavailableError`; network failures throw as they are.
 */
export async function geocode(place: string, fetchFn: typeof fetch = fetch, opts: LookUpOptions = {}): Promise<GeocodeResult> {
  const country = opts.countryCode?.trim().toLowerCase();
  if (country) {
    const within = await search(place, fetchFn, opts.pace, country);
    if (within.length > 0) return chooseHit(within);
  }
  return chooseHit(await search(place, fetchFn, opts.pace));
}

async function search(place: string, fetchFn: typeof fetch, pace: (() => Promise<void>) | undefined, country?: string): Promise<GeoHit[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({
    format: "jsonv2",
    limit: "5",
    addressdetails: "1",
    q: place,
    ...(country ? { countrycodes: country } : {}),
  }).toString();

  await pace?.();
  const response = await fetchFn(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new GeocodeUnavailableError(`Nominatim answered HTTP ${response.status}`);

  let results: unknown;
  try {
    results = await response.json();
  } catch (e) {
    throw new GeocodeUnavailableError("Nominatim answered with a body that is not JSON", { cause: e });
  }
  if (!Array.isArray(results)) throw new GeocodeUnavailableError("Nominatim answered with something other than a list");
  return parseHits(results);
}
