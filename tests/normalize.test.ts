import { describe, expect, it } from "vitest";
import { dedupeKey, toLead } from "../src/core/leads/normalize.js";
import type { RawPlace } from "../src/core/types.js";

function place(overrides: Partial<RawPlace> = {}): RawPlace {
  return {
    title: "Kedai Contoh Sdn Bhd",
    source: "fixture",
    query: "bakery",
    city: "Melaka",
    ...overrides,
  };
}

describe("dedupeKey", () => {
  it("prefers place_id over data_id", () => {
    const p = place({ place_id: "PLACE_A", data_id: "0x1:0x2" });
    expect(dedupeKey(p)).toBe("place_id:PLACE_A");
  });

  it("falls back to data_id when place_id is missing", () => {
    expect(dedupeKey(place({ data_id: "0x1:0x2" }))).toBe("data_id:0x1:0x2");
  });

  it("gives two places with the same phone and no ids the same key", () => {
    const a = place({ title: "Shop A", phone: "012-345 6789" });
    const b = place({ title: "Shop B", phone: "012 3456789" });
    expect(dedupeKey(a, "MY")).toBe("phone:+60123456789");
    expect(dedupeKey(a, "MY")).toBe(dedupeKey(b, "MY"));
  });

  it("matches a national and an international spelling of the same phone", () => {
    const a = place({ phone: "012-345 6789" });
    const b = place({ phone: "+60 12-345 6789" });
    expect(dedupeKey(a, "MY")).toBe(dedupeKey(b, "MY"));
  });

  it("falls back to lowercased title|address when there is no id or usable phone", () => {
    const p = place({ title: "Kedai ABC", address: "Jalan Hang Tuah, Melaka", phone: "n/a" });
    expect(dedupeKey(p, "MY")).toBe("kedai abc|jalan hang tuah, melaka");
  });

  it("keeps different places with no ids or phones apart", () => {
    const a = place({ title: "Kedai A", address: "Jalan 1" });
    const b = place({ title: "Kedai B", address: "Jalan 1" });
    expect(dedupeKey(a)).not.toBe(dedupeKey(b));
  });
});

describe("toLead", () => {
  it("keeps raw fields and adds the WhatsApp link for a mobile number", () => {
    const p = place({ phone: "012-345 6789", website: "https://example.test" });
    const lead = toLead(p, "MY");
    expect(lead.title).toBe(p.title);
    expect(lead.phone).toBe("012-345 6789");
    expect(lead.website).toBe("https://example.test");
    expect(lead.whatsapp).toBe("https://wa.me/60123456789");
  });

  it("leaves whatsapp empty for a landline", () => {
    expect(toLead(place({ phone: "06-282 1234" }), "MY").whatsapp).toBe("");
  });

  it("starts with empty enrichment fields and skipped_by_option statuses", () => {
    const lead = toLead(place(), "MY");
    expect(lead.emails).toEqual([]);
    expect(lead.email_source_url).toBe("");
    expect(lead.email_status).toBe("skipped_by_option");
    expect(lead.website_status).toBe("skipped_by_option");
    for (const k of ["instagram", "facebook", "linkedin", "tiktok", "youtube", "x"] as const) {
      expect(lead[k]).toBe("");
    }
    expect(lead.whatsapp).toBe("");
  });

  it("stamps fetched_at as an ISO 8601 timestamp", () => {
    const lead = toLead(place(), "MY");
    expect(new Date(lead.fetched_at).toISOString()).toBe(lead.fetched_at);
  });
});
