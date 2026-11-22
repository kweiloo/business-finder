import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_COLUMNS, toCsv, toJson } from "../src/core/export/csv.js";
import { toLead } from "../src/core/leads/normalize.js";
import type { Lead, RawPlace, RunOptions } from "../src/core/types.js";
import { businessKey, combineRuns, listSummaries, readList, type RunRows } from "../src/jobs/combine.js";
import { ListIndex, leadCandidate } from "../src/jobs/dedupe.js";
import { collapseLists, groupOf, groupRuns, searchKey } from "../src/jobs/lists.js";
import { JobStore, type Job, type JobStatus } from "../src/jobs/store.js";
import type { CollectReason } from "../src/core/sources/source.js";

const lead = (p: Partial<RawPlace> & { title: string }, over: Partial<Lead> = {}): Lead => ({
  ...toLead({ source: "fixture", query: "dentist", city: "Lisbon", ...p }, "PT"),
  ...over,
});

const OPTIONS: RunOptions = { keyword: "dentist", city: "Lisbon, Portugal", depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 60 };

let at = Date.parse("2026-11-18T09:00:00Z");
function job(over: Partial<Job> & { status?: JobStatus; reason?: CollectReason } = {}): Job {
  at += 3_600_000;
  return {
    id: `run-${at}`,
    status: "done",
    options: OPTIONS,
    progress: { stage: "done", places: 0, message: "" },
    createdAt: new Date(at).toISOString(),
    ...over,
  };
}

const run = (j: Job, leads: Lead[]): RunRows => ({ job: j, leads });
const byTitle = <R extends { title: string }>(rows: R[], title: string): R => rows.find((r) => r.title === title)!;

const SMILE = { title: "Smile Clinic", place_id: "p-smile", phone: "+351 213 000 001" };
const TEETH = { title: "Teeth Co", place_id: "p-teeth" };
const OLDIE = { title: "Old Dental", place_id: "p-old" };

describe("combining two runs of one search", () => {
  it("shows a business found by both runs once, with the newer run's phone", () => {
    const older = run(job({ reason: "end-of-list" }), [lead(SMILE), lead(TEETH)]);
    const newer = run(job({ reason: "end-of-list" }), [lead({ ...SMILE, phone: "+351 213 999 999" }), lead(TEETH)]);
    const list = combineRuns([newer, older]);
    expect(list.rows).toHaveLength(2);
    expect(byTitle(list.rows, "Smile Clinic").phone).toBe("+351 213 999 999");
    expect(byTitle(list.rows, "Smile Clinic").first_seen).toBe(older.job.createdAt);
    expect(list.runs).toBe(2);
  });

  it("marks a business only the newer run found as new", () => {
    const older = run(job(), [lead(SMILE)]);
    const newer = run(job({ reason: "end-of-list" }), [lead(SMILE), lead(TEETH)]);
    const list = combineRuns([older, newer]);
    expect(byTitle(list.rows, "Teeth Co")).toMatchObject({ new: true, first_seen: newer.job.createdAt });
    expect(byTitle(list.rows, "Smile Clinic").new).toBe(false);
    expect(list.fresh).toBe(1);
    expect(list.latest?.id).toBe(newer.job.id);
  });

  it("marks nothing on a list of one run", () => {
    const only = run(job({ reason: "end-of-list" }), [lead(SMILE), lead(TEETH)]);
    const list = combineRuns([only]);
    expect(list.rows.every((r) => !r.new && !r.not_found_last_time)).toBe(true);
    expect(list.rows.map((r) => r.first_seen)).toEqual([only.job.createdAt, only.job.createdAt]);
  });

  it("marks a business only the older run found as not found last time when the newer run read to the end", () => {
    const older = run(job(), [lead(SMILE), lead(OLDIE)]);
    const newer = run(job({ reason: "end-of-list" }), [lead(SMILE)]);
    const list = combineRuns([older, newer]);
    // It stays in the list.
    expect(list.rows.map((r) => r.title)).toEqual(["Smile Clinic", "Old Dental"]);
    expect(byTitle(list.rows, "Old Dental").not_found_last_time).toBe(true);
    expect(byTitle(list.rows, "Smile Clinic").not_found_last_time).toBe(false);
    expect(list.missing).toBe(1);
  });

  it.each([
    ["was cancelled", { status: "cancelled" as const, reason: "end-of-list" as const }],
    ["failed", { status: "failed" as const, reason: "end-of-list" as const }],
    ["stopped at the depth asked for", { reason: "depth" as const }],
    ["stopped at the time limit", { reason: "timeout" as const }],
    ["has no recorded reason", {}],
  ])("never marks not found last time when the newer run %s", (_, over) => {
    const older = run(job(), [lead(SMILE), lead(OLDIE)]);
    const newer = run(job(over), [lead(SMILE)]);
    const list = combineRuns([older, newer]);
    expect(list.rows.some((r) => r.not_found_last_time)).toBe(false);
    expect(list.rows).toHaveLength(2);
  });

  it("includes the rows a cancelled run saved", () => {
    const older = run(job({ reason: "end-of-list" }), [lead(SMILE)]);
    const cancelled = run(job({ status: "cancelled" }), [lead(TEETH)]);
    const list = combineRuns([older, cancelled]);
    expect(list.rows.map((r) => r.title)).toEqual(["Smile Clinic", "Teeth Co"]);
    // A cancelled run with rows is the newest finished run: what it found first is new.
    expect(byTitle(list.rows, "Teeth Co").new).toBe(true);
  });

  it("judges new against the newest finished run, so a run still going removes no marker", () => {
    const first = run(job(), [lead(SMILE)]);
    const second = run(job({ reason: "end-of-list" }), [lead(SMILE), lead(TEETH)]);
    const going = run(job({ status: "running" }), [lead(TEETH), lead(OLDIE)]);
    const list = combineRuns([first, second, going]);
    expect(byTitle(list.rows, "Teeth Co").new).toBe(true);
    // Found only by the run still going: shown with the rest, not judged yet.
    expect(byTitle(list.rows, "Old Dental")).toMatchObject({ new: false, not_found_last_time: false });
    expect(list.latest?.id).toBe(second.job.id);
  });

  it("drops not found last time as soon as a running run saves that row again", () => {
    const first = run(job(), [lead(SMILE), lead(OLDIE)]);
    const second = run(job({ reason: "end-of-list" }), [lead(SMILE)]);
    // Before the running run finds Old Dental, it stays marked missing.
    expect(byTitle(combineRuns([first, second, run(job({ status: "running" }), [])]).rows, "Old Dental").not_found_last_time).toBe(true);
    // Once the running run saves Old Dental, the marker clears immediately while Teeth Co is unaffected.
    const third = run(job(), [lead(SMILE), lead(OLDIE), lead(TEETH)]);
    const fourth = run(job({ reason: "end-of-list" }), [lead(SMILE)]);
    const going = run(job({ status: "running" }), [lead(OLDIE)]);
    const list = combineRuns([third, fourth, going]);
    expect(byTitle(list.rows, "Old Dental").not_found_last_time).toBe(false);
    expect(byTitle(list.rows, "Teeth Co").not_found_last_time).toBe(true);
    expect(list.missing).toBe(1);
  });

  it("never marks earlier rows not found when an empty run follows", () => {
    const found = run(job(), [lead(SMILE), lead(OLDIE)]);
    const emptyDone = run(job({ reason: "end-of-list" }), []);
    const emptyList = combineRuns([found, emptyDone]);
    expect(emptyList.rows.every((r) => !r.not_found_last_time && !r.new)).toBe(true);
    expect(emptyList.missing).toBe(0);
    expect(emptyList.latest?.id).toBe(found.job.id);

    // An empty run after a multi-run list leaves the prior run's markers intact.
    const second = run(job({ reason: "end-of-list" }), [lead(SMILE), lead(TEETH)]);
    const blockedEmpty = run(job({ status: "failed", reason: "blocked" }), []);
    const cancelledEmpty = run(job({ status: "cancelled" }), []);
    for (const trailing of [emptyDone, blockedEmpty, cancelledEmpty]) {
      const list = combineRuns([found, second, trailing]);
      expect(byTitle(list.rows, "Old Dental").not_found_last_time).toBe(true);
      expect(byTitle(list.rows, "Smile Clinic").not_found_last_time).toBe(false);
      expect(byTitle(list.rows, "Teeth Co")).toMatchObject({ new: true, not_found_last_time: false });
      expect(list.latest?.id).toBe(second.job.id);
    }

    // Many empty runs with 0 places (e.g. blocked or empty searches) produce no rows or latest run.
    const emptyRuns = Array.from({ length: 14 }, () => run(job({ reason: "end-of-list" }), []));
    expect(combineRuns(emptyRuns)).toEqual({ rows: [], runs: 14, latest: null, runDates: [], fresh: 0, missing: 0 });
  });

  it("does not mark the first run with places as new when an earlier run was empty", () => {
    const emptyFirst = run(job({ status: "failed" }), []);
    const secondWithRows = run(job({ reason: "end-of-list" }), [lead(SMILE)]);
    const list = combineRuns([emptyFirst, secondWithRows]);
    expect(byTitle(list.rows, "Smile Clinic").new).toBe(false);
    expect(list.fresh).toBe(0);
  });

  it("keeps the emails an older run found while the newer run has not checked that website yet", () => {
    const site = { ...SMILE, website: "https://smile.test/" };
    const checked = lead(site, { emails: ["hello@smile.test"], email_status: "found", website_status: "found" });
    const unchecked = lead({ ...site, phone: "+351 213 999 999" }, { emails: [], email_status: "not_checked", website_status: "not_checked" });
    const list = combineRuns([run(job(), [checked]), run(job({ status: "running" }), [unchecked])]);
    expect(list.rows[0]).toMatchObject({ phone: "+351 213 999 999", emails: ["hello@smile.test"], email_status: "found" });
  });

  it("keeps two rows of one run that share a key", () => {
    const twins = [lead({ title: "Clinic A" }), lead({ title: "Clinic A" })];
    expect(combineRuns([run(job(), twins)]).rows).toHaveLength(2);
  });

  // dedupe.ts calls two rows the same place when they share any id, and falls
  // back to website or phone and name when one side has no id; one key per
  // row would show these businesses twice.
  it("matches a row that has only the data id to an earlier row with both ids", () => {
    const older = run(job({ reason: "end-of-list" }), [lead({ title: "Acme", place_id: "ChIJacme", data_id: "0x1:0x2" })]);
    const newer = run(job({ reason: "end-of-list" }), [lead({ title: "Acme", data_id: "0x1:0x2", phone: "+351 213 999 999" })]);
    const list = combineRuns([older, newer]);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ phone: "+351 213 999 999", new: false, not_found_last_time: false });
  });

  it("matches a row with no id to an earlier row with an id by its website", () => {
    const older = run(job({ reason: "end-of-list" }), [lead({ title: "Acme", place_id: "ChIJacme", website: "https://acme.my/" })]);
    const newer = run(job({ reason: "end-of-list" }), [lead({ title: "Acme Sdn Bhd", website: "http://www.acme.my/contact" })]);
    const list = combineRuns([older, newer]);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ title: "Acme Sdn Bhd", new: false, not_found_last_time: false });
  });

  it("keeps rows whose ids differ apart, even with the same website, as dedupe.ts does", () => {
    const branches = [
      lead({ title: "Acme KL", place_id: "p-kl", website: "https://acme.my/" }),
      lead({ title: "Acme PJ", place_id: "p-pj", website: "https://acme.my/" }),
    ];
    const list = combineRuns([run(job(), branches), run(job({ reason: "end-of-list" }), branches)]);
    expect(list.rows.map((r) => [r.title, r.new, r.not_found_last_time])).toEqual([
      ["Acme KL", false, false],
      ["Acme PJ", false, false],
    ]);
  });

  it("matches a later row through any key an earlier run saw for the business", () => {
    const first = run(job(), [lead({ title: "Acme", place_id: "p1" })]);
    const second = run(job(), [lead({ title: "Acme", place_id: "p1", website: "https://acme.my/" })]);
    const third = run(job({ reason: "end-of-list" }), [lead({ title: "Acme", website: "https://acme.my/" })]);
    expect(combineRuns([first, second, third]).rows).toHaveLength(1);
  });

  it("pairs twins of one run with the twins of the next, one to one", () => {
    const twin = { title: "Clinic A", phone: "+351 213 000 001" };
    const twins = [lead(twin), lead(twin)];
    const list = combineRuns([run(job(), twins), run(job({ reason: "end-of-list" }), twins)]);
    expect(list.rows.map((r) => r.not_found_last_time)).toEqual([false, false]);
  });
});

describe("businessKey", () => {
  it("follows dedupe.ts's order: same place, then same website, then same phone and name", () => {
    expect(businessKey(lead({ title: "A", place_id: "p1", data_id: "d1", website: "https://a.test" }))).toBe("place_id:p1");
    expect(businessKey(lead({ title: "A", data_id: "d1", website: "https://a.test" }))).toBe("data_id:d1");
    expect(businessKey(lead({ title: "A", website: "https://www.A.test/contact", phone: "+351 213 000 001" }))).toBe("site:a.test");
    expect(businessKey(lead({ title: "Clínica  A!", phone: "213 000 001" }), "PT")).toBe("phone:+351213000001|clinica a");
    expect(businessKey(lead({ title: "Clínica A" }))).toBe("name:clinica a");
  });

  it("gives the same key to the rows dedupe.ts calls the same business", () => {
    const pairs: [Lead, Lead][] = [
      [lead({ title: "A", place_id: "p1" }), lead({ title: "A renamed", place_id: "p1" })],
      [lead({ title: "A", website: "https://a.test" }), lead({ title: "B", website: "http://www.a.test/x" })],
      [lead({ title: "Clinic", phone: "+351 213 000 001" }), lead({ title: "clinic", phone: "+351213000001" })],
    ];
    for (const [a, b] of pairs) {
      expect(new ListIndex([a], "PT").match(leadCandidate(b))).not.toBeNull();
      expect(businessKey(a, "PT")).toBe(businessKey(b, "PT"));
    }
  });

  it("is stable: the same row always gets the same key", () => {
    const row = lead({ title: "A", website: "https://a.test" });
    expect(businessKey(row)).toBe(businessKey(JSON.parse(JSON.stringify(row)) as Lead));
  });
});

describe("grouping runs into lists", () => {
  it("ignores case and spacing in the keyword and the place", () => {
    const a = job({ options: { ...OPTIONS, keyword: "Dentist ", city: "lisbon,  Portugal" } });
    const b = job({ options: { ...OPTIONS, keyword: "dentist", city: "Lisbon, Portugal" } });
    expect(searchKey(a)).toBe(searchKey(b));
    const groups = groupRuns([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runs.map((r) => r.id)).toEqual([b.id, a.id]);
    // Titled as first typed.
    expect(groups[0]!.title).toBe("Dentist in lisbon");
  });

  it("never merges two cities that differ by a comma suffix such as , Malaysia", () => {
    const kl = job({ id: "kl", options: { ...OPTIONS, keyword: "event management", city: "Kuala Lumpur" } });
    const klMy = job({ id: "kl-my", options: { ...OPTIONS, keyword: "event management", city: "Kuala Lumpur, Malaysia" } });
    expect(searchKey(kl)).not.toBe(searchKey(klMy));
    expect(groupRuns([kl, klMy])).toHaveLength(2);
  });

  it("keeps title and place from the first run so header and properties line agree on spelling", () => {
    const first = job({ id: "a", options: { ...OPTIONS, keyword: "gift shop", city: "Melaka" }, place: { name: "Melaka", type: "place" } });
    const newer = job({ id: "b", options: { ...OPTIONS, keyword: "Gift Shop", city: "melaka" }, place: { name: "melaka", type: "place" } });
    const [group] = groupRuns([newer, first]);
    expect(group!.title).toBe("Gift shop in Melaka");
    expect(group!.place).toEqual({ name: "Melaka", type: "place" });
    expect(collapseLists([newer, first])[0]!.place).toEqual({ name: "Melaka", type: "place" });
  });

  it("never groups lists made by add --title, even with the same title", () => {
    const web = (id: string) => job({ id, source: "web", options: { ...OPTIONS, keyword: "event agencies", city: "" } });
    expect(groupRuns([web("w1"), web("w2")])).toHaveLength(2);
  });

  it("opens the same list from any run's id, following the newest run", () => {
    const a = job();
    const b = job({ status: "running" });
    expect(groupOf([a, b], a.id)?.shown.id).toBe(b.id);
    expect(groupOf([a, b], "nope")).toBeNull();
    expect(collapseLists([a, b]).map((l) => l.id)).toEqual([b.id]);
  });
});

describe("reading a combined list from the job store", () => {
  let dir: string;
  let store: JobStore;
  let clock: number;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "business-finder-combine-"));
    clock = Date.parse("2026-11-19T08:00:00Z");
    store = new JobStore(dir, { now: () => new Date((clock += 60_000)) });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function saved(status: JobStatus, leads: Lead[], extra: Partial<Job> = {}, options: RunOptions = OPTIONS): Job {
    const created = store.create(options);
    store.appendLeads(created.id, leads);
    return store.update(created.id, { status, ...extra });
  }

  const snapshot = () =>
    readdirSync(dir).flatMap((id) => readdirSync(path.join(dir, id)).map((f) => [`${id}/${f}`, readFileSync(path.join(dir, id, f))] as const));

  it("leaves every job's files byte-identical after reading and exporting the combined list", () => {
    const older = saved("done", [lead(SMILE), lead(OLDIE, { address: "Old Dental, Rua 1, Lisboa" })]);
    saved("done", [lead({ ...SMILE, phone: "+351 213 999 999" }), lead(TEETH)], { reason: "end-of-list" });
    const before = snapshot();
    const read = readList(store, older.id)!;
    toCsv(read.list.rows, ALL_COLUMNS);
    toJson(read.list.rows, ALL_COLUMNS);
    listSummaries(store);
    expect(snapshot()).toEqual(before);
    // The read-time cleanup is applied before combining: the address loses the business name.
    expect(byTitle(read.list.rows, "Old Dental").address).toBe("Rua 1, Lisboa");
    expect(read.list.rows.map((r) => [r.title, r.new, r.not_found_last_time])).toEqual([
      ["Smile Clinic", false, false],
      ["Old Dental", false, true],
      ["Teeth Co", true, false],
    ]);
  });

  it("summarises one list per search with the combined count, the newest run first", () => {
    saved("done", [lead(SMILE), lead(OLDIE)]);
    const web = saved("done", [lead({ title: "Acme Events", website: "https://acme.test" })], { source: "web" }, { ...OPTIONS, keyword: "event agencies", city: "" });
    const newer = saved("cancelled", [lead(SMILE), lead(TEETH)], {}, { ...OPTIONS, keyword: "DENTIST" });
    const lists = listSummaries(store);
    expect(lists.map((l) => [l.title, l.count, l.runs, l.fresh])).toEqual([
      ["Dentist in Lisbon", 3, 2, 1],
      ["event agencies", 1, 1, 0],
    ]);
    // The cancelled re-run steps aside for the finished run; its rows still count.
    expect(lists[0]!.status).toBe("done");
    expect(lists[0]!.lastRun).toBe(newer.createdAt);
    expect(lists[1]!.id).toBe(web.id);
  });

  it("reads a list filled with --into as one run holding every row", () => {
    const into = saved("done", [lead(SMILE)]);
    store.appendLeads(into.id, [lead({ title: "Ortho Lisbon", place_id: "p-ortho", query: "orthodontist" })]);
    const read = readList(store, into.id)!;
    expect(read.list.runs).toBe(1);
    expect(read.list.rows.map((r) => r.title)).toEqual(["Smile Clinic", "Ortho Lisbon"]);
  });
});

describe("multi-keyword titles, hover text and searchKey grouping", () => {
  it("formats a readable title with +N, full keyword set in searchText, and groups by keyword set", async () => {
    const { listTitle, searchText } = await import("../src/jobs/lists.js");
    const multiA = job({
      options: { ...OPTIONS, keyword: "souvenir shop", keywords: ["souvenir shop", "纪念品店", "kedai cenderamata"], city: "Melaka" },
    });
    const multiReordered = job({
      options: { ...OPTIONS, keyword: "kedai cenderamata", keywords: ["Kedai Cenderamata", "souvenir shop", "纪念品店"], city: "melaka" },
    });
    const single = job({
      options: { ...OPTIONS, keyword: "souvenir shop", city: "Melaka" },
    });

    expect(listTitle(multiA.options)).toBe("Souvenir shop +2 in Melaka");
    expect(searchText(multiA.options)).toBe("souvenir shop, 纪念品店, kedai cenderamata in Melaka");

    // Same keyword set (regardless of order/casing) and same city -> same list.
    expect(searchKey(multiA)).toBe(searchKey(multiReordered));
    // Different keyword set -> separate list.
    expect(searchKey(multiA)).not.toBe(searchKey(single));

    const groups = groupRuns([multiReordered, multiA, single]);
    expect(groups).toHaveLength(2);
    const multiGroup = groups.find((g) => g.title === "Souvenir shop +2 in Melaka")!;
    expect(multiGroup.runs).toHaveLength(2);
    expect(groups.map((g) => g.title)).toContain("Souvenir shop in Melaka");
  });
});
