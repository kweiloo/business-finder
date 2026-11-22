// A synthetic 20-place run shared by the pipeline, CLI, API and web UI tests.
//
// - Titles are `ZZMARK-1` … `ZZMARK-20`, emails `zzmark<n>@shop-<n>.test`,
//   place ids `ZZPLACE-<nn>`, addresses `<n> Jalan Ujian, 75000 Melaka`,
//   phones `012-000 00<nn>` (mobile) and `03-2000 00<nn>` (landline), websites
//   `https://shop-<n>.test/`. `RUN20_MARKERS` lists every one of these values
//   (phones also in E.164) and `assertNoScrapedText` rejects any of them, plus
//   anything matching `zzmark` or `zzplace` (e.g. a social handle), in CLI
//   output.
// - `ZZMARK-20` is a duplicate listing of `ZZMARK-5` (same place_id), so a run
//   finds 20 places and keeps 19.
// - Among the 19 unique places: 12 Malaysian mobile numbers (1–12), 6
//   landlines (13–18) and one place without a phone (19).
// - Places 1–10 have websites `https://shop-<n>.test/`, served from
//   `tests/fixtures/sites/shop-<n>.test.html`, each listing
//   `zzmark<n>@shop-<n>.test`.

import { fileURLToPath } from "node:url";
import { enrichLeads, fixtureFetcher } from "../../src/core/enrich/enrich.js";
import { toE164 } from "../../src/core/leads/phone.js";
import { fixtureSource } from "../../src/core/sources/fixture.js";
import type { PlaceSource } from "../../src/core/sources/source.js";
import { makeBatch } from "./batch.js";

type SyntheticPlace = Parameters<typeof makeBatch>[0][number];

export const RUN20_SITES_DIR = fileURLToPath(new URL("./sites/", import.meta.url));

const pad = (n: number) => String(n).padStart(2, "0");

function place(n: number): SyntheticPlace {
  const p: SyntheticPlace = {
    title: `ZZMARK-${n}`,
    category: "Souvenir shop",
    address: `${n} Jalan Ujian, 75000 Melaka`,
    place_id: `ZZPLACE-${pad(n)}`,
    data_id: `0x0:0x${n.toString(16)}`,
    latitude: 2.3 + n / 1000,
    longitude: 102.2 + n / 1000,
    review_rating: 4,
    review_count: n * 3,
  };
  if (n <= 12) p.phone = `012-000 00${pad(n)}`;
  else if (n <= 18) p.phone = `03-2000 00${pad(n)}`;
  if (n <= 10) p.website = `https://shop-${n}.test/`;
  return p;
}

const unique = Array.from({ length: 19 }, (_, i) => place(i + 1));
/** The same business as ZZMARK-5, listed a second time under another name. */
const duplicate: SyntheticPlace = { ...place(5), title: "ZZMARK-20" };

export const RUN20_PLACES: SyntheticPlace[] = [...unique, duplicate];
export const RUN20_BATCH = makeBatch(RUN20_PLACES);

const phones = RUN20_PLACES.flatMap((p) => (p.phone === undefined ? [] : [String(p.phone)]));

/** Every scraped value in the fixture, for "nothing scraped is printed" checks. */
export const RUN20_MARKERS: string[] = [
  ...RUN20_PLACES.map((p) => String(p.title)),
  ...RUN20_PLACES.map((p) => String(p.place_id)),
  ...RUN20_PLACES.map((p) => String(p.address)),
  ...phones,
  ...phones.map((p) => toE164(p, "MY")).filter((p): p is string => p !== null),
  ...Array.from({ length: 10 }, (_, i) => `zzmark${i + 1}@shop-${i + 1}.test`),
  ...Array.from({ length: 10 }, (_, i) => `shop-${i + 1}.test`),
  "Jalan Ujian",
];

/** Catches marker text in any shape, e.g. a social handle built from a title. */
const MARKER_PATTERNS = [/zzmark/i, /zzplace/i];

/**
 * Throws when `output` holds any scraped value from the fixture: one of
 * `markers` verbatim or anything matching the marker patterns.
 */
export function assertNoScrapedText(output: string, markers: readonly string[] = RUN20_MARKERS): void {
  const leaked = [
    ...markers.filter((m) => output.includes(m)),
    ...MARKER_PATTERNS.filter((re) => re.test(output)).map(String),
  ];
  if (leaked.length) throw new Error(`Scraped text found in output: ${leaked.join(", ")}`);
}

export function run20Source(): PlaceSource {
  return fixtureSource([RUN20_BATCH]);
}

/** `enrichLeads` reading the fixture websites instead of the network. */
export const run20Enrich: typeof enrichLeads = (leads, opts, onProgress) =>
  enrichLeads(leads, { ...opts, fetchSite: fixtureFetcher(RUN20_SITES_DIR) }, onProgress);
