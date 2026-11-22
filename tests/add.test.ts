import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addToList,
  AddInputError,
  countryFromLeads,
  dedupeEntries,
  parseCsvRecords,
  parseWebFile,
  readWebFile,
  siteHost,
  type WebEntry,
} from "../src/cli/add.js";
import { main, parseCli } from "../src/cli/main.js";
import { toLead } from "../src/core/leads/normalize.js";
import { defaultJobsDir, JobStore, type Job } from "../src/jobs/store.js";
import { startTestServer } from "./helpers/startTestServer.js";
import { assertNoScrapedText, RUN20_BATCH, RUN20_SITES_DIR } from "./fixtures/run20.js";

let dir: string;
let env: NodeJS.ProcessEnv;
let fixturePath: string;
let webSites: string;

/** A fixture website at https://<host>/ listing one email. */
function site(host: string, body = `<p>Contact <a href="mailto:hello@${host}">us</a></p>`) {
  writeFileSync(path.join(webSites, `${host}.html`), `<html><body>${body}</body></html>`);
}

/** Points the fixture at the Maps run (for scrape) or at the web sites (for add). */
function useFixture(sitesDir: string) {
  writeFileSync(
    fixturePath,
    JSON.stringify({ geocode: { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" }, batches: [RUN20_BATCH], sitesDir }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-add-"));
  fixturePath = path.join(dir, "fixture.json");
  webSites = path.join(dir, "sites");
  mkdirSync(webSites);
  for (const n of [1, 2, 3, 4, 5]) site(`web-${n}.test`);
  useFixture(webSites);
  const data = path.join(dir, "data");
  env = {
    ...process.env,
    BUSINESS_FINDER_FIXTURE: fixturePath,
    BUSINESS_FINDER_DOWNLOADS_DIR: path.join(dir, "downloads"),
    LOCALAPPDATA: data,
    XDG_DATA_HOME: data,
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd: dir, now: () => new Date() });
  return { code, out, err, all: [...out, ...err].join("\n") };
}

const jobs = () => new JobStore(defaultJobsDir(env));

function listId(out: string[]): string {
  const id = out.at(-1)?.match(/^ {2}saved as list ([0-9a-f-]{36}); /)?.[1];
  expect(id).toBeDefined();
  return id!;
}

function file(name: string, text: string): string {
  writeFileSync(path.join(dir, name), text);
  return name;
}

describe("parseCsvRecords", () => {
  it("reads quoted fields with commas, doubled quotes and line breaks, and numbers lines", () => {
    const records = parseCsvRecords('name,website\r\n"A, ""B""",https://a.test/\n"two\nlines",https://b.test/\n\nlast,https://c.test/');
    expect(records).toEqual([
      { line: 1, fields: ["name", "website"] },
      { line: 2, fields: ['A, "B"', "https://a.test/"] },
      { line: 3, fields: ["two\nlines", "https://b.test/"] },
      { line: 6, fields: ["last", "https://c.test/"] },
    ]);
  });
});

describe("parseWebFile", () => {
  it("keeps good CSV lines and reports bad ones by line number without quoting them", () => {
    const { entries, skipped } = parseWebFile(
      [
        "﻿Name,Website,Phone,City,Note",
        "One,https://one.test/,+60 12-345 6789,Kuala Lumpur,weddings",
        ",https://nameless.test/",
        "Ftp,ftp://files.test/",
        "Script,javascript:alert(1)",
        "Bare,bare.test",
        "Empty,",
        "Two,http://two.test/about",
      ].join("\n"),
      "csv",
    );
    expect(entries).toEqual([
      { line: 2, name: "One", website: "https://one.test/", phone: "+60 12-345 6789", city: "Kuala Lumpur", note: "weddings" },
      { line: 8, name: "Two", website: "http://two.test/about" },
    ]);
    expect(skipped).toEqual([
      { line: 3, reason: "no name" },
      { line: 4, reason: "the website must start with http:// or https://" },
      { line: 5, reason: "the website must start with http:// or https://" },
      { line: 6, reason: "the website is not a full http:// or https:// address" },
      { line: 7, reason: "no website" },
    ]);
  });

  it("refuses a CSV whose header lacks name or website", () => {
    expect(() => parseWebFile("title,url\nA,https://a.test/", "csv")).toThrow(/no "name" column/);
    expect(() => parseWebFile("name,url\nA,https://a.test/", "csv")).toThrow(/no "website" column/);
  });

  it("reads JSONL and reports lines that are not JSON objects", () => {
    const { entries, skipped } = parseWebFile(
      ['{"name":"A","website":"https://a.test/"}', "", "not json", "[1]", '{"name":"B","website":"mailto:b@b.test"}'].join("\n"),
      "jsonl",
    );
    expect(entries).toEqual([{ line: 1, name: "A", website: "https://a.test/" }]);
    expect(skipped).toEqual([
      { line: 3, reason: "not valid JSON" },
      { line: 4, reason: "not a JSON object" },
      { line: 5, reason: "the website must start with http:// or https://" },
    ]);
  });
});

describe("readWebFile", () => {
  it("fails a file with no usable line, an empty file and an unknown extension", async () => {
    await expect(readWebFile(path.join(dir, file("bad.csv", "name,website\n,https://a.test/\nB,ftp://b.test/")))).rejects.toThrow(
      AddInputError,
    );
    await expect(readWebFile(path.join(dir, file("empty.csv", "")))).rejects.toThrow(/empty/);
    await expect(readWebFile(path.join(dir, file("empty.jsonl", "\n\n")))).rejects.toThrow(/No usable line/);
    await expect(readWebFile(path.join(dir, file("list.txt", "name,website")))).rejects.toThrow(/\.csv or \.jsonl/);
  });
});

describe("dedupeEntries", () => {
  const maps = [
    toLead({ title: "Maps A", website: "https://www.alpha.test/home", phone: "012-000 0001", source: "fixture", query: "q", city: "c" }, "MY"),
    toLead({ title: "Maps B", source: "fixture", phone: "03-2000 0002", query: "q", city: "c" }, "MY"),
  ];
  const entry = (line: number, website: string, phone?: string): WebEntry => ({ line, name: `E${line}`, website, ...(phone ? { phone } : {}) });

  it("skips a website host already in the list, and repeats within the file", () => {
    const { fresh, duplicates } = dedupeEntries(
      [entry(1, "http://alpha.test/other"), entry(3, "https://gamma.test/"), entry(4, "https://www.gamma.test/contact")],
      maps,
      "MY",
    );
    expect(fresh.map((e) => e.line)).toEqual([3]);
    expect(duplicates).toEqual([
      { line: 1, reason: "already in the list (same website)" },
      { line: 4, reason: "already in the list (same website)" },
    ]);
  });

  it("keeps a different name that shares a phone with the list, and skips the same name with that phone", () => {
    const { fresh, duplicates } = dedupeEntries(
      [
        entry(1, "https://beta.test/", "+60 3-2000 0002"),
        entry(2, "https://delta.test/", "+60120000001"),
        { line: 3, name: "maps b", website: "https://epsilon.test/", phone: "03-2000 0002" },
      ],
      maps,
      "MY",
    );
    expect(fresh.map((e) => e.line)).toEqual([1, 2]);
    expect(duplicates).toEqual([{ line: 3, reason: "already in the list (same phone and name)" }]);
  });

  it("reads hosts with or without a scheme and ignores www.", () => {
    expect(siteHost("https://WWW.Example.test/x")).toBe("example.test");
    expect(siteHost("example.test")).toBe("example.test");
    expect(siteHost("")).toBe("");
  });

  it("takes the country from the leads' WhatsApp links", () => {
    expect(countryFromLeads(maps)).toBe("MY");
    expect(countryFromLeads([])).toBe("");
  });
});

describe("business-finder add: parsing", () => {
  it("needs a file and exactly one of --title and --into", () => {
    expect(parseCli(["add", "x.csv", "--title", "Event companies KL"])).toEqual({
      command: "add",
      file: "x.csv",
      target: { title: "Event companies KL" },
      socials: true,
      source: "web",
    });
    expect(() => parseCli(["add", "x.csv"])).toThrow(/--title/);
    expect(() => parseCli(["add", "--title", "t"])).toThrow(/one file/);
    expect(() => parseCli(["add", "x.csv", "--title", "t", "--into", "0d4f2a9e-1111-4222-8333-444455556666"])).toThrow(/not both/);
    expect(() => parseCli(["add", "x.csv", "--into", "nope"])).toThrow(/list id/);
    expect(() => parseCli(["add", "x.csv", "--title", "t", "--country", "MYS"])).toThrow(/two-letter/);
  });
});

describe("business-finder add --title", () => {
  it("saves a new web list with source web on every lead and the list line last", async () => {
    const name = file(
      "found.csv",
      ["name,website,note", "Web 1,https://web-1.test/,stage hire", "Web 2,https://web-2.test/", "Nope,ftp://x.test/", "Web 3,https://web-3.test/"].join("\n"),
    );
    const r = await cli(["add", name, "--title", "Event companies KL", "--source", "fixture"]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  line 4 skipped: the website must start with http:// or https://");
    expect(r.out).toContain("✓ 3 leads (emails 3/3, phones 0/3, WhatsApp 0/3)");
    expect(r.out).toContain("  lines: 4 = added 3 + invalid 1 + duplicates 0");
    const id = listId(r.out);
    expect(r.all).not.toMatch(/web-\d\.test|Web \d|stage hire/);

    const job = jobs().get(id)!;
    expect(job).toMatchObject({
      status: "done",
      source: "web",
      owner: { kind: "cli", pid: process.pid },
      options: { keyword: "Event companies KL", city: "" },
      reconciliation: { found: 3, kept: 3, duplicates: 0, toCheck: 3, fetched: 3 },
    });
    const leads = jobs().readLeads(id);
    expect(leads).toHaveLength(3);
    expect(leads.every((l) => l.source === "web")).toBe(true);
    expect(leads[0]).toMatchObject({ title: "Web 1", query: "Event companies KL", note: "stage hire", emails: ["hello@web-1.test"] });
  });

  it("saves nothing when the file has no usable line", async () => {
    const r = await cli(["add", file("bad.csv", "name,website\n,https://web-1.test/\n"), "--title", "T", "--source", "fixture"]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/No usable line/);
    expect(jobs().list()).toEqual([]);
  });

  it("exits 2 for a missing file", async () => {
    const r = await cli(["add", "missing.csv", "--title", "T", "--source", "fixture"]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/Could not read/);
  });
});

describe("business-finder add --into", () => {
  async function mapsList(): Promise<string> {
    useFixture(RUN20_SITES_DIR);
    const r = await cli(["scrape", "souvenir shop", "--city", "Melaka", "--source", "fixture", "--out", "maps.csv"]);
    expect(r.code).toBe(0);
    useFixture(webSites);
    return listId(r.out);
  }

  it("appends new websites, skips a website the Maps list has, keeps a shared phone under another name, and keeps the Maps rows", async () => {
    const id = await mapsList();
    const before = jobs().readLeads(id);
    expect(before).toHaveLength(19);
    const name = file(
      "more.jsonl",
      [
        { name: "Web 1", website: "https://web-1.test/" },
        { name: "Copy of 2", website: "https://www.shop-2.test/" },
        // Place 3's mobile in international form under another name: a different business.
        { name: "Other at 3", website: "https://web-4.test/", phone: "+60 12-000 0003" },
        { name: "Web 5", website: "https://web-5.test/" },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n"),
    );
    const r = await cli(["add", name, "--into", id, "--source", "fixture"]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  line 2 skipped: already in the list (same website)");
    expect(r.all).not.toContain("line 3 skipped");
    expect(r.out).toContain("  lines: 4 = added 3 + invalid 0 + duplicates 1");
    expect(listId(r.out)).toBe(id);
    assertNoScrapedText(r.all);

    const after = jobs().readLeads(id);
    expect(after).toHaveLength(22);
    expect(after.slice(0, 19)).toEqual(before);
    expect(after.slice(0, 19).every((l) => l.source === "fixture")).toBe(true);
    expect(after.slice(19).every((l) => l.source === "web")).toBe(true);
    const job = jobs().get(id)!;
    expect(job.status).toBe("done");
    expect(job.reconciliation).toMatchObject({ found: 24, kept: 22, duplicates: 2 });
  });

  it("gives an added website with no phone the national number from its tel: link, read in the list's country", async () => {
    const id = await mapsList();
    site("web-9.test", '<p>Call <a href="tel:012-345 6789">us</a></p>');
    const r = await cli(["add", file("tel.csv", "name,website\nWeb 9,https://web-9.test/"), "--into", id, "--source", "fixture"]);
    expect(r.code).toBe(0);
    assertNoScrapedText(r.all);
    expect(jobs().readLeads(id).at(-1)).toMatchObject({ phone: "+60123456789", whatsapp: "https://wa.me/60123456789" });
  });

  it("refuses a list that is still running", async () => {
    const store = jobs();
    const job = store.create({ keyword: "k", city: "c", depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 60 });
    store.update(job.id, { status: "running" });
    const r = await cli(["add", file("one.csv", "name,website\nA,https://web-1.test/"), "--into", job.id, "--source", "fixture"]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/still running/);
    expect(store.readLeads(job.id)).toEqual([]);
  });

  it("holds the list as running while the websites are checked, so a second add is refused", async () => {
    const id = await mapsList();
    const store = jobs();
    const seen: { status?: string; second?: string } = {};
    const result = await addToList(
      [{ line: 2, name: "Web 1", website: "https://web-1.test/" }],
      { target: { into: id }, socials: false },
      {
        store,
        now: () => new Date(),
        onProgress: () => {},
        enrich: async (leads, _opts, onProgress) => {
          seen.status = store.get(id)?.status;
          try {
            await addToList([{ line: 2, name: "Web 2", website: "https://web-2.test/" }], { target: { into: id }, socials: false }, {
              store,
              now: () => new Date(),
              onProgress: () => {},
              enrich: async () => ({ leads: [], counts: { toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 } }),
            });
          } catch (e) {
            seen.second = (e as Error).message;
          }
          onProgress?.({ checked: 0, toCheck: 0 });
          return { leads, counts: { toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: leads.length } };
        },
      },
    );
    expect(seen.status).toBe("running");
    expect(seen.second).toMatch(/still running/);
    expect(result.added).toHaveLength(1);
    const job = store.get(id)!;
    expect(job).toMatchObject({ status: "done", progress: { stage: "done" } });
    expect(job.held).toBeUndefined();
    expect(store.readLeads(id)).toHaveLength(20);
  });

  it("puts the list back as it was when checking the websites fails", async () => {
    const id = await mapsList();
    const store = jobs();
    const before = store.get(id)!;
    await expect(
      addToList([{ line: 2, name: "Web 1", website: "https://web-1.test/" }], { target: { into: id }, socials: false }, {
        store,
        now: () => new Date(),
        onProgress: () => {},
        enrich: async () => {
          throw new Error("network down");
        },
      }),
    ).rejects.toThrow("network down");
    expect(store.get(id)).toEqual(before);
    expect(store.readLeads(id)).toHaveLength(19);
  });

  it("refuses a list that does not exist", async () => {
    const r = await cli(["add", file("one.csv", "name,website\nA,https://web-1.test/"), "--into", "0d4f2a9e-1111-4222-8333-444455556666", "--source", "fixture"]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/No list/);
  });

  it("shows the added leads in a server started afterwards", async () => {
    const id = await mapsList();
    const name = file("more.csv", "name,website\nWeb 1,https://web-1.test/\nWeb 2,https://web-2.test/");
    expect((await cli(["add", name, "--into", id, "--source", "fixture"])).code).toBe(0);
    const server = await startTestServer({
      open: false,
      staticDir: path.join(dir, "no-web"),
      jobsDir: defaultJobsDir(env),
      source: "fixture",
      fixtureFile: fixturePath,
    });
    try {
      const listed = (await (await fetch(`http://127.0.0.1:${server.port}/api/v1/jobs`)).json()) as { jobs: Job[] };
      expect(listed.jobs.map((j) => [j.id, j.status])).toEqual([[id, "done"]]);
      const rows = (await (await fetch(`http://127.0.0.1:${server.port}/api/v1/jobs/${id}/download?format=json`)).json()) as unknown[];
      expect(rows).toHaveLength(21);
    } finally {
      await server.close();
    }
    expect(readdirSync(defaultJobsDir(env))).toEqual([id]);
  });

  it("still recognises existing rows in an old-shape list without rewriting them on disk", async () => {
    useFixture(webSites);
    const store = jobs();
    const job = store.create({ keyword: "event", city: "KL", depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 600 });
    store.appendLeads(job.id, [
      {
        title: "Old Website Match",
        address: "Old Website Match, 1 Jalan Lama",
        website: "https://www.web-1.test/",
        source: "browser",
        query: "event",
        city: "KL",
        whatsapp: "",
        emails: ["you@company.com"],
        email_source_url: "https://www.web-1.test/",
        email_status: "found",
        website_status: "found",
        instagram: "",
        facebook: "",
        linkedin: "",
        tiktok: "",
        youtube: "",
        x: "",
        fetched_at: "2026-11-18T00:00:00.000Z",
      },
      {
        title: "Old Phone Match",
        address: "Old Phone Match, 2 Jalan Lama",
        phone: "012-345 6789",
        source: "browser",
        query: "event",
        city: "KL",
        whatsapp: "https://wa.me/60123456789",
        emails: [],
        email_source_url: "",
        email_status: "no_website",
        website_status: "no_website",
        instagram: "",
        facebook: "",
        linkedin: "",
        tiktok: "",
        youtube: "",
        x: "",
        fetched_at: "2026-11-18T00:00:00.000Z",
      },
    ]);
    store.update(job.id, { status: "done", progress: { stage: "done", places: 2, message: "Found 2 leads in KL." } });

    const leadsFile = path.join(defaultJobsDir(env), job.id, "leads.jsonl");
    const linesBefore = readFileSync(leadsFile, "utf8").trim().split("\n");

    const csv = file(
      "more.csv",
      [
        "name,website,phone",
        "Different Name,https://web-1.test/,",
        "Old Phone Match,https://web-other.test/,+60 12-345 6789",
        "Brand New,https://web-2.test/,",
      ].join("\n"),
    );
    const r = await cli(["add", csv, "--into", job.id, "--source", "fixture"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  line 2 skipped: already in the list (same website)");
    expect(r.out).toContain("  line 3 skipped: already in the list (same phone and name)");
    expect(r.out).toContain("  lines: 3 = added 1 + invalid 0 + duplicates 2");

    const linesAfter = readFileSync(leadsFile, "utf8").trim().split("\n");
    expect(linesAfter.slice(0, 2)).toEqual(linesBefore);
    expect(linesAfter).toHaveLength(3);
  });
});
