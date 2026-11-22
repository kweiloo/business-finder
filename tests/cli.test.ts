import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/main.js";
import { BLOCKED_MESSAGE } from "../src/core/pipeline.js";
import { probePort } from "../src/server/serve.js";
import { VERSION } from "../src/version.js";
import { hit, KUALA_LUMPUR, MELAKA_CITY, MELAKA_STATE, PENANG } from "./fixtures/nominatim.js";
import { makeBatch } from "./fixtures/batch.js";
import { assertNoScrapedText, RUN20_BATCH, RUN20_PLACES, RUN20_SITES_DIR } from "./fixtures/run20.js";
import { ALL_COLUMNS, EXTRA_PLACE_COLUMNS, LEAN_COLUMNS } from "../src/core/export/csv.js";

// The real probe by default; single tests stub one answer.
vi.mock("../src/server/serve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/serve.js")>();
  return { ...actual, probePort: vi.fn(actual.probePort) };
});

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

let dir: string;
let fixturePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-cli-"));
  fixturePath = path.join(dir, "run20.json");
  writeFileSync(
    fixturePath,
    JSON.stringify({
      geocode: { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" },
      batches: [RUN20_BATCH],
      sitesDir: RUN20_SITES_DIR,
    }),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bun", [MAIN, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      BUSINESS_FINDER_FIXTURE: fixturePath,
      BUSINESS_FINDER_DOWNLOADS_DIR: path.join(dir, "downloads"),
      LOCALAPPDATA: path.join(dir, "data"),
      XDG_DATA_HOME: path.join(dir, "data"),
      ...env,
    },
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, all: result.stdout + result.stderr };
}

const SCRAPE = ["scrape", "souvenir shop", "--city", "Melaka", "--source", "fixture"];

describe("assertNoScrapedText", () => {
  it("throws on a fixture title", () => {
    expect(() => assertNoScrapedText("✓ 19 leads\nZZMARK-1\n")).toThrow(/ZZMARK-1/);
  });

  it("throws on an email, a phone, an address and a social handle", () => {
    expect(() => assertNoScrapedText("zzmark3@shop-3.test")).toThrow();
    expect(() => assertNoScrapedText("012-000 0007")).toThrow();
    expect(() => assertNoScrapedText("+60120000007")).toThrow();
    expect(() => assertNoScrapedText("4 Jalan Ujian")).toThrow();
    expect(() => assertNoScrapedText("instagram.com/ZzMark_shop")).toThrow();
  });

  it("accepts counts and paths", () => {
    expect(() => assertNoScrapedText("✓ 19 leads (emails 10/19)\n  saved → C:\\out\\leads.csv\n")).not.toThrow();
  });
});

describe("business-finder scrape --source fixture", () => {
  it("saves the CSV, exits 0 and prints only the documented lines", () => {
    const r = run(SCRAPE);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split(/\r?\n/);
    expect(lines[0]).toBe("▶ Geocoding Melaka…");
    expect(lines[1]).toBe("  Searching around Melaka, Malaysia");
    expect(lines).toContain("  searching: 20 places");
    expect(lines).toContain("  checking websites: 10/10");
    expect(lines).toContain("✓ 19 leads (emails 10/19, phones 18/19, WhatsApp 12/19, same phone 0/19)");
    expect(lines).toContain("  reconciliation: found 20 = kept 19 + filtered 0 + duplicates 1");
    expect(lines.some((l) => l.startsWith("  reached the end of Google Maps' results: "))).toBe(true);
    const saved = lines.at(-2)!.match(/^ {2}saved → (.+)$/)?.[1];
    expect(saved).toBeDefined();
    expect(path.isAbsolute(saved!)).toBe(true);
    expect(path.basename(saved!)).toMatch(/^business-finder-souvenir-shop-melaka-\d{8}-\d{4}\.csv$/);
    expect(path.dirname(saved!).toLowerCase()).toBe(path.resolve(dir, "downloads", "Business Finder").toLowerCase());
    expect(readFileSync(saved!, "utf8").startsWith("﻿title,phone,whatsapp")).toBe(true);
    expect(lines.at(-1)).toMatch(/^ {2}saved as list [0-9a-f-]{36}; run `business-finder serve` to see it$/);
    for (const line of lines) {
      expect(line).toMatch(/^(▶ Geocoding |  Searching around |  searching: |  checking websites: |✓ |  reconciliation: |  reached the end of Google Maps' results: |  saved → |  saved as list )/);
    }
    assertNoScrapedText(r.all);
  });

  it("fails the leak check when the output carries a scraped value", () => {
    // The city is echoed, so a city spelled like a fixture title plants one.
    const r = run(["scrape", "souvenir shop", "--city", "ZZMARK-1", "--source", "fixture"]);
    expect(r.code).toBe(0);
    expect(() => assertNoScrapedText(r.all)).toThrow(/zzmark/i);
  });

  it("writes JSON with --out file.json and the full columns with --full", () => {
    const r = run([...SCRAPE, "--out", "out.json", "--full", "--limit", "5"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("  reconciliation: found 20 = kept 5 + filtered 14 + duplicates 1");
    const rows = JSON.parse(readFileSync(path.join(dir, "out.json"), "utf8")) as Record<string, unknown>[];
    expect(rows).toHaveLength(5);
    expect(Object.keys(rows[0]!)).toContain("place_id");
    assertNoScrapedText(r.all);
  });

  it("writes every extra place column once after the lean set with --full, input_id holding the keyword", () => {
    const r = run([...SCRAPE, "--full", "--out", "full.csv"]);
    expect(r.code).toBe(0);
    const text = readFileSync(path.join(dir, "full.csv"), "utf8");
    const header = text.slice(1).split(/\r\n/)[0]!.split(",");
    const expectedCsvColumns = ALL_COLUMNS.map((c) => (c === "email_types" ? "Email type" : c === "email_mx" ? "Can receive mail" : c));
    expect(header).toEqual(expectedCsvColumns);
    expect(header.slice(0, LEAN_COLUMNS.length)).toEqual(expectedCsvColumns.slice(0, LEAN_COLUMNS.length));
    for (const name of EXTRA_PLACE_COLUMNS) expect(header.filter((c) => c === name)).toHaveLength(1);
    assertNoScrapedText(r.all);
    const j = run([...SCRAPE, "--full", "--out", "full.json"]);
    expect(j.code).toBe(0);
    const rows = JSON.parse(readFileSync(path.join(dir, "full.json"), "utf8")) as Record<string, unknown>[];
    expect(Object.keys(rows[0]!)).toEqual(ALL_COLUMNS);
    expect(rows.every((row) => row.input_id === "souvenir shop")).toBe(true);
    assertNoScrapedText(j.all);
  }, 30_000);

  it("writes exactly the --fields columns in the given order", () => {
    const r = run([...SCRAPE, "--fields", "title,phone,plus_code", "--out", "some.csv"]);
    expect(r.code).toBe(0);
    const text = readFileSync(path.join(dir, "some.csv"), "utf8");
    expect(text.slice(1).split(/\r\n/)[0]).toBe("title,phone,plus_code");
    assertNoScrapedText(r.all);
  });

  it("exits 2 on a misspelt --fields name, lists the valid names and scrapes nothing", () => {
    // A fixture that cannot be read proves the source was never opened.
    const r = run([...SCRAPE, "--fields", "titel,phone", "--out", "bad.csv"], { BUSINESS_FINDER_FIXTURE: path.join(dir, "missing.json") });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`Unknown column(s): titel. Valid columns: ${ALL_COLUMNS.join(", ")}`);
    expect(r.stderr).not.toContain("missing.json");
    expect(r.stdout).toBe("");
    expect(existsSync(path.join(dir, "bad.csv"))).toBe(false);
    expect(existsSync(path.join(dir, "data"))).toBe(false);
  });

  it("exits 2 with the valid names when --fields is empty", () => {
    const r = run([...SCRAPE, "--fields", " , "]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`No columns given. Valid columns: ${ALL_COLUMNS.join(", ")}`);
    expect(r.stdout).toBe("");
  });

  it("keeps two places that share a phone, points each at the other and counts them", () => {
    // ZZMARK-21 is a different place (own place_id) with ZZMARK-13's phone.
    const twin = { ...RUN20_PLACES[12]!, title: "ZZMARK-21", place_id: "ZZPLACE-21", data_id: "0x0:0x15" };
    writeFileSync(fixturePath, JSON.stringify({
      geocode: { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" },
      batches: [makeBatch([...RUN20_PLACES, twin])],
      sitesDir: RUN20_SITES_DIR,
    }));
    const r = run([...SCRAPE, "--json", "--out", "twins.json", "--fields", "title,phone,same_phone_as"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ 20 leads (emails 10/20, phones 19/20, WhatsApp 12/20, same phone 2/20)");
    const rows = JSON.parse(readFileSync(path.join(dir, "twins.json"), "utf8")) as { title: string; same_phone_as: string[] }[];
    expect(rows).toHaveLength(20);
    const flagged = rows.filter((row) => row.same_phone_as.length > 0);
    expect(flagged.map((row) => [row.title, row.same_phone_as])).toEqual([
      ["ZZMARK-13", ["ZZMARK-21"]],
      ["ZZMARK-21", ["ZZMARK-13"]],
    ]);
    assertNoScrapedText(r.all);
  });

  it("writes JSON to the default Downloads subfolder with --json", () => {
    const r = run([...SCRAPE, "--json"]);
    expect(r.code).toBe(0);
    const exportDir = path.join(dir, "downloads", "Business Finder");
    expect(readdirSync(exportDir).some((f) => /^business-finder-souvenir-shop-melaka-\d{8}-\d{4}\.json$/.test(f))).toBe(true);
  });

  it("exits 1 with a plain message when the run fails", () => {
    writeFileSync(fixturePath, JSON.stringify({ geocode: null, batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR }));
    const r = run(SCRAPE);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe("City not found: Melaka");
    expect(r.all).not.toMatch(/\bat .+:\d+:\d+/);
  });

  it("prints the city a state resolves to from the OpenStreetMap names", () => {
    writeFileSync(
      fixturePath,
      JSON.stringify({ geocodeHits: [hit(MELAKA_STATE), hit(MELAKA_CITY)], batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR }),
    );
    const r = run(SCRAPE);
    expect(r.code).toBe(0);
    expect(r.stdout.split(/\r?\n/).slice(0, 2)).toEqual([
      "▶ Geocoding Melaka…",
      "  Searching around Bandaraya Melaka, Malaysia",
    ]);
    assertNoScrapedText(r.all);
  });

  it("exits 1 without searching when the place is in another country than --country", () => {
    const pojuca = { name: "Pojuca", addresstype: "town", lat: -12.43, lon: -38.33, countryCode: "BR", bbox: { south: -12.47, north: -12.39, west: -38.37, east: -38.29 } };
    writeFileSync(fixturePath, JSON.stringify({ geocodeHits: [pojuca], batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR }));
    const r = run(["scrape", "event management", "--city", "PJ", "--country", "MY", "--source", "fixture", "--out", "pj.csv"]);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe("PJ matched Pojuca in Brazil, not Malaysia. Write the full place name with its region and country.");
    expect(r.stdout).not.toContain("searching:");
  });

  it("exits 1 without searching when the place is a state with no city of that name", () => {
    writeFileSync(fixturePath, JSON.stringify({ geocodeHits: [hit(PENANG)], batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR }));
    const r = run(["scrape", "souvenir shop", "--city", "Penang", "--source", "fixture", "--out", "penang.csv"]);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe("Penang is a whole state, too large for one search. Search towns inside it instead; you can give several at once.");
    expect(r.stdout).not.toContain("searching:");
    expect(existsSync(path.join(dir, "penang.csv"))).toBe(false);
  });

  it("exits 1 after saving the places read when Google blocks the search", () => {
    writeFileSync(
      fixturePath,
      JSON.stringify({
        geocode: { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" },
        batches: [RUN20_BATCH],
        sitesDir: RUN20_SITES_DIR,
        reason: "blocked",
      }),
    );
    const r = run([...SCRAPE, "--out", "blocked.csv"]);
    expect(r.code).toBe(1);
    expect(existsSync(path.join(dir, "blocked.csv"))).toBe(true);
    expect(r.stdout).toContain("  saved → ");
    expect(r.stderr.trim()).toBe(BLOCKED_MESSAGE);
    assertNoScrapedText(r.all);
  });

  it("exits 0 and says so when the run stops at the time limit", () => {
    writeFileSync(
      fixturePath,
      JSON.stringify({
        geocode: { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" },
        batches: [RUN20_BATCH],
        sitesDir: RUN20_SITES_DIR,
        reason: "timeout",
      }),
    );
    const r = run([...SCRAPE, "--max-time", "45", "--out", "timeout.csv"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, "timeout.csv"))).toBe(true);
    const lines = r.stdout.trimEnd().split(/\r?\n/);
    expect(lines).toContain("  stopped at the time limit (--max-time 45)");
    expect(lines.at(-2)).toMatch(/^ {2}saved → /);
    assertNoScrapedText(r.all);
  });

  it("does not print the time-limit line when the search finished", () => {
    const r = run(SCRAPE);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("time limit");
  });

  it("prints the retry line and succeeds when blockedAttempts recovers", () => {
    writeFileSync(
      fixturePath,
      JSON.stringify({
        geocode: { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" },
        batches: [RUN20_BATCH],
        sitesDir: RUN20_SITES_DIR,
        blockedAttempts: 1,
        blockRetryDelaysMs: [50],
      }),
    );
    const r = run([...SCRAPE, "--out", "retried.csv"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("  Google is limiting this computer; trying again in 1 s (1 of 1)");
    assertNoScrapedText(r.all);
  });

  it("runs a multi-cell grid with --whole-city and stops at --limit", () => {
    const cellA = makeBatch(
      Array.from({ length: 15 }, (_, i) => ({ title: `ZZMARK-A${i}`, place_id: `ZZA-${i}`, phone: `012-100 ${String(i).padStart(4, "0")}` })),
    );
    const cellB = makeBatch(
      Array.from({ length: 15 }, (_, i) => ({ title: `ZZMARK-B${i}`, place_id: `ZZB-${i}`, phone: `012-200 ${String(i).padStart(4, "0")}` })),
    );
    writeFileSync(
      fixturePath,
      JSON.stringify({
        geocodeHits: [hit(KUALA_LUMPUR)],
        batches: [cellA],
        cellBatches: [[cellA], [cellB]],
        sitesDir: RUN20_SITES_DIR,
      }),
    );
    const r = run(["scrape", "souvenir shop", "--city", "Kuala Lumpur", "--whole-city", "--limit", "25", "--source", "fixture", "--out", "grid.csv"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ 25 leads");
    expect(r.stdout).toMatch(/\(cell 1\/\d+\)/);
    expect(r.stdout).not.toContain("reached the end of Google Maps' results");
  });

  it("names only the error type when something unexpected fails", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(SCRAPE, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: { ...process.env, BUSINESS_FINDER_FIXTURE: fixturePath, LOCALAPPDATA: path.join(dir, "data"), XDG_DATA_HOME: path.join(dir, "data") },
      cwd: dir,
      now: () => {
        // Stands in for a browser error whose message carries page text.
        throw new TypeError("ZZMARK-1 zzmark3@shop-3.test 4 Jalan Ujian");
      },
    });
    expect(code).toBe(1);
    expect(err).toEqual(["business-finder failed unexpectedly (TypeError)"]);
    const all = [...out, ...err].join("\n");
    expect(all).not.toMatch(/\bat .+:\d+:\d+/);
    assertNoScrapedText(all);
  });

  it("does not trust an error type name that carries text", async () => {
    const err: string[] = [];
    const planted = new Error("boom");
    planted.name = "ZZMARK-1 shop";
    const code = await main(SCRAPE, {
      out: () => {},
      err: (l) => err.push(l),
      env: { ...process.env, BUSINESS_FINDER_FIXTURE: fixturePath, LOCALAPPDATA: path.join(dir, "data"), XDG_DATA_HOME: path.join(dir, "data") },
      cwd: dir,
      now: () => {
        throw planted;
      },
    });
    expect(code).toBe(1);
    expect(err).toEqual(["business-finder failed unexpectedly (Error)"]);
  });

  it("exits 2 when the fixture file cannot be read", () => {
    const r = run(SCRAPE, { BUSINESS_FINDER_FIXTURE: path.join(dir, "missing.json") });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("missing.json");
    expect(r.all).not.toMatch(/\bat .+:\d+:\d+/);
  });

  it("exits 2 when BUSINESS_FINDER_FIXTURE is missing", () => {
    const r = run(SCRAPE, { BUSINESS_FINDER_FIXTURE: "" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("BUSINESS_FINDER_FIXTURE");
  });
});

describe("doctor port line", () => {
  async function doctorLines(state: "free" | "in_use" | "reserved") {
    vi.mocked(probePort).mockResolvedValueOnce(state);
    const out: string[] = [];
    await main(["doctor"], {
      out: (l) => out.push(l),
      err: () => {},
      env: { ...process.env, LOCALAPPDATA: path.join(dir, "data"), XDG_DATA_HOME: path.join(dir, "data") },
      cwd: dir,
      now: () => new Date(),
    });
    expect(probePort).toHaveBeenLastCalledWith(8080);
    return out;
  }

  it("says a port reserved by Windows is reserved, not in use", async () => {
    expect(await doctorLines("reserved")).toContain("  port 8080: reserved by Windows (serve will pick the next free port)");
  });

  it("says a port another program holds is in use", async () => {
    expect(await doctorLines("in_use")).toContain("  port 8080: in use (serve will pick the next free port)");
  });

  it("says a free port is free", async () => {
    expect(await doctorLines("free")).toContain("✓ port 8080: free");
  });
});

describe("setup problems exit 2", () => {
  it("doctor lists the searched browsers when none is found", () => {
    const r = run(["doctor"], { BUSINESS_FINDER_CHROME: "/nonexistent" });
    expect(r.code).toBe(2);
    expect(r.all).toContain("searched:");
    expect(r.all).toContain("/nonexistent");
    expect(r.all).toContain(VERSION);
    expect(r.all).not.toMatch(/\bat .+:\d+:\d+/);
  });

  it("scrape with the browser source stops before running when no browser is found", () => {
    const r = run(["scrape", "souvenir shop", "--city", "Melaka"], { BUSINESS_FINDER_CHROME: "/nonexistent" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("searched:");
    expect(r.stderr).toContain("/nonexistent");
    expect(r.stdout).toBe("");
    expect(r.all).not.toMatch(/\bat .+:\d+:\d+/);
  });

  it("an unknown flag prints the usage", () => {
    const r = run([...SCRAPE, "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--bogus");
    expect(r.stderr).toContain("Usage:");
    expect(existsSync(path.join(dir, "out.csv"))).toBe(false);
  });

  it.each([
    [["scrape", "--city", "Melaka", "--source", "fixture"]],
    [["scrape", "souvenir shop", "--source", "fixture"]],
    [[...SCRAPE, "--depth", "0"]],
    [[...SCRAPE, "--limit", "abc"]],
    [[...SCRAPE, "--limit", "1001"]],
    [[...SCRAPE, "--country", "Malaysia"]],
    [[...SCRAPE, "--source", "api"]],
    [[...SCRAPE, "--out", "leads.xlsx"]],
    [[...SCRAPE, "--out", "leads.csv", "--json"]],
    [[...SCRAPE, "--full", "--fields", "title"]],
    [["fly"]],
  ])("rejects %j", (args) => {
    const r = run(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Usage:");
  });
});

describe("business-finder --version and leadscout alias", () => {
  it("prints the version", () => {
    const r = run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`business-finder ${VERSION}`);
  });

  it("prints the rename notice once to stderr and runs the command when invoked as leadscout", () => {
    const r = run(["--version"], { BUSINESS_FINDER_ALIASED_FROM: "leadscout" });
    expect(r.code).toBe(0);
    expect(r.stderr.trim()).toBe("leadscout is now called business-finder");
    expect(r.stdout.trim()).toBe(`business-finder ${VERSION}`);
  });

  it("keeps stdout valid JSON when invoked as leadscout with lists --json", () => {
    const r = run(["lists", "--json"], { BUSINESS_FINDER_ALIASED_FROM: "leadscout" });
    expect(r.code).toBe(0);
    expect(r.stderr.trim()).toBe("leadscout is now called business-finder");
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it("refuses to move or create an empty new folder when an old installer-managed folder holds app/", () => {
    const dataRoot = path.join(dir, "blocked-data");
    const oldDir = path.join(dataRoot, "leadscout");
    const newDir = path.join(dataRoot, "business-finder");
    mkdirSync(path.join(oldDir, "app"), { recursive: true });
    mkdirSync(path.join(oldDir, "jobs"), { recursive: true });

    const r = run(["lists"], { LOCALAPPDATA: dataRoot, XDG_DATA_HOME: dataRoot });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("re-run the installer");
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(newDir)).toBe(false);
  });
  it("reports a plain error with the path and OS reason when the data folder cannot be created or written across commands", async () => {
    const blocker = path.join(dir, "blocked");
    writeFileSync(blocker, "not a directory");
    const blockedEnv = {
      ...process.env,
      BUSINESS_FINDER_FIXTURE: fixturePath,
      BUSINESS_FINDER_DOWNLOADS_DIR: path.join(dir, "downloads"),
      LOCALAPPDATA: blocker,
      XDG_DATA_HOME: blocker,
    };

    const commands: Array<{ argv: string[]; expectedCode: number; prefix?: string }> = [
      { argv: ["doctor"], expectedCode: 2 },
      { argv: SCRAPE, expectedCode: 1 },
      { argv: ["lists"], expectedCode: 1 },
      { argv: ["delete", "0d4f2a9e-1111-4222-8333-444455556666"], expectedCode: 1 },
      { argv: ["serve", "--no-open", "--port", "0"], expectedCode: 1, prefix: "Could not start the server: " },
    ];
    for (const c of commands) {
      const err: string[] = [];
      const code = await main(c.argv, {
        out: () => {},
        err: (l) => err.push(l),
        env: blockedEnv,
        cwd: dir,
        now: () => new Date(),
        untilStopped: () => new Promise(() => {}),
      });
      expect(code).toBe(c.expectedCode);
      expect(err).toHaveLength(1);
      expect(err[0]).not.toContain("failed unexpectedly");
      if (c.prefix) expect(err[0]!.startsWith(c.prefix)).toBe(true);
      expect(err[0]).toContain("Business Finder can't write to");
      expect(err[0]).toContain("business-finder");
      expect(err[0]).toContain("path is not a folder");
      expect(err[0]).toContain("allow it to write to your user folder and try again.");
    }
  });

  it("reports a plain write error when migrating an old data folder fails on EACCES", async () => {
    const { migrateDataDir } = await import("../src/jobs/store.js");
    const fs = await import("node:fs");
    const base = path.join(dir, "eacces-migrate");
    mkdirSync(path.join(base, "leadscout", "jobs"), { recursive: true });
    await expect(
      migrateDataDir({
        env: { LOCALAPPDATA: base, XDG_DATA_HOME: base },
        fs: {
          ...fs,
          renameSync: () => {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          },
        },
      }),
    ).rejects.toThrow(/Business Finder can't write to .*business-finder \(access denied\)\. If an AI agent is running this, allow it to write to your user folder and try again\./);
  });

  it("reports plain messages for CancelledError and ReconciliationError instead of failed unexpectedly", async () => {
    const { CancelledError, ReconciliationError } = await import("../src/core/errors.js");
    for (const [thrown, expected] of [
      [new CancelledError(), "Search cancelled."],
      [new ReconciliationError("count mismatch"), "Something went wrong while checking the search results. Try again."],
    ] as const) {
      const err: string[] = [];
      const code = await main(SCRAPE, {
        out: () => {},
        err: (l) => err.push(l),
        env: {
          ...process.env,
          BUSINESS_FINDER_FIXTURE: fixturePath,
          BUSINESS_FINDER_DOWNLOADS_DIR: path.join(dir, "downloads"),
          LOCALAPPDATA: path.join(dir, "data"),
          XDG_DATA_HOME: path.join(dir, "data"),
        },
        cwd: dir,
        now: () => {
          throw thrown;
        },
      });
      expect(code).toBe(1);
      expect(err).toEqual([expected]);
    }
  });
});

describe("multi-keyword and multi-city CLI", () => {
  it("runs 3 keywords into one list, prints per-keyword counts and reconciliation, and exports non-Latin query", () => {
    const batch1 = makeBatch([
      { title: "ZZMARK-1", place_id: "ZZPLACE-01", phone: "012-000 0001" },
      { title: "ZZMARK-2", place_id: "ZZPLACE-02", phone: "012-000 0002" },
    ]);
    const batch2 = makeBatch([
      { title: "ZZMARK-2", place_id: "ZZPLACE-02", phone: "012-000 0002" },
      { title: "ZZMARK-3", place_id: "ZZPLACE-03", phone: "012-000 0003" },
    ]);
    const batch3 = makeBatch([
      { title: "ZZMARK-1", place_id: "ZZPLACE-01", phone: "012-000 0001" },
      { title: "ZZMARK-4", place_id: "ZZPLACE-04", phone: "012-000 0004" },
    ]);
    writeFileSync(
      fixturePath,
      JSON.stringify({
        geocode: { lat: 2.3293744, lon: 102.2880962, countryCode: "MY" },
        batches: [batch1],
        keywordBatches: {
          "souvenir shop": [batch1],
          "纪念品店": [batch2],
          "kedai cenderamata": [batch3],
        },
        sitesDir: RUN20_SITES_DIR,
      }),
    );

    const r = run(["scrape", "souvenir shop, 纪念品店, kedai cenderamata", "--city", "Melaka", "--source", "fixture", "--full", "--out", "multi.csv"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ 4 leads");
    expect(r.stdout).toContain("  reconciliation: found 6 = kept 4 + filtered 0 + duplicates 2");
    expect(r.stdout).toContain('  keyword "souvenir shop": 2 added, 0 duplicates (2 found)');
    expect(r.stdout).toContain('  keyword "纪念品店": 1 added, 1 duplicates (2 found)');
    expect(r.stdout).toContain('  keyword "kedai cenderamata": 1 added, 1 duplicates (2 found)');
    assertNoScrapedText(r.all);

    const csv = readFileSync(path.join(dir, "multi.csv"), "utf8");
    expect(csv).toContain("纪念品店");
    expect(csv).toContain("kedai cenderamata");
  });

  it("runs multiple --city flags and serves both cities from the geocode cache on the second run", async () => {
    const { createGeocoder } = await import("../src/core/geo/geocoder.js");
    const cacheFile = path.join(dir, "geo-cache.json");
    let fetches = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      fetches += 1;
      const q = new URL(input.toString()).searchParams.get("q");
      if (q === "Melaka") return new Response(JSON.stringify([{ name: "Bandaraya Melaka", addresstype: "city", lat: "2.1943", lon: "102.2487", address: { country_code: "MY" }, boundingbox: ["2.15", "2.25", "102.20", "102.30"] }]));
      return new Response(JSON.stringify([{ name: "Ipoh", addresstype: "city", lat: "4.5987", lon: "101.0900", address: { country_code: "MY" }, boundingbox: ["4.51", "4.78", "100.99", "101.36"] }]));
    }) as typeof fetch;

    const { runScrape } = await import("../src/core/pipeline.js");
    const { run20Enrich, run20Source } = await import("./fixtures/run20.js");
    const opts = { keyword: "souvenir shop", city: "Melaka", cities: ["Melaka", "Ipoh"], depth: 1, lang: "en", emails: false, socials: false, deep: false, maxSeconds: 600 };

    await runScrape(opts, { source: run20Source(), geocode: createGeocoder({ cacheFile, fetchFn, pacer: { wait: async () => {} } }), enrich: run20Enrich, now: () => new Date() }, () => {});
    expect(fetches).toBe(2);

    // Second run with a fresh geocoder hits the cache for both cities (0 fetches).
    await runScrape(opts, { source: run20Source(), geocode: createGeocoder({ cacheFile, fetchFn, pacer: { wait: async () => {} } }), enrich: run20Enrich, now: () => new Date() }, () => {});
    expect(fetches).toBe(2);
  });
});
