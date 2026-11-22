import { describe, expect, it } from "vitest";
import { fixtureSource } from "../src/core/sources/fixture.js";
import { makeBatch } from "./fixtures/batch.js";

const QUERY = { keyword: "test shop", lat: 2.1, lon: 102.2, lang: "en", country: "MY", depth: 10, maxSeconds: 30 };

describe("fixtureSource", () => {
  it("returns the batch's places tagged with source, query and city", async () => {
    const source = fixtureSource([
      makeBatch([
        { title: "Test Shop A", phone: "012-000 0001", data_id: "0x1:0xa" },
        { title: "Test Shop B", data_id: "0x1:0xb" },
      ]),
    ]);
    const progress: { places: number; batches: number }[] = [];
    const result = await source.search(QUERY, (p) => progress.push(p));
    expect(result.reason).toBe("end-of-list");
    expect(result.places).toHaveLength(2);
    expect(result.places[0]).toMatchObject({ title: "Test Shop A", phone: "012-000 0001", cid: "10", source: "fixture", query: "test shop" });
    expect(result.places.every((p) => p.source === "fixture")).toBe(true);
    expect(progress).toEqual([{ places: 2, batches: 1, found: result.places }]);
  });

  it("honours depth in batches", async () => {
    const source = fixtureSource([makeBatch([{ title: "Test Shop A" }]), makeBatch([{ title: "Test Shop B" }])]);
    const result = await source.search({ ...QUERY, depth: 1 }, () => {});
    expect(result.reason).toBe("depth");
    expect(result.places.map((p) => p.title)).toEqual(["Test Shop A"]);
  });
});
