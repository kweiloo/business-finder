// Starts three servers for the browser end-to-end tests:
// `bun scripts/e2e-serve.ts [port]`. `port` replays the synthetic 20-place
// Malaysian fixture; `port + 1` replays a search in Lisbon with names in
// several scripts and numbers from several countries; `port + 2` replays the
// Lisbon search after a long wait, so a test can cancel it while it runs;
// `port + 3` replays the 20-place Malaysian fixture in three batches with a
// pause before each later one, so a test sees rows arrive batch by batch;
// `port + 4` replays ZZMARK-6..19 and starts with one finished run of the same
// Melaka search that found ZZMARK-1..15, so running the search again on the
// page combines two runs with different results.
// Jobs go to a temporary folder that is removed on exit.
//
// The Lisbon server also starts with two lists an agent made: a Maps search
// with websites added from web search (`business-finder add --into`), and a list
// made only from websites (`business-finder add --title`). Both go through the same
// code as the CLI, with websites served from the fixture sites folder.
//
// The slow server starts with two finished Lisbon searches ("milliner" and
// "cobbler"), run on the Lisbon server and copied over, so a test can run one
// again there and cancel the re-run while it is still searching.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addToList, type AddTarget, type WebEntry } from "../src/cli/add.js";
import { runScrape } from "../src/core/pipeline.js";
import { loadFixtureDeps } from "../src/core/sources/fixture-file.js";
import { JobStore } from "../src/jobs/store.js";
import { runJob } from "../src/jobs/worker.js";
import { startServer } from "../src/server/serve.js";
import { makeBatch } from "../tests/fixtures/batch.js";
import { RUN20_BATCH, RUN20_PLACES, RUN20_SITES_DIR } from "../tests/fixtures/run20.js";
import { WORLD_BATCH, WORLD_GEOCODE } from "../tests/fixtures/world.js";

const port = Number(process.argv[2] ?? 18_799);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(tmpdir(), "business-finder-e2e-"));

/** Long enough that a search is still running when a test cancels it. */
const SLOW_SEARCH_MS = 60_000;
/** The pause before each later batch on the batches server: long enough to see and act on each one. */
const BATCH_DELAY_MS = 2_500;

function writeFixture(name: string, geocode: object, batch: string | string[], searchDelayMs?: number, batchDelayMs?: number): string {
  const file = path.join(dir, `${name}.json`);
  const batches = Array.isArray(batch) ? batch : [batch];
  writeFileSync(file, JSON.stringify({ geocode, batches, sitesDir: RUN20_SITES_DIR, searchDelayMs, batchDelayMs }));
  return file;
}

const serve = (at: number, name: string, fixtureFile: string) =>
  startServer({
    port: at,
    open: false,
    staticDir: path.join(root, "web", "dist"),
    jobsDir: path.join(dir, `jobs-${name}`),
    source: "fixture",
    fixtureFile,
  });

/** Title of the Maps list that also holds places from web search. */
const MIXED_SEARCH = { keyword: "orthodontist", city: "Lisbon, Portugal" };
/** Title of the list made only from websites. */
const WEB_LIST_TITLE = "Florists and bakers found on the web";

/** Runs a Maps search on `server` like the page does, and waits for it to finish. */
async function searchOn(serverUrl: string, query: { keyword: string; city: string }): Promise<string> {
  const res = await fetch(new URL("/api/v1/jobs", serverUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });
  const { id } = (await res.json()) as { id: string };
  for (let i = 0; i < 200; i++) {
    const job = (await (await fetch(new URL(`/api/v1/jobs/${id}`, serverUrl))).json()) as { status: string };
    if (job.status === "done") return id;
    if (job.status !== "queued" && job.status !== "running") throw new Error(`The seed search ended ${job.status}.`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("The seed search did not finish.");
}

/** What `business-finder add` does with a CSV file of websites, without the file. */
async function addWebsites(jobsDir: string, fixtureFile: string, target: AddTarget, entries: Omit<WebEntry, "line">[]) {
  const { enrich } = await loadFixtureDeps(fixtureFile);
  await addToList(
    entries.map((e, i) => ({ ...e, line: i + 2 })),
    { target, socials: true, country: "PT" },
    { store: new JobStore(jobsDir), enrich, now: () => new Date(), onProgress: () => {} },
  );
}

/** Copies a finished list, its leads and counts, into another server's jobs folder. */
function copyList(fromDir: string, id: string, toDir: string) {
  const from = new JobStore(fromDir);
  const to = new JobStore(toDir);
  const { status, progress, place, reconciliation, reason, options } = from.get(id)!;
  const copy = to.create(options);
  to.appendLeads(copy.id, from.readLeads(id));
  to.update(copy.id, { status, progress, ...(place ? { place } : {}), ...(reconciliation ? { reconciliation } : {}), ...(reason ? { reason } : {}) });
}

// The other servers start first, so all answer once the main port's health check does.
const worldFixture = writeFixture("world", WORLD_GEOCODE, WORLD_BATCH);
const world = await serve(port + 1, "world", worldFixture);
for (const keyword of ["milliner", "cobbler"]) {
  const id = await searchOn(world.url, { keyword, city: "Lisbon, Portugal" });
  copyList(path.join(dir, "jobs-world"), id, path.join(dir, "jobs-slow"));
}
const slow = await serve(port + 2, "slow", writeFixture("slow", WORLD_GEOCODE, WORLD_BATCH, SLOW_SEARCH_MS));
const mixedId = await searchOn(world.url, MIXED_SEARCH);
await addWebsites(path.join(dir, "jobs-world"), worldFixture, { into: mixedId }, [
  { name: "Shop A Florist", website: "https://shop-a.test/", phone: "+351 912 345 600" },
  { name: "Shop D Bakery", website: "https://shop-d.test/" },
]);
await addWebsites(path.join(dir, "jobs-world"), worldFixture, { title: WEB_LIST_TITLE }, [
  { name: "Shop A Florist", website: "https://shop-a.test/", phone: "+351 912 345 600" },
  { name: "Shop D Bakery", website: "https://shop-d.test/", note: "bakes wedding cakes" },
]);
const run20 = await serve(
  port,
  "run20",
  writeFixture("run20", { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" }, RUN20_BATCH),
);
// ZZMARK-1..7, 8..14, then 15..20 (with the duplicate of ZZMARK-5).
const MELAKA = { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" };
const thirds = [RUN20_PLACES.slice(0, 7), RUN20_PLACES.slice(7, 14), RUN20_PLACES.slice(14)].map(makeBatch);
const batches = await serve(port + 3, "batches", writeFixture("batches", MELAKA, thirds, undefined, BATCH_DELAY_MS));
// The repeated search: its first run (ZZMARK-1..15) is saved through the job
// code, as a CLI run is; the server then finds ZZMARK-6..19.
const REPEAT_SEARCH = { keyword: "gift shop", city: "Melaka" };
const repeatJobs = new JobStore(path.join(dir, "jobs-repeat"));
const firstRun = repeatJobs.create({ ...REPEAT_SEARCH, depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 600 });
const firstDeps = await loadFixtureDeps(writeFixture("repeat-first", MELAKA, makeBatch(RUN20_PLACES.slice(0, 15))));
await runJob(repeatJobs, firstRun.id, (o, onProgress, signal, rows) => runScrape(o, { ...firstDeps, now: () => new Date() }, onProgress, signal, rows));
const repeat = await serve(port + 4, "repeat", writeFixture("repeat", MELAKA, makeBatch(RUN20_PLACES.slice(5, 19))));
// Grid fixture: a 10x10 km box (2x2 = 4 cells), 35 places per cell with 5
// overlapping places between cells 1 and 2 so a whole-city run collects 135
// unique places (past the ~120 single-search cap).
const gridPlace = (n: number) => ({
  title: `GRIDMARK-${n}`,
  place_id: `GRIDPLACE-${n}`,
  data_id: `0x9:0x${n.toString(16)}`,
  phone: `012-900 ${String(n).padStart(4, "0")}`,
  address: `${n} Jalan Grid, Kuala Lumpur`,
});
const gridCells = [
  [makeBatch(Array.from({ length: 35 }, (_, i) => gridPlace(i + 1)))],
  [makeBatch(Array.from({ length: 35 }, (_, i) => gridPlace(i + 31)))],
  [makeBatch(Array.from({ length: 35 }, (_, i) => gridPlace(i + 66)))],
  [makeBatch(Array.from({ length: 35 }, (_, i) => gridPlace(i + 101)))],
];
const gridFixture = path.join(dir, "grid.json");
writeFileSync(
  gridFixture,
  JSON.stringify({
    geocode: {
      lat: 3.15,
      lon: 101.7,
      countryCode: "MY",
      bbox: { south: 3.1, north: 3.19, west: 101.65, east: 101.74 },
    },
    batches: [],
    cellBatches: gridCells,
    sitesDir: RUN20_SITES_DIR,
  }),
);
const grid = await serve(port + 5, "grid", gridFixture);
const servers = [run20, world, slow, batches, repeat, grid];
const closeAll = () => Promise.all(servers.map((s) => s.close()));
if (servers.some((s, i) => s.port !== port + i)) {
  await closeAll();
  rmSync(dir, { recursive: true, force: true });
  console.error(`A port from ${port} to ${port + 5} is taken; stop whatever is using it and run the tests again.`);
  process.exit(2);
}
console.log(`e2e servers at ${servers.map((s) => s.url).join(" and ")}`);

const stop = async () => {
  await closeAll();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
