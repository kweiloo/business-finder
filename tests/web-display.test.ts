// Display helpers of the web UI: how a website link is labelled and the
// plain-language line that explains the website counts.

import { describe, expect, it } from "vitest";
import { safeHref, websiteLabel } from "../web/src/lib/links.js";
import { websitesLine } from "../web/src/lib/summary.js";

describe("websiteLabel", () => {
  it("shows a business website as its short address", () => {
    expect(websiteLabel("https://www.shop-1.test/")).toEqual({ text: "shop-1.test", network: null });
    expect(websiteLabel("https://shop-1.test/en/contact/")).toEqual({ text: "shop-1.test/en/contact", network: null });
  });

  it("names WhatsApp and social networks instead of showing them as a website", () => {
    expect(websiteLabel("https://wa.me/60120000001").text).toBe("WhatsApp");
    expect(websiteLabel("https://api.whatsapp.com/send?phone=60120000001").text).toBe("WhatsApp");
    expect(websiteLabel("https://www.facebook.com/some.page").text).toBe("Facebook");
    expect(websiteLabel("https://m.facebook.com/some.page").text).toBe("Facebook");
    expect(websiteLabel("https://instagram.com/handle").text).toBe("Instagram");
    expect(websiteLabel("https://twitter.com/handle").text).toBe("X");
  });

  it("does not mistake a look-alike host for a network", () => {
    expect(websiteLabel("https://notfacebook.com/").network).toBeNull();
    expect(websiteLabel("https://facebook.com.evil.test/").network).toBeNull();
  });
});

describe("safeHref", () => {
  it("links only http and https addresses", () => {
    expect(safeHref("https://shop-1.test/")).toBe("https://shop-1.test/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});

describe("websitesLine", () => {
  const zero = { toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 };

  it("explains every website that was checked", () => {
    expect(websitesLine({ ...zero, toCheck: 10, fetched: 5, unreachable: 4, mismatched: 1 })).toBe(
      "Looked for emails on 10 websites: 5 read, 4 didn't answer, 1 was a different business.",
    );
  });

  it("leaves out parts that are zero and handles one website", () => {
    expect(websitesLine({ ...zero, toCheck: 1, fetched: 1 })).toBe("Looked for emails on 1 website: 1 read.");
    expect(websitesLine({ ...zero, toCheck: 3, mismatched: 2, skipped: 1 })).toBe(
      "Looked for emails on 3 websites: 2 were different businesses, 1 skipped.",
    );
  });

  it("says so when there was nothing to check", () => {
    expect(websitesLine(zero)).toBe("None of these places listed a website to look for emails on.");
  });
});
