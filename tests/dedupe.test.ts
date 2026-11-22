import { describe, expect, it } from "vitest";
import { toLead } from "../src/core/leads/normalize.js";
import type { RawPlace } from "../src/core/types.js";
import { ListIndex, nameKey, namesOnly } from "../src/jobs/dedupe.js";

const lead = (p: Partial<RawPlace> & { title: string }) => toLead({ source: "fixture", query: "q", city: "c", ...p }, "MY");

describe("ListIndex: one rule for scrape --into and add --into", () => {
  const list = [
    lead({ title: "Klinik Gigi Alpha", phone: "03-2000 0001", website: "https://www.alpha.test/", place_id: "P1" }),
    lead({ title: "Beta Dental", phone: "03-2000 0002", place_id: "P2" }),
  ];

  it("keeps a row whose phone matches but whose name and website differ", () => {
    const index = new ListIndex(list, "MY");
    expect(index.match({ name: "Gamma Dental", phone: "+60 3-2000 0002" })).toBeNull();
    expect(index.match({ name: "Gamma Dental", phone: "+60 3-2000 0002", placeId: "P9" })).toBeNull();
  });

  it("skips a row with the same phone and the same name, ignoring case, accents and punctuation", () => {
    const index = new ListIndex(list, "MY");
    expect(index.match({ name: "BETA  DENTAL.", phone: "+60 3-2000 0002" })).toBe("same phone and name");
    expect(nameKey("Clínica  Dentária, Lda.")).toBe(nameKey("clinica dentaria lda"));
  });

  it("skips a row with the same website host", () => {
    const index = new ListIndex(list, "MY");
    expect(index.match({ name: "Other", website: "http://alpha.test/contact" })).toBe("same website");
  });

  it("skips the same Maps place and keeps two Maps places that share a website", () => {
    const index = new ListIndex(list, "MY");
    expect(index.match({ name: "Renamed", placeId: "P2" })).toBe("same place");
    // Two branches of one group: different places, one website.
    expect(index.match({ name: "Klinik Gigi Alpha (Branch 2)", website: "https://alpha.test/", placeId: "P3" })).toBeNull();
  });

  it("remembers rows added to it, so repeats within one batch are skipped", () => {
    const index = new ListIndex([], "MY");
    expect(index.match({ name: "A", phone: "012-000 0001" })).toBeNull();
    index.add({ name: "A", phone: "012-000 0001" });
    expect(index.match({ name: "a", phone: "+60120000001" })).toBe("same phone and name");
    expect(index.match({ name: "B", phone: "+60120000001" })).toBeNull();
  });
});

describe("namesOnly", () => {
  it("is true when every place lacks a website, a phone and an address", () => {
    expect(namesOnly([lead({ title: "A" }), lead({ title: "B" })])).toBe(true);
  });

  it("is false when one place has any of them, and for no places at all", () => {
    expect(namesOnly([lead({ title: "A" }), lead({ title: "B", address: "1 Jalan X" })])).toBe(false);
    expect(namesOnly([lead({ title: "A" }), lead({ title: "B", phone: "012-000 0001" })])).toBe(false);
    expect(namesOnly([lead({ title: "A" }), lead({ title: "B", website: "https://b.test/" })])).toBe(false);
    expect(namesOnly([])).toBe(false);
  });
});
