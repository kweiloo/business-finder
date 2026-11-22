import { describe, expect, it } from "vitest";
import { toE164, whatsappLink } from "../src/core/leads/phone.js";

describe("toE164", () => {
  it("normalises a Malaysian mobile number written in national format", () => {
    expect(toE164("012-345 6789", "MY")).toBe("+60123456789");
  });

  it("accepts a number already in international format regardless of country", () => {
    expect(toE164("+60 12-345 6789", "SG")).toBe("+60123456789");
  });

  it("returns null for text that is not a phone number", () => {
    expect(toE164("not a phone", "MY")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(toE164("", "MY")).toBeNull();
  });

  it("returns null when no country is known and the number is national", () => {
    expect(toE164("012-345 6789", "")).toBeNull();
  });
});

describe("whatsappLink", () => {
  it("builds a wa.me link from a mobile number", () => {
    expect(whatsappLink("012-345 6789", "MY")).toBe("https://wa.me/60123456789");
  });

  it("gives no link for a landline (Melaka fixed line)", () => {
    // The number must parse as valid, so the empty link comes from its type.
    expect(toE164("06-282 1234", "MY")).toBe("+6062821234");
    expect(whatsappLink("06-282 1234", "MY")).toBe("");
  });

  it("gives no link for an empty phone", () => {
    expect(whatsappLink("", "MY")).toBe("");
  });

  it("gives no link for text that is not a phone number", () => {
    expect(whatsappLink("not a phone", "MY")).toBe("");
  });

  it("builds a link for a Singapore mobile number", () => {
    expect(whatsappLink("9123 4567", "SG")).toBe("https://wa.me/6591234567");
  });
});
