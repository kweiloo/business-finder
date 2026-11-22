// Reads Google Maps search result batches by index path.
//
// Each `/search?...tbm=map` response is a `)]}'`-prefixed JSON array. The
// result entries sit at `data[ENTRIES_INDEX]`; each entry holds a place entity
// at `[1]`, and every field below is read from that entity by index path.
//
// Index paths verified live with `bun run check:live` (last 2026-11-18).

import { plusCode } from "../../geo/pluscode.js";
import type { RawPlace } from "../../types.js";

export const ENTRIES_INDEX = 64;

export const FIELD_PATHS = {
  title: [11],
  category: [13, 0],
  address: [18],
  website: [7, 0],
  phone: [178, 0, 0],
  review_rating: [4, 7],
  review_count: [4, 8],
  latitude: [9, 2],
  longitude: [9, 3],
  place_id: [78],
  data_id: [10],
  // No result carried a price anywhere in its entity at the last
  // `bun run check:live`, so `price_range` is unconfirmed.
  reviews_link: [4, 3, 0],
  status: [203, 1, 4, 0],
  thumbnail: [72, 0, 0, 6, 0],
  timezone: [30],
  price_range: [4, 2],
  descriptions: [32, 1, 1],
} satisfies Record<string, number[]>;

/** Paths to lists of strings, stored joined with `LIST_SEPARATOR`. */
export const LIST_PATHS = {
  categories: [13],
} satisfies Record<string, number[]>;

export const LIST_SEPARATOR = " | ";

/**
 * Paths to nested structures, each stored as JSON text. Re-verified with `bun run check:live` on 2026-11-18 (80 places in
 * four searches): hours, address parts and reservation links are present;
 * attribute groups held only accessibility options; no result carried a
 * menu or a type 3 (order online with partner links) action group.
 */
export const STRUCTURED_PATHS = {
  /** Days: `[name, number (Monday = 1), date, [[slot text, …], …], …]`. */
  open_hours: [203, 0],
  /** `[borough, street, street again, city, postal code, state, country]`. */
  complete_address: [183, 1],
  /** Groups: `[id, name, [option, …]]`; option: `[id, name, [?, [[on, text], …]]]`. */
  about: [100, 1],
  /** Links: `[url, source, …]`. */
  reservations: [46],
  /** Action groups: `[type, ?, [[[source], [?, ?, [url]]], …]]`. */
  order_online: [75, 0],
  /** `[url, source]`. */
  menu: [38],
} satisfies Record<string, number[]>;

/** Photo galleries, read in this order; `title` is absent from the last two. */
export const IMAGE_GALLERIES = [
  { path: [171, 0], url: [3, 0, 6, 0], title: [2] },
  { path: [37, 0], url: [6, 0] },
  { path: [72, 0], url: [6, 0] },
] as const satisfies readonly { path: number[]; url: number[]; title?: number[] }[];

export const MAX_IMAGES = 20;
const MAX_IMAGE_URL_LENGTH = 1000;
const ORDER_ONLINE_TYPE = 3;

export type FieldName = keyof typeof FIELD_PATHS;
export type ListFieldName = keyof typeof LIST_PATHS;
export type StructuredFieldName = keyof typeof STRUCTURED_PATHS;

/** A place as read from a batch, before the run adds source, query and city. */
export type BatchPlace = Omit<RawPlace, "source" | "query" | "city">;

const STRING_FIELDS = [
  "title",
  "category",
  "address",
  "website",
  "phone",
  "place_id",
  "data_id",
  "reviews_link",
  "status",
  "thumbnail",
  "timezone",
  "price_range",
  "descriptions",
] as const;
const NUMBER_FIELDS = ["review_rating", "review_count", "latitude", "longitude"] as const;

const ANTI_JSON_PREFIX = /^\)\]\}'[^\n]*\n?/;

/** Follows `path` through nested arrays; `undefined` as soon as a step is missing. */
export function dig(node: unknown, path: number[]): unknown {
  let current = node;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
}

/** Decimal customer id from the hex part after `:` in a `0x..:0x..` data id. */
function cidFromDataId(dataId: string): string | undefined {
  const hex = dataId.split(":")[1];
  if (!hex || !/^0x[0-9a-f]+$/i.test(hex)) return undefined;
  return BigInt(hex).toString(10);
}

/**
 * A comma (ASCII `,`, Arabic U+060C or full-width U+FF0C) with any whitespace
 * around it, or a hyphen or en dash (U+2013) with whitespace on both sides.
 */
const TITLE_SEPARATOR = /^(?:\s*[,،，]\s*|\s+[-–]\s+)/;

/**
 * The address without a leading `<title>` and TITLE_SEPARATOR, such as
 * `<title>, ` or `<title> - `, which Google
 * often puts at `[18]`. The title matches ignoring case and surrounding
 * whitespace. Any other address, or one that would be left empty, is returned
 * as given.
 */
export function addressWithoutTitle(address: string, title: string): string {
  const name = title.trim();
  if (!name) return address;
  const start = address.trimStart();
  if (start.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return address;
  const separator = TITLE_SEPARATOR.exec(start.slice(name.length));
  if (!separator) return address;
  const rest = start.slice(name.length + separator[0].length).trimEnd();
  return rest === "" ? address : rest;
}

function readEntity(entity: unknown): BatchPlace | undefined {
  const title = dig(entity, FIELD_PATHS.title);
  if (typeof title !== "string" || title.trim() === "") return undefined;

  const place: BatchPlace = { title };
  for (const field of STRING_FIELDS) {
    if (field === "title") continue;
    const value = dig(entity, FIELD_PATHS[field]);
    if (typeof value === "string" && value !== "") place[field] = value;
  }
  for (const field of NUMBER_FIELDS) {
    const value = dig(entity, FIELD_PATHS[field]);
    if (typeof value === "number" && Number.isFinite(value)) place[field] = value;
  }
  for (const field of Object.keys(LIST_PATHS) as ListFieldName[]) {
    const list = dig(entity, LIST_PATHS[field]);
    if (!Array.isArray(list)) continue;
    const items = list.filter((item): item is string => typeof item === "string" && item !== "");
    if (items.length > 0) place[field] = items.join(LIST_SEPARATOR);
  }
  if (place.address) place.address = addressWithoutTitle(place.address, title);
  if (place.data_id) {
    const cid = cidFromDataId(place.data_id);
    if (cid) place.cid = cid;
  }
  readStructured(entity, place);
  return addDerivedFields(place);
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** `{link, source}` for an http(s) link, otherwise `undefined`. */
function webLink(url: unknown, source: unknown): { link: string; source: string } | undefined {
  const link = text(url);
  const protocol = link && parseUrl(link)?.protocol;
  if (!link || (protocol !== "https:" && protocol !== "http:")) return undefined;
  return { link, source: text(source) ?? "" };
}

const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Hours keyed by English day name, Monday first; only when all seven days are present. */
function readOpenHours(days: unknown): string | undefined {
  const byDay = new Map<string, string[]>();
  for (const day of list(days)) {
    const name = WEEK[(dig(day, [1]) as number) - 1];
    const slots = list(dig(day, [3]))
      .map((slot) => text(dig(slot, [0])))
      .filter((slot) => slot !== undefined);
    if (name && slots.length > 0 && !byDay.has(name)) byDay.set(name, slots);
  }
  if (byDay.size !== WEEK.length || list(days).length !== WEEK.length) return undefined;
  return JSON.stringify(Object.fromEntries(WEEK.map((name) => [name, byDay.get(name)])));
}

const ADDRESS_PARTS = { borough: 0, street: 1, city: 3, postal_code: 4, state: 5, country: 6 };

function readCompleteAddress(parts: unknown): string | undefined {
  const address = Object.fromEntries(
    Object.entries(ADDRESS_PARTS).map(([key, index]) => [key, text(dig(parts, [index])) ?? ""]),
  );
  return Object.values(address).some((v) => v !== "") ? JSON.stringify(address) : undefined;
}

type AboutGroup = { id: string; name: string; options: { name: string; enabled: boolean; values?: string[] }[] };

function readAbout(groups: unknown): AboutGroup[] {
  const about: AboutGroup[] = [];
  for (const group of list(groups)) {
    const id = text(dig(group, [0]));
    const name = text(dig(group, [1]));
    if (!id || !name) continue;
    const options: AboutGroup["options"] = [];
    for (const option of list(dig(group, [2]))) {
      const optionName = text(dig(option, [1]));
      if (!optionName) continue;
      const items = list(dig(option, [2, 1]));
      // Items flagged 1 are what the place offers; a value repeating the name is a plain yes.
      const values = items
        .filter((item) => dig(item, [0]) === 1)
        .map((item) => text(dig(item, [1])))
        .filter((value) => value !== undefined && value !== optionName) as string[];
      const enabled = dig(items, [0, 0]) === 1;
      options.push(values.length > 0 ? { name: optionName, enabled, values } : { name: optionName, enabled });
    }
    about.push({ id, name, options });
  }
  return about;
}

function readImages(entity: unknown): { title: string; image: string }[] {
  const images: { title: string; image: string }[] = [];
  const seen = new Set<string>();
  for (const gallery of IMAGE_GALLERIES) {
    for (const item of list(dig(entity, gallery.path))) {
      if (images.length >= MAX_IMAGES) return images;
      const image = text(dig(item, gallery.url));
      const url = image && parseUrl(image);
      if (!image || !url || url.protocol !== "https:" || url.username || url.password) continue;
      if (image.length > MAX_IMAGE_URL_LENGTH || seen.has(image)) continue;
      seen.add(image);
      images.push({ title: ("title" in gallery && text(dig(item, gallery.title))) || "", image });
    }
  }
  return images;
}

/** Sets the structured place fields that are present, as JSON text. */
function readStructured(entity: unknown, place: BatchPlace): void {
  const at = (field: StructuredFieldName) => dig(entity, STRUCTURED_PATHS[field]);
  const json = (value: unknown[]) => (value.length > 0 ? JSON.stringify(value) : undefined);

  const about = readAbout(at("about"));
  const cards = about
    .find((group) => group.id === "payments")
    ?.options.find((option) => option.name === "Credit cards")?.values;
  const orderLinks = list(at("order_online"))
    .filter((group) => dig(group, [0]) === ORDER_ONLINE_TYPE)
    .flatMap((group) => list(dig(group, [2])).map((item) => webLink(dig(item, [1, 2, 0]), dig(item, [0, 0]))));
  const menu = webLink(dig(at("menu"), [0]), dig(at("menu"), [1]));

  const values: Partial<Record<keyof RawPlace, string | undefined>> = {
    open_hours: readOpenHours(at("open_hours")),
    complete_address: readCompleteAddress(at("complete_address")),
    about: json(about),
    credit_cards_accepted: cards?.join(", ") || undefined,
    reservations: json(list(at("reservations")).map((item) => webLink(dig(item, [0]), dig(item, [1]))).filter(Boolean)),
    order_online: json(orderLinks.filter(Boolean)),
    menu: menu && JSON.stringify(menu),
    images: json(readImages(entity)),
  };
  for (const [field, value] of Object.entries(values)) {
    if (value) (place as Record<string, unknown>)[field] = value;
  }
}

/**
 * Adds the fields computed from others: `plus_code` from the coordinates and,
 * when there is a `place_id` but no `link`, a link in Google's documented Maps
 * URL form. Fields already set are left as they are.
 */
export function addDerivedFields(place: BatchPlace): BatchPlace {
  if (!place.plus_code && place.latitude !== undefined && place.longitude !== undefined) {
    const code = plusCode(place.latitude, place.longitude);
    if (code) place.plus_code = code;
  }
  if (!place.link && place.place_id) {
    place.link =
      "https://www.google.com/maps/search/?api=1" +
      `&query=${encodeURIComponent(place.title)}&query_place_id=${encodeURIComponent(place.place_id)}`;
  }
  return place;
}

/**
 * Parses one batch response body into places. Never throws: a body that is not
 * JSON, or has no entries slot, yields `[]`. Entries without a title are skipped.
 */
export function parseBatch(body: string): BatchPlace[] {
  let data: unknown;
  try {
    data = JSON.parse(body.replace(ANTI_JSON_PREFIX, ""));
  } catch {
    return [];
  }
  const entries = dig(data, [ENTRIES_INDEX]);
  if (!Array.isArray(entries)) return [];

  const places: BatchPlace[] = [];
  for (const entry of entries) {
    const place = readEntity(dig(entry, [1]));
    if (place) places.push(place);
  }
  return places;
}

export type PlaceLink = {
  link: string;
  title: string;
  data_id: string | undefined;
  latitude: number | undefined;
  longitude: number | undefined;
  place_id: string | undefined;
  cid: string | undefined;
};

function decodePathName(href: string): string {
  const name = /\/maps\/place\/([^/?#]+)/.exec(href)?.[1];
  if (!name) return "";
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name.replace(/\+/g, " ");
  }
}

/**
 * Reads the ids and coordinates encoded in a `/maps/place/` URL: `!1s<data_id>`,
 * `!3d<lat>!4d<lon>` and `!19s<place_id>`, plus the `cid` derived from the
 * data id. The title is `label` when given, otherwise the place name in the
 * URL path.
 */
export function parsePlaceLink(href: string, label?: string): PlaceLink {
  const coords = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(href);
  const dataId = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(href)?.[1];
  return {
    link: href,
    title: label?.trim() || decodePathName(href),
    data_id: dataId,
    latitude: coords ? Number(coords[1]) : undefined,
    longitude: coords ? Number(coords[2]) : undefined,
    place_id: /!19s(ChIJ[\w-]+)/.exec(href)?.[1],
    cid: dataId ? cidFromDataId(dataId) : undefined,
  };
}
