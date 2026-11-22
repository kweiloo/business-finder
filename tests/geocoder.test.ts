import { describe, expect, it, vi } from "vitest";
import { GeocodeUnavailableError } from "../src/core/geo/geocode.js";
import { createGeocoder, GEOCODE_HOST, type GeocoderFs } from "../src/core/geo/geocoder.js";
import { type Capture, hit, JB_TOWN, MELAKA_CITY, MELAKA_STATE, raw } from "./fixtures/nominatim.js";

const IPOH: Capture = ["Majlis Bandaraya Ipoh", "city", 4.5986817, 101.0900236, [4.5125369, 4.7840614, 100.9973945, 101.3654305], "MY"];

const CACHE = "/data/business-finder/geocode-cache.json";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A filesystem held in a map; enough of `node:fs` for the geocoder. */
function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fs = {
    readFileSync: (file: string) => {
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return text;
    },
    writeFileSync: (file: string, data: string) => void files.set(file, data),
    renameSync: (from: string, to: string) => {
      const text = files.get(from);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${from}`), { code: "ENOENT" });
      files.delete(from);
      files.set(to, text);
    },
    mkdirSync: () => undefined,
  };
  return { files, fs: fs as unknown as GeocoderFs };
}

/** Answers every Nominatim request with the hits stored for its `q`. */
function nominatim(answers: Record<string, unknown[]>) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const q = new URL(input.toString()).searchParams.get("q") ?? "";
    return new Response(JSON.stringify(answers[q] ?? []));
  });
}

const ANSWERS = { Melaka: [raw(MELAKA_STATE), raw(MELAKA_CITY)], Ipoh: [raw(IPOH)], "Johor Bahru": [raw(JB_TOWN)] };

function setup(over: { files?: Record<string, string>; at?: Date; fetchFn?: typeof fetch } = {}) {
  const memory = memoryFs(over.files);
  const pacer = { wait: vi.fn(async (_host: string) => {}) };
  const fetchFn = over.fetchFn ?? nominatim(ANSWERS);
  let now = over.at ?? new Date("2026-11-19T00:00:00Z");
  const make = () => createGeocoder({ cacheFile: CACHE, fetchFn, pacer, now: () => now, fs: memory.fs });
  return { ...memory, pacer, fetchFn, make, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("createGeocoder", () => {
  it("fetches each new place once, pacing every request on Nominatim's host", async () => {
    const t = setup();
    const geocode = t.make();
    expect(await geocode("Melaka")).toEqual({ kind: "place", hit: hit(MELAKA_CITY), region: hit(MELAKA_STATE) });
    expect(await geocode("Ipoh")).toEqual({ kind: "place", hit: hit(IPOH) });
    expect(await geocode("Johor Bahru")).toEqual({ kind: "place", hit: hit(JB_TOWN) });
    expect(t.fetchFn).toHaveBeenCalledTimes(3);
    expect(t.pacer.wait.mock.calls).toEqual([[GEOCODE_HOST], [GEOCODE_HOST], [GEOCODE_HOST]]);
    expect(GEOCODE_HOST).toBe("nominatim.openstreetmap.org");
  });

  it("keeps a place asked within a country apart from the same place asked worldwide", async () => {
    const t = setup();
    const geocode = t.make();
    await geocode("Ipoh", { countryCode: "MY" });
    await geocode("Ipoh");
    await geocode("ipoh", { countryCode: "my" });
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
    expect(new URL(vi.mocked(t.fetchFn).mock.calls[0]![0].toString()).searchParams.get("countrycodes")).toBe("my");
    const written = JSON.parse(t.files.get(CACHE)!);
    expect(Object.keys(written.entries).sort()).toEqual(["ipoh", "my|ipoh"]);
  });

  it("shares one request between concurrent lookups of the same place", async () => {
    const t = setup();
    const geocode = t.make();
    const [a, b] = await Promise.all([geocode("Ipoh"), geocode("  ipoh ")]);
    expect(a).toEqual(b);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("answers from the cache file in a new geocoder, without a request", async () => {
    const t = setup();
    await t.make()("Melaka");
    expect(JSON.parse(t.files.get(CACHE)!)).toMatchObject({ version: 2, entries: { melaka: { at: "2026-11-19T00:00:00.000Z" } } });

    const again = t.make();
    expect(await again("MELAKA")).toEqual({ kind: "place", hit: hit(MELAKA_CITY), region: hit(MELAKA_STATE) });
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    expect(t.pacer.wait).toHaveBeenCalledTimes(1);
  });

  it("keeps a hit for 30 days, then asks again", async () => {
    const t = setup();
    await t.make()("Ipoh");
    t.advance(30 * DAY_MS - 1);
    await t.make()("Ipoh");
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    t.advance(2);
    await t.make()("Ipoh");
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps a not-found answer for 24 hours, then asks again", async () => {
    const t = setup();
    expect(await t.make()("Atlantis")).toBeNull();
    t.advance(DAY_MS - 1);
    expect(await t.make()("Atlantis")).toBeNull();
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    t.advance(2);
    await t.make()("Atlantis");
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 503])("never caches Nominatim answering HTTP %i as not found", async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response("busy", { status }));
    const t = setup({ fetchFn });
    const geocode = t.make();
    await expect(geocode("Ipoh")).rejects.toBeInstanceOf(GeocodeUnavailableError);
    await expect(geocode("Ipoh")).rejects.toBeInstanceOf(GeocodeUnavailableError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(t.files.has(CACHE)).toBe(false);
  });

  it("still answers a cached place while Nominatim is down", async () => {
    let down = false;
    const answers = nominatim(ANSWERS);
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input, init) =>
      down ? new Response("busy", { status: 429 }) : answers(input, init));
    const t = setup({ fetchFn });
    await t.make()("Ipoh");
    down = true;
    const geocode = t.make();
    expect(await geocode("Ipoh")).toEqual({ kind: "place", hit: hit(IPOH) });
    await expect(geocode("Melaka")).rejects.toBeInstanceOf(GeocodeUnavailableError);
  });

  it("rethrows a network failure without caching it", async () => {
    const error = new Error("network unavailable");
    const t = setup({ fetchFn: vi.fn<typeof fetch>().mockRejectedValue(error) });
    await expect(t.make()("Ipoh")).rejects.toBe(error);
    expect(t.files.has(CACHE)).toBe(false);
  });

  it.each([
    ["not JSON", "{ broken"],
    ["entries that are not an object", JSON.stringify({ version: 2, entries: [] })],
  ])("ignores a cache file that is %s and rewrites it valid", async (_label, text) => {
    const t = setup({ files: { [CACHE]: text } });
    expect(await t.make()("Ipoh")).toEqual({ kind: "place", hit: hit(IPOH) });
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    const written = JSON.parse(t.files.get(CACHE)!);
    expect(written.version).toBe(2);
    expect(written.entries.ipoh.result).toEqual({ kind: "place", hit: hit(IPOH) });
  });

  it("ignores a fresh, valid-looking entry from another cache version and rewrites the file", async () => {
    // A stale answer for Ipoh that version 1 (no state or country names) would return: same key, a fresh
    // timestamp and a well-formed hit, but stored by another chooseHit.
    const stale = { at: "2026-11-18T00:00:00Z", result: { kind: "place", hit: hit(MELAKA_CITY) } };
    const t = setup({ files: { [CACHE]: JSON.stringify({ version: 1, entries: { ipoh: stale } }) } });
    expect(await t.make()("Ipoh")).toEqual({ kind: "place", hit: hit(IPOH) });
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    const written = JSON.parse(t.files.get(CACHE)!);
    expect(written.version).toBe(2);
    expect(written.entries.ipoh.result).toEqual({ kind: "place", hit: hit(IPOH) });
  });

  it("refetches a fresh cache entry whose result has the wrong shape", async () => {
    // The timestamp is valid and one day old, so only the shape check can reject it.
    const files = { [CACHE]: JSON.stringify({ version: 2, entries: { ipoh: { at: "2026-11-18T00:00:00Z", result: { kind: "place" } } } }) };
    const t = setup({ files });
    expect(await t.make()("Ipoh")).toEqual({ kind: "place", hit: hit(IPOH) });
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("writes the file through a temporary file and a rename", async () => {
    const t = setup();
    const renames: string[][] = [];
    const rename = t.fs.renameSync;
    t.fs.renameSync = ((from: string, to: string) => {
      renames.push([from, to]);
      rename(from, to);
    }) as GeocoderFs["renameSync"];
    await t.make()("Ipoh");
    expect(renames).toHaveLength(1);
    expect(renames[0]![0]).not.toBe(CACHE);
    expect(renames[0]![1]).toBe(CACHE);
    expect([...t.files.keys()]).toEqual([CACHE]);
  });

  it("still answers when the cache file cannot be written", async () => {
    const t = setup();
    t.fs.writeFileSync = (() => {
      throw new Error("EACCES");
    }) as GeocoderFs["writeFileSync"];
    expect(await t.make()("Ipoh")).toEqual({ kind: "place", hit: hit(IPOH) });
  });

  it("keeps answers in memory when no cache file is given", async () => {
    const fetchFn = nominatim(ANSWERS);
    const geocode = createGeocoder({ fetchFn, pacer: { wait: async () => {} } });
    await geocode("Ipoh");
    await geocode("Ipoh");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
