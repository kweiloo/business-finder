// Live check of the browser source and the batch index paths (not run in CI).
//
//   bun run check:live "<query>" <lat> <lon> [depth] [country] [lang]
//
// Prints only counts: how many places were read and how many have each field.
// Raw batch bodies are saved to tests/fixtures/live/ (git-ignored) so a broken
// index path can be diagnosed offline. Scraped values are never printed.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIELD_PATHS, LIST_PATHS, STRUCTURED_PATHS } from "../src/core/sources/browser/fields.js";
import { browserSource } from "../src/core/sources/browser/index.js";

const [query, latArg, lonArg, depthArg = "1", country = "MY", lang = "en"] = process.argv.slice(2);
const lat = Number(latArg);
const lon = Number(lonArg);
const depth = Number(depthArg);
if (!query || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isInteger(depth) || depth < 1) {
  console.error('usage: bun run check:live "<query>" <lat> <lon> [depth] [country] [lang]');
  process.exit(2);
}

const liveDir = path.resolve(import.meta.dirname, "..", "tests", "fixtures", "live");
mkdirSync(liveDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let saved = 0;

const started = Date.now();
const { places, reason } = await browserSource({
  headless: process.env.BUSINESS_FINDER_HEADED !== "1",
  onBody: (body) => {
    saved += 1;
    writeFileSync(path.join(liveDir, `${stamp}-batch-${saved}.txt`), body, "utf8");
  },
}).search({ keyword: query, lat, lon, lang, country, depth, maxSeconds: 120 }, (p) =>
  console.log(`  batch ${p.batches}: ${p.places} places so far`),
);

const total = places.length;
console.log(`reason: ${reason}`);
console.log(`places: ${total}`);
const counted = [
  ...Object.keys(FIELD_PATHS),
  ...Object.keys(LIST_PATHS),
  ...Object.keys(STRUCTURED_PATHS),
  "credit_cards_accepted",
  "images",
  "cid",
  "plus_code",
  "link",
];
for (const field of counted as (keyof (typeof places)[number])[]) {
  const filled = places.filter((p) => p[field] !== undefined && p[field] !== "").length;
  console.log(`${field} ${filled}/${total}`);
}
console.log(`batches saved: ${saved} in ${path.relative(process.cwd(), liveDir)}`);
console.log(`seconds: ${((Date.now() - started) / 1000).toFixed(1)}`);
