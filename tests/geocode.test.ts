import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/version.js";
import { chooseHit, geocode, GeocodeUnavailableError, parseHits, placeLabel } from "../src/core/geo/geocode.js";
import {
  type Capture,
  BANGKOK, BANGSAR_RAIL, BANGSAR_SUBURB, CALIFORNIA, hit, JB_DISTRICT, JB_TOWN, KUALA_LUMPUR, MELAKA_CITY, MELAKA_STATE, PENANG, raw, SELANGOR,
  SG_CITY, SG_COUNTRY,
} from "./fixtures/nominatim.js";

describe("chooseHit", () => {
  it("uses the city inside a state's box: Melaka gives Bandaraya Melaka", () => {
    expect(chooseHit([hit(MELAKA_STATE), hit(MELAKA_CITY)])).toEqual({
      kind: "place", hit: hit(MELAKA_CITY), region: hit(MELAKA_STATE),
    });
  });

  it("uses the city inside a country's box: Singapore", () => {
    expect(chooseHit([hit(SG_COUNTRY), hit(SG_CITY)])).toMatchObject({ kind: "place", hit: hit(SG_CITY) });
  });

  it("searches a state no wider than 40 km itself: Kuala Lumpur", () => {
    expect(chooseHit([hit(KUALA_LUMPUR)])).toEqual({ kind: "place", hit: hit(KUALA_LUMPUR) });
  });

  it("refuses a large state with no city of that name: Penang, Selangor, California", () => {
    expect(chooseHit([hit(PENANG)])).toEqual({ kind: "region", hit: hit(PENANG) });
    expect(chooseHit([hit(SELANGOR)])).toEqual({ kind: "region", hit: hit(SELANGOR) });
    expect(chooseHit([hit(CALIFORNIA)])).toEqual({ kind: "region", hit: hit(CALIFORNIA) });
  });

  it("keeps a first hit that is a town, city or point: Johor Bahru, Bangkok, Bangsar", () => {
    expect(chooseHit([hit(JB_TOWN), hit(JB_DISTRICT)])).toEqual({ kind: "place", hit: hit(JB_TOWN) });
    expect(chooseHit([hit(BANGKOK)])).toEqual({ kind: "place", hit: hit(BANGKOK) });
    expect(chooseHit([hit(BANGSAR_RAIL), hit(BANGSAR_SUBURB)])).toEqual({ kind: "place", hit: hit(BANGSAR_RAIL) });
  });

  it("never jumps to a city in another country or outside the region's box", () => {
    const otherCountry = { ...hit(MELAKA_CITY), countryCode: "PH" };
    const outsideBox = { ...hit(MELAKA_CITY), lat: 17.9538828, lon: 120.6412068 };
    expect(chooseHit([hit(PENANG), otherCountry])).toEqual({ kind: "region", hit: hit(PENANG) });
    expect(chooseHit([hit(MELAKA_STATE), otherCountry])).toEqual({ kind: "region", hit: hit(MELAKA_STATE) });
    expect(chooseHit([hit(MELAKA_STATE), outsideBox])).toEqual({ kind: "region", hit: hit(MELAKA_STATE) });
  });

  it("never picks a city inside the box whose name is not the region's", () => {
    const unrelated = { ...hit(JB_TOWN), name: "Batu Pahat", lat: 1.85, lon: 102.93 };
    const johor = { ...hit(MELAKA_STATE), name: "Johor", bbox: { south: 1.2, north: 2.9, west: 102.4, east: 104.6 } };
    expect(chooseHit([johor, unrelated])).toEqual({ kind: "region", hit: johor });
    const melakaWithNeighbour = [hit(MELAKA_STATE), { ...hit(MELAKA_CITY), name: "Alor Gajah" }, hit(MELAKA_CITY)];
    expect(chooseHit(melakaWithNeighbour)).toEqual({ kind: "place", hit: hit(MELAKA_CITY), region: hit(MELAKA_STATE) });
  });

  it("returns null for no hits", () => {
    expect(chooseHit([])).toBeNull();
  });
});

describe("parseHits", () => {
  it("reads Nominatim's strings into numbers and an uppercase country code", () => {
    expect(parseHits([raw(MELAKA_STATE), raw(MELAKA_CITY)])).toEqual([hit(MELAKA_STATE), hit(MELAKA_CITY)]);
  });

  it("skips entries without finite coordinates or a country code", () => {
    const good = raw(JB_TOWN);
    expect(parseHits([
      { ...good, lat: "invalid" },
      { ...good, lon: "Infinity" },
      { ...good, address: { ocean: "Pacific Ocean" } },
      null,
      "text",
      good,
    ])).toEqual([hit(JB_TOWN)]);
  });

  it("uses the point as the box when the box is missing or malformed", () => {
    const { boundingbox: _, ...noBox } = raw(BANGSAR_RAIL);
    expect(parseHits([noBox, { ...raw(BANGSAR_RAIL), boundingbox: ["x"] }])).toEqual([hit(BANGSAR_RAIL), hit(BANGSAR_RAIL)]);
  });

  it("returns no hits for a body that is not an array", () => {
    expect(parseHits({})).toEqual([]);
  });
});

describe("geocode", () => {
  it("asks Nominatim for five hits and applies the rule", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([raw(MELAKA_STATE), raw(MELAKA_CITY)])));

    expect(await geocode("Melaka", fetchFn)).toMatchObject({ kind: "place", hit: { name: "Bandaraya Melaka", countryCode: "MY" } });
    const [input, init] = fetchFn.mock.calls[0]!;
    const url = new URL(input.toString());
    expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: "jsonv2", limit: "5", addressdetails: "1", q: "Melaka",
    });
    expect(new Headers(init?.headers).get("user-agent"))
      .toBe("business-finder/" + VERSION + " (+https://github.com/kweiloo/business-finder)");
  });

  it("returns null when no location matches", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]"));
    expect(await geocode("Unknown", fetchFn)).toBeNull();
  });

  it.each([429, 500, 503])("throws GeocodeUnavailableError for HTTP %i, never answering not found", async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("error", { status }));
    await expect(geocode("Melaka", fetchFn)).rejects.toBeInstanceOf(GeocodeUnavailableError);
  });

  it.each([["invalid JSON", "<html>Sign in</html>"], ["JSON that is not a list", '{"error":"Bad request"}']])(
    "throws GeocodeUnavailableError for %s",
    async (_label, body) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(geocode("Melaka", fetchFn)).rejects.toBeInstanceOf(GeocodeUnavailableError);
    },
  );

  it("propagates fetch errors", async () => {
    const error = new Error("network unavailable");
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(geocode("Melaka", fetchFn)).rejects.toBe(error);
  });
});

describe("geocode with the run's country", () => {
  const PJ_CITY: Capture = ["Petaling Jaya", "city", 3.1073, 101.6067, [3.0473, 3.1673, 101.5467, 101.6667], "MY"];
  const POJUCA: Capture = ["Pojuca", "town", -12.4303, -38.3374, [-12.4703, -12.3903, -38.3774, -38.2974], "BR"];

  it("asks within the country first and uses that answer when it has one", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([raw(PJ_CITY)])));
    expect(await geocode("PJ", fetchFn, { countryCode: "MY" })).toMatchObject({ kind: "place", hit: { name: "Petaling Jaya", countryCode: "MY" } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(new URL(fetchFn.mock.calls[0]![0].toString()).searchParams.get("countrycodes")).toBe("my");
  });

  it("searches worldwide only when the country has no hit, pacing each request", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("[]"))
      .mockResolvedValueOnce(new Response(JSON.stringify([raw(POJUCA)])));
    const pace = vi.fn(async () => {});
    expect(await geocode("PJ", fetchFn, { countryCode: "MY", pace })).toMatchObject({ kind: "place", hit: { name: "Pojuca", countryCode: "BR" } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(new URL(fetchFn.mock.calls[1]![0].toString()).searchParams.has("countrycodes")).toBe(false);
    expect(pace).toHaveBeenCalledTimes(2);
  });

  it("asks worldwide once when no country is given", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]"));
    expect(await geocode("PJ", fetchFn)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(new URL(fetchFn.mock.calls[0]![0].toString()).searchParams.has("countrycodes")).toBe(false);
  });
});

describe("place names for people", () => {
  it("reads the state, its code and the country from Nominatim's address", () => {
    const entry = { ...raw(PENANG), address: { state: "Pulau Pinang", "ISO3166-2-lvl4": "MY-07", country: "Malaysia", country_code: "my" } };
    expect(parseHits([entry])[0]).toMatchObject({ state: "Pulau Pinang", stateCode: "MY-07", country: "Malaysia" });
  });

  it("names a place with its state and country, without repeating a name", () => {
    expect(placeLabel({ ...hit(JB_TOWN), name: "Petaling Jaya", state: "Selangor", country: "Malaysia" })).toBe("Petaling Jaya, Selangor, Malaysia");
    expect(placeLabel({ ...hit(KUALA_LUMPUR), state: "Kuala Lumpur", country: "Malaysia" })).toBe("Kuala Lumpur, Malaysia");
    expect(placeLabel(hit(JB_TOWN))).toBe("Johor Bahru, Malaysia");
    expect(placeLabel(hit(BANGKOK))).toBe("Bangkok, Thailand");
  });
});
