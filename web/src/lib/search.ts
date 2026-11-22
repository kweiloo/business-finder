// What the New list form asks for, and the request it sends. Kept free of
// DOM code so the unit tests can check every choice maps to the right run.

import { keywordsOf, parseKeywords } from "../../../src/core/keywords.js";
import {
  DEFAULT_SEARCH_SIZE,
  isSearchSize,
  MAX_WHOLE_CITY_LIMIT,
  SEARCH_SIZES,
  SINGLE_SEARCH_LIMIT,
  usesWholeCityGrid,
  type SearchSize,
} from "../../../src/core/searchSize.js";
import type { RunOptions } from "../../../src/core/types.js";

export { DEFAULT_SEARCH_SIZE, MAX_WHOLE_CITY_LIMIT, SEARCH_SIZES, SINGLE_SEARCH_LIMIT, type SearchSize };

/** One search as the form holds it. */
export type Query = {
  keyword: string;
  city: string;
  /** Selected preset, or null when an exact number is typed. */
  size: SearchSize | null;
  /** Optional exact cap (1–1000); empty means use the chosen size preset. */
  exact: string;
  /** Read each business's own website for emails and social links. */
  emails: boolean;
  /** Google Maps' interface language, e.g. `en`. */
  lang: string;
  /** Two-letter country for reading phone numbers; empty means from the searched place. */
  country: string;
};

/** The POST body for `/api/v1/jobs`. */
export type JobRequest = Pick<RunOptions, "keyword" | "keywords" | "city" | "depth" | "maxSeconds" | "lang" | "emails" | "socials" | "deep"> & {
  country?: string;
  limit?: number;
  wholeCity?: boolean;
};

export const DEFAULT_LANG = "en";

export const QUICK_SEARCH_TIME = "usually 15–25 seconds";
export const ONE_SEARCH_TIME = "usually 1–2 minutes";

/** Stepped stops offered by the Exact number slider inside More options. */
export const EXACT_STOPS = [20, 60, 120, 250, 500, 1000] as const;

/** Index in `EXACT_STOPS` for `exact`, or null when empty or not on a stop. */
export function exactStopIndex(exact: string): number | null {
  const trimmed = exact.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const idx = EXACT_STOPS.indexOf(Number(trimmed) as (typeof EXACT_STOPS)[number]);
  return idx >= 0 ? idx : null;
}

/**
 * Duration estimate scaled from F1's measured ranges:
 * - Single search (`<= 120`, unless whole-city grid is forced): linearly scaled between
 *   20 s at 20 places (midpoint of 15–25 s) and 90 s at 120 places (midpoint of 1–2 min).
 * - Whole-city grid (`> 120` or forced): base 5 min plus up to 10 min proportional to
 *   `count / 1000`, matching F1's 5–15 min whole-city range (250 -> ~8 min, 500 -> ~10 min, 1000 -> ~15 min).
 */
export function estimateExactDuration(count: number, forceWholeCity = false): string {
  if (!forceWholeCity && count <= SINGLE_SEARCH_LIMIT) {
    if (count <= 20) return "about 20 seconds";
    const seconds = 20 + ((count - 20) / (SINGLE_SEARCH_LIMIT - 20)) * 70;
    if (seconds < 60) {
      const rounded = Math.round(seconds / 5) * 5;
      return `about ${rounded} seconds`;
    }
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const clamped = Math.min(Math.max(count, 1), MAX_WHOLE_CITY_LIMIT);
  const minutes = Math.round(5 + (clamped / MAX_WHOLE_CITY_LIMIT) * 10);
  return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** Plain live summary shown next to the Exact number slider. */
export function exactSummaryText(exact: string, size: SearchSize | null): string {
  const trimmed = exact.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    return `Optional. Above ${SINGLE_SEARCH_LIMIT} searches the whole city.`;
  }
  const count = Number(trimmed);
  const wholeCity = usesWholeCityGrid({ wholeCity: size === "wholeCity", limit: count });
  const duration = estimateExactDuration(count, size === "wholeCity");
  const noun = count === 1 ? "place" : "places";
  const prefix = exactStopIndex(trimmed) !== null ? `About ${count} ${noun}` : `Saved limit: ${count} ${noun}`;
  return wholeCity ? `${prefix} · ${duration} · searches the whole city` : `${prefix} · ${duration}`;
}

/** The three choices, in order, with the plain words the form shows. Times are measured on live searches. */
export const SIZE_CHOICES: readonly { size: SearchSize; label: string; hint: string }[] = [
  { size: "about20", label: "A quick look", hint: `About 20 places · ${QUICK_SEARCH_TIME}` },
  { size: "oneSearch", label: "Everything one search finds", hint: `About 100–120 places · ${ONE_SEARCH_TIME}` },
  {
    size: "wholeCity",
    label: "The whole city",
    hint: "Up to 1000 places · usually 5–15 minutes. You can leave this page; the search keeps going and the list stays on the left.",
  },
];

/** Plain expected duration for a running single search, or null for whole-city grid searches. */
export function expectedDuration(options: RunOptions): string | null {
  if (usesWholeCityGrid(options)) return null;
  const quick =
    (options.limit !== undefined && options.limit <= 20) ||
    (options.limit === undefined && options.depth <= SEARCH_SIZES.about20.depth);
  const raw = quick ? QUICK_SEARCH_TIME : ONE_SEARCH_TIME;
  const suffix = keywordsOf(options).length > 1 ? " per keyword" : "";
  return `${raw.charAt(0).toUpperCase() + raw.slice(1)}${suffix}`;
}

/** Languages Google Maps can answer in; the names are written in each language. */
export const LANGUAGES: readonly { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "ms", name: "Bahasa Melayu" },
  { code: "zh-CN", name: "中文（简体）" },
  { code: "zh-TW", name: "中文（繁體）" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "th", name: "ไทย" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "ta", name: "தமிழ்" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "pt", name: "Português" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
];

/**
 * Deprecated CLDR aliases that share a display name with a current ISO 3166-1
 * code, plus non-country supranational/pseudo/unknown region codes (`EU`, `EZ`,
 * `QO`, `UN`, `XA`, `XB`, `ZZ`).
 */
const NON_COUNTRY_OR_ALIAS_REGIONS = new Set([
  "AN", "BU", "CS", "DD", "DY", "EU", "EZ", "FX", "HV", "NH", "QO", "RH", "SU", "TP", "UK", "UN", "VD", "XA", "XB", "YD", "YU", "ZR", "ZZ",
]);

/** Every region `Intl.DisplayNames` can name, sorted by English display name. */
function buildCountryCodes(): readonly string[] {
  const dn = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const entries: { code: string; name: string }[] = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NON_COUNTRY_OR_ALIAS_REGIONS.has(code)) continue;
      try {
        const canonical = Intl.getCanonicalLocales(`und-${code}`)[0]?.split("-")[1];
        if (canonical && canonical !== code) continue;
      } catch {
        continue;
      }
      const name = dn.of(code);
      if (name && name !== code) entries.push({ code, name });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries.map((e) => e.code);
}

/** Countries offered for reading phone numbers, besides Automatic. */
export const COUNTRY_CODES: readonly string[] = buildCountryCodes();

/** "Malaysia" for `MY`, in the reader's language when the browser can name it. */
export function countryName(code: string, locale = "en"): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function emptyQuery(): Query {
  return { keyword: "", city: "", size: DEFAULT_SEARCH_SIZE, exact: "", emails: true, lang: DEFAULT_LANG, country: "" };
}

/**
 * The request for a query. "Look for emails" switches all website reading on
 * or off together: with it off no website is opened, which is what makes the
 * search faster. An exact limit above 120 turns on the grid automatically.
 */
export function toRequest(q: Query): JobRequest {
  const keywords = parseKeywords(q.keyword);
  const keyword = keywords[0] ?? q.keyword.trim();
  const multi = keywords.length > 1;
  const exactTrim = q.exact.trim();
  const hasExact = /^\d+$/.test(exactTrim) && Number(exactTrim) >= 1;
  const limit = hasExact ? Math.min(Number(exactTrim), MAX_WHOLE_CITY_LIMIT) : undefined;
  const size = q.size ?? DEFAULT_SEARCH_SIZE;
  const grid = usesWholeCityGrid({ wholeCity: q.size === "wholeCity", limit });
  const preset = limit !== undefined ? undefined : SEARCH_SIZES[size];
  const depth = grid
    ? SEARCH_SIZES.wholeCity.depth
    : limit !== undefined
      ? Math.max(1, Math.ceil(limit / 20))
      : preset!.depth;
  const maxSeconds = grid ? SEARCH_SIZES.wholeCity.maxSeconds : (preset?.maxSeconds ?? SEARCH_SIZES[DEFAULT_SEARCH_SIZE].maxSeconds);
  // For multi-keyword "Everything one search finds", do not cap the combined list at 120 so every keyword runs.
  const effectiveLimit = limit ?? (multi && size === "oneSearch" ? undefined : preset?.limit);

  return {
    keyword,
    ...(multi ? { keywords } : {}),
    city: q.city.trim(),
    depth,
    maxSeconds,
    lang: q.lang || DEFAULT_LANG,
    emails: q.emails,
    socials: q.emails,
    deep: q.emails,
    ...(q.country ? { country: q.country } : {}),
    ...(effectiveLimit !== undefined ? { limit: effectiveLimit } : {}),
    ...(grid ? { wholeCity: true } : {}),
  };
}

/**
 * The preset matching a stored single-search depth when no `limit` was
 * recorded: depth 1 is "A quick look", depth 2–3 maps to exact 60 (null),
 * and depth >3 maps to "Everything one search finds".
 */
export function sizeOf(depth: number): SearchSize | null {
  if (depth <= SEARCH_SIZES.about20.depth) return "about20";
  if (depth <= 3) return null;
  return "oneSearch";
}

/** A list's search as the form shows it, to run it again or edit it. */
export function queryOf(options: RunOptions): Query {
  const grid = usesWholeCityGrid(options);
  const base = {
    keyword: keywordsOf(options).join(", "),
    city: options.city,
    emails: options.emails,
    lang: options.lang || DEFAULT_LANG,
    country: options.country ?? "",
  };

  if (options.limit !== undefined) {
    if (!grid && options.limit === SINGLE_SEARCH_LIMIT && options.depth >= SEARCH_SIZES.oneSearch.depth) {
      return { ...base, size: "oneSearch", exact: "" };
    }
    return {
      ...base,
      size: options.wholeCity && options.limit <= SINGLE_SEARCH_LIMIT ? "wholeCity" : null,
      exact: String(options.limit),
    };
  }

  if (grid) {
    return { ...base, size: "wholeCity", exact: "" };
  }

  const preset = sizeOf(options.depth);
  if (preset === null) {
    return { ...base, size: null, exact: "60" };
  }
  return { ...base, size: preset, exact: "" };
}

/**
 * A query from history state, which may predate the size and options: what
 * is missing or not understood takes the form's default.
 */
export function readQuery(value: unknown): Query | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.keyword !== "string" || typeof v.city !== "string") return null;
  const base = emptyQuery();
  const rawExact = typeof v.exact === "string" ? v.exact : base.exact;
  const hasExact = rawExact.trim() !== "";
  let size: SearchSize | null = isSearchSize(v.size) ? v.size : base.size;
  let exact = rawExact;
  if (!hasExact && v.size === "about60") {
    size = null;
    exact = "60";
  } else if (hasExact && v.size !== "wholeCity") {
    size = null;
  }
  return {
    keyword: v.keyword,
    city: v.city,
    size,
    exact,
    emails: typeof v.emails === "boolean" ? v.emails : base.emails,
    lang: typeof v.lang === "string" && v.lang ? v.lang : base.lang,
    country: typeof v.country === "string" ? v.country : base.country,
  };
}
