import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/main.js";
import { defaultOutPath, FOLDERID_DOWNLOADS, parseXdgDownloadsFromConfig, resolveDownloadsDir } from "../src/core/export/downloads.js";
import { RUN20_BATCH, RUN20_SITES_DIR } from "./fixtures/run20.js";

let dir: string;
let fixturePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-downloads-"));
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

describe("resolveDownloadsDir and defaultOutPath", () => {
  it("queries Windows FOLDERID_Downloads and follows a redirected Downloads folder", () => {
    const windowsKnownFolder = vi.fn(() => "D:\\OneDrive\\My Downloads");
    const resolved = resolveDownloadsDir({
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\Alice" },
      home: "C:\\Users\\Alice",
      windowsKnownFolder,
    });
    expect(windowsKnownFolder).toHaveBeenCalledWith(FOLDERID_DOWNLOADS);
    expect(resolved).toBe("D:\\OneDrive\\My Downloads");

    const out = defaultOutPath("event companies", "KL", new Date(2026, 10, 22, 9, 5), "csv", {
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\Alice" },
      home: "C:\\Users\\Alice",
      windowsKnownFolder,
    });
    expect(out).toBe("D:\\OneDrive\\My Downloads\\Business Finder\\business-finder-event-companies-kl-20261122-0905.csv");
  });

  it("uses XDG DOWNLOAD on non-Windows platforms and follows redirected paths", () => {
    const xdgUserDir = vi.fn(() => "/mnt/external/Downloads");
    const resolved = resolveDownloadsDir({
      platform: "linux",
      env: {},
      home: "/home/alice",
      xdgUserDir,
    });
    expect(xdgUserDir).toHaveBeenCalledWith("DOWNLOAD");
    expect(resolved).toBe("/mnt/external/Downloads");

    expect(
      resolveDownloadsDir({
        platform: "linux",
        env: {},
        home: "/home/alice",
        xdgUserDir: () => null,
        readFile: () => '# comment\nXDG_DOWNLOAD_DIR="$HOME/CustomDownloads"\n',
      }),
    ).toBe("/home/alice/CustomDownloads");

    expect(parseXdgDownloadsFromConfig('XDG_DOWNLOAD_DIR="${HOME}/Drop"', "/home/alice")).toBe("/home/alice/Drop");
  });

  it("saves to <Downloads>/Business Finder by default, prints the full path, and lets --out override", async () => {
    const redirectedDownloads = path.join(dir, "RedirectedDownloads");
    mkdirSync(redirectedDownloads, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BUSINESS_FINDER_FIXTURE: fixturePath,
      LOCALAPPDATA: path.join(dir, "data"),
      XDG_DATA_HOME: path.join(dir, "data"),
    };
    delete env.BUSINESS_FINDER_DOWNLOADS_DIR;

    const outDefault: string[] = [];
    const code1 = await main(["scrape", "souvenir shop", "--city", "Melaka", "--source", "fixture"], {
      out: (l) => outDefault.push(l),
      err: () => {},
      env,
      cwd: dir,
      now: () => new Date(2026, 10, 22, 9, 15),
      downloadsDir: () => redirectedDownloads,
    });
    expect(code1).toBe(0);
    const expectedDefault = path.join(redirectedDownloads, "Business Finder", "business-finder-souvenir-shop-melaka-20261122-0915.csv");
    expect(outDefault).toContain(`  saved → ${expectedDefault}`);
    expect(existsSync(expectedDefault)).toBe(true);

    const outExplicit: string[] = [];
    const customPath = path.join(dir, "custom", "my-leads.csv");
    const code2 = await main(["scrape", "souvenir shop", "--city", "Melaka", "--source", "fixture", "--out", customPath], {
      out: (l) => outExplicit.push(l),
      err: () => {},
      env,
      cwd: dir,
      now: () => new Date(2026, 10, 22, 9, 16),
      downloadsDir: () => {
        throw new Error("downloadsDir must not be used when --out is given");
      },
    });
    expect(code2).toBe(0);
    expect(outExplicit).toContain(`  saved → ${customPath}`);
    expect(existsSync(customPath)).toBe(true);
  });
});
