// How close a scrape's places are to a centre point (not run in CI).
//
//   bun scripts/check-centre.ts <file.csv|file.json> <lat> <lon>
//
// Reads the `latitude` and `longitude` columns of a `--full` export and
// prints only counts and distances, never a scraped value.

import { readFileSync } from "node:fs";

const [file, latArg, lonArg] = process.argv.slice(2);
const centre = { lat: Number(latArg), lon: Number(lonArg) };
if (!file || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) {
  console.error("usage: bun scripts/check-centre.ts <file.csv|file.json> <lat> <lon>");
  process.exit(2);
}

/** RFC 4180 rows: quoted cells may hold commas, quotes ("") and line breaks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

function readRows(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  if (path.toLowerCase().endsWith(".json")) return JSON.parse(text) as Record<string, unknown>[];
  const [header = [], ...body] = parseCsv(text);
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""])));
}

/** A coordinate cell; the CSV export prefixes a leading `-` with `'`. */
function coordinate(value: unknown): number | null {
  const text = String(value ?? "").replace(/^'/, "").trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const rows = readRows(file);
const distances = rows
  .map((r) => ({ lat: coordinate(r.latitude), lon: coordinate(r.longitude) }))
  .filter((p): p is { lat: number; lon: number } => p.lat !== null && p.lon !== null)
  .map((p) => haversineKm(centre, p))
  .sort((a, b) => a - b);
const within = (km: number) => distances.filter((d) => d <= km).length;
const mid = distances.length / 2;
const median = distances.length === 0
  ? NaN
  : distances.length % 2 ? distances[Math.floor(mid)]! : (distances[mid - 1]! + distances[mid]!) / 2;

console.log(
  `rows ${rows.length}, with coordinates ${distances.length}, within 2 km ${within(2)}, ` +
    `5 km ${within(5)}, 10 km ${within(10)}, median ${Number.isNaN(median) ? "n/a" : median.toFixed(1)} km`,
);
