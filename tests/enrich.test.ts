import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { enrichLeads, fixtureFetcher, type MxResolver } from "../src/core/enrich/enrich.js";
import { SHARED_HOST_PACER, safeFetch, type SiteFetcher } from "../src/core/enrich/safeFetch.js";
import { toLead } from "../src/core/leads/normalize.js";
import type { Lead } from "../src/core/types.js";

const SITES = fileURLToPath(new URL("./fixtures/sites/", import.meta.url));
const ALL = { emails: true, socials: true, deep: false };

const lead = (title: string, over: { website?: string; phone?: string; category?: string } = {}): Lead =>
  toLead({ title, source: "fixture", query: "florist", city: "Melaka", ...over }, "MY");

const shopA = () => lead("Shop A", { website: "https://shop-a.test/", phone: "06-281 2345", category: "Florist" });
const shopB = () => lead("Shop B", { website: "https://shop-b.test/", phone: "06-999 0000", category: "Florist" });
const shopC = () => lead("Shop C", { website: "https://shop-c.test/", phone: "06-111 2222", category: "Florist" });
const shopD = () => lead("Shop D", { website: "https://shop-d.test", phone: "06-555 0101", category: "Bakery" });

describe("fixtureFetcher", () => {
  const fetchSite = fixtureFetcher(SITES);
  const o = { timeoutMs: 1000, maxBytes: 1024 * 1024 };

  it("maps a homepage and a subpage to fixture files", async () => {
    expect(await fetchSite("https://shop-a.test/", o)).toMatchObject({ ok: true, finalUrl: "https://shop-a.test/" });
    expect(await fetchSite("https://shop-d.test/hubungi-kami", o)).toMatchObject({ ok: true });
  });

  it("reports a missing file, a bad URL or a path escape as an HTTP error", async () => {
    expect(await fetchSite("https://shop-c.test/", o)).toEqual({ ok: false, reason: "http_error" });
    expect(await fetchSite("not a url", o)).toEqual({ ok: false, reason: "invalid_url" });
    expect(await fetchSite("https://shop-d.test/../../package.json", o)).toEqual({ ok: false, reason: "http_error" });
  });
});

describe("enrichLeads", () => {
  it("reconciles ok, mismatched, unreachable and no-website leads", async () => {
    const leads = [shopA(), shopB(), shopC(), lead("No site")];
    const progress = vi.fn();
    const result = await enrichLeads(leads, { ...ALL, fetchSite: fixtureFetcher(SITES) }, progress);

    expect(result.counts).toEqual({ toCheck: 3, fetched: 1, unreachable: 1, mismatched: 1, skipped: 0 });
    const [a, b, c, none] = result.leads;
    expect(a).toMatchObject({
      website_status: "found",
      email_status: "found",
      emails: ["hello@shop-a.test"],
      email_source_url: "https://shop-a.test/",
      instagram: "https://www.instagram.com/shopa_test",
    });
    expect(b).toMatchObject({ website_status: "website_mismatch", email_status: "website_mismatch", emails: [] });
    expect(c).toMatchObject({ website_status: "site_unreachable", email_status: "site_unreachable", emails: [] });
    expect(none).toMatchObject({ website_status: "no_website", email_status: "no_website" });
    expect(progress).toHaveBeenLastCalledWith({ checked: 3, toCheck: 3 });
  });

  it("does not modify the input leads", async () => {
    const input = [shopA()];
    await enrichLeads(input, { ...ALL, fetchSite: fixtureFetcher(SITES) }, () => {});
    expect(input[0]).toMatchObject({ website_status: "skipped_by_option", emails: [] });
  });

  it("follows contact links in deep mode when the homepage has nothing", async () => {
    const shallow = await enrichLeads([shopD()], { ...ALL, fetchSite: fixtureFetcher(SITES) }, () => {});
    expect(shallow.leads[0]).toMatchObject({ website_status: "found", email_status: "not_on_site", emails: [] });

    const deep = await enrichLeads([shopD()], { ...ALL, deep: true, fetchSite: fixtureFetcher(SITES) }, () => {});
    expect(deep.leads[0]).toMatchObject({
      website_status: "found",
      email_status: "found",
      emails: ["orders@shop-d.test"],
      email_source_url: "https://shop-d.test/hubungi-kami",
      facebook: "https://www.facebook.com/shopd.bakery.test",
    });
  });

  it("skips every site when neither emails nor socials are wanted", async () => {
    const fetchSite = vi.fn<SiteFetcher>();
    const result = await enrichLeads([shopA(), lead("No site")], { emails: false, socials: false, deep: false, fetchSite }, () => {});
    expect(fetchSite).not.toHaveBeenCalled();
    expect(result.counts).toEqual({ toCheck: 1, fetched: 0, unreachable: 0, mismatched: 0, skipped: 1 });
    expect(result.leads[0]).toMatchObject({ website_status: "skipped_by_option", email_status: "skipped_by_option" });
    expect(result.leads[1]).toMatchObject({ website_status: "no_website", email_status: "skipped_by_option" });
  });

  it("leaves emails unset when only socials are wanted", async () => {
    const result = await enrichLeads([shopA()], { emails: false, socials: true, deep: false, fetchSite: fixtureFetcher(SITES) }, () => {});
    expect(result.leads[0]).toMatchObject({
      website_status: "found", email_status: "skipped_by_option", emails: [], instagram: "https://www.instagram.com/shopa_test",
    });
  });

  it("marks a lead unreachable when the fetcher throws or the website is not a URL", async () => {
    const fetchSite = vi.fn<SiteFetcher>(async () => { throw new Error("boom"); });
    const result = await enrichLeads(
      [shopA(), lead("Bad", { website: "javascript:alert(1)" }), lead("Blank", { website: "   " })],
      { ...ALL, fetchSite },
      () => {},
    );
    expect(result.leads.map((l) => l.website_status)).toEqual(["site_unreachable", "site_unreachable", "no_website"]);
    expect(result.counts).toEqual({ toCheck: 2, fetched: 0, unreachable: 2, mismatched: 0, skipped: 0 });
  });

  it("adds https to a website written without a scheme", async () => {
    const fetchSite = vi.fn<SiteFetcher>(async () => ({ ok: false, reason: "http_error" }));
    await enrichLeads([lead("Bare", { website: "shop-a.test" })], { ...ALL, fetchSite }, () => {});
    expect(fetchSite.mock.calls[0]![0]).toBe("https://shop-a.test/");
  });

  it("trims an email domain that ran on past the fetched site's host", async () => {
    const html = '<meta name="description" content="For inquiry:e: hello@shop-a.testp: +60 6-281 2345"><p>Florist</p>';
    const fetchSite = vi.fn<SiteFetcher>(async () => ({ ok: true, finalUrl: "https://www.shop-a.test/", html }));
    const result = await enrichLeads([shopA()], { ...ALL, fetchSite }, () => {});
    expect(result.leads[0]!.emails).toEqual(["hello@shop-a.test"]);
  });

  it("keeps working when a progress callback throws", async () => {
    const result = await enrichLeads([shopA()], { ...ALL, fetchSite: fixtureFetcher(SITES) }, () => { throw new Error("ui"); });
    expect(result.counts.fetched).toBe(1);
  });

  it("gives every enrichment in the process the same host pacer", async () => {
    const pacers: unknown[] = [];
    const fetchSite: SiteFetcher = async (_url, o) => {
      pacers.push(o.pacer);
      return { ok: false, reason: "timeout" };
    };
    await Promise.all([
      enrichLeads([shopA()], { ...ALL, fetchSite }, () => {}),
      enrichLeads([shopB()], { ...ALL, fetchSite }, () => {}),
    ]);
    expect(pacers).toHaveLength(2);
    expect(pacers.every((p) => p === SHARED_HOST_PACER)).toBe(true);
  });

  it("passes a caller's pacer to every fetch", async () => {
    const pacer = { wait: async () => {} };
    const fetchSite = vi.fn<SiteFetcher>(async () => ({ ok: false, reason: "timeout" }));
    await enrichLeads([shopA(), shopB()], { ...ALL, fetchSite, pacer }, () => {});
    expect(fetchSite.mock.calls.map(([, o]) => o.pacer)).toEqual([pacer, pacer]);
  });

  it("checks at most eight sites at once", async () => {
    let active = 0;
    let peak = 0;
    const fetchSite: SiteFetcher = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { ok: false, reason: "timeout" };
    };
    const leads = Array.from({ length: 20 }, (_, i) => lead(`L${i}`, { website: `https://s${i}.test/` }));
    const result = await enrichLeads(leads, { ...ALL, fetchSite }, () => {});
    expect(peak).toBe(8);
    expect(result.counts.unreachable).toBe(20);
  });
});

describe("enrichLeads provenance", () => {
  /** A clock that moves one second per call from 2026-11-19T00:00:00Z. */
  const fakeClock = () => {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 10, 19, 0, 0, tick++));
  };

  // The homepage shows an email and an Instagram link but not the listing's
  // phone, so deep mode reads the contact page, which has the phone and a
  // second email.
  const pages: Record<string, string> = {
    "https://shop-e.test/":
      '<p>Write to <a href="mailto:hello@shop-e.test">hello@shop-e.test</a></p>' +
      '<a href="https://www.instagram.com/shope_test">Instagram</a><a href="/contact">Contact</a>',
    "https://shop-e.test/contact": "<p>Call 06-777 8888 or email orders@shop-e.test</p>",
  };
  const fetchSite: SiteFetcher = async (url) =>
    url in pages ? { ok: true, finalUrl: url, html: pages[url]! } : { ok: false, reason: "http_error" };
  const shopE = () => lead("Shop E", { website: "https://shop-e.test/", phone: "06-777 8888", category: "Florist" });

  it("records the page and fetch time of every email and social link", async () => {
    const result = await enrichLeads([shopE()], { ...ALL, deep: true, fetchSite, now: fakeClock() }, () => {});
    const [e] = result.leads;
    expect(e).toMatchObject({ emails: ["hello@shop-e.test", "orders@shop-e.test"], email_source_url: "https://shop-e.test/" });
    expect(e!.sources).toEqual([
      { field: "email", value: "hello@shop-e.test", url: "https://shop-e.test/", fetched_at: "2026-11-19T00:00:00.000Z" },
      { field: "email", value: "orders@shop-e.test", url: "https://shop-e.test/contact", fetched_at: "2026-11-19T00:00:01.000Z" },
      { field: "instagram", value: "https://www.instagram.com/shope_test", url: "https://shop-e.test/", fetched_at: "2026-11-19T00:00:00.000Z" },
    ]);
  });

  it("gives a social link found on the homepage the homepage URL", async () => {
    const result = await enrichLeads([shopA()], { ...ALL, fetchSite: fixtureFetcher(SITES), now: fakeClock() }, () => {});
    const instagram = result.leads[0]!.sources!.filter((s) => s.field === "instagram");
    expect(instagram).toEqual([
      { field: "instagram", value: "https://www.instagram.com/shopa_test", url: "https://shop-a.test/", fetched_at: "2026-11-19T00:00:00.000Z" },
    ]);
  });

  it("gives every lead with nothing found an empty source list", async () => {
    const result = await enrichLeads(
      [shopB(), shopC(), lead("No site"), shopD()],
      { ...ALL, fetchSite: fixtureFetcher(SITES), now: fakeClock() },
      () => {},
    );
    expect(result.leads.map((l) => l.sources)).toEqual([[], [], [], []]);
    const skipped = await enrichLeads([shopA()], { emails: false, socials: false, deep: false, fetchSite }, () => {});
    expect(skipped.leads[0]!.sources).toEqual([]);
  });

  it("keeps the first page a value was seen on when a later page repeats or changes it", async () => {
    const twoPages: Record<string, string> = {
      "https://shop-f.test/":
        '<p>Mail <a href="mailto:hello@shop-f.test">hello@shop-f.test</a></p>' +
        '<a href="https://www.instagram.com/shopf_home">Instagram</a><a href="/contact">Contact</a>',
      "https://shop-f.test/contact":
        "<p>Call 06-777 9999. Email hello@shop-f.test or sales@shop-f.test</p>" +
        '<a href="https://www.instagram.com/shopf_contact">Instagram</a>' +
        '<a href="https://www.facebook.com/shopftest">Facebook</a>',
    };
    const fetchTwo: SiteFetcher = async (url) =>
      url in twoPages ? { ok: true, finalUrl: url, html: twoPages[url]! } : { ok: false, reason: "http_error" };
    const shopF = lead("Shop F", { website: "https://shop-f.test/", phone: "06-777 9999", category: "Florist" });
    const result = await enrichLeads([shopF], { ...ALL, deep: true, fetchSite: fetchTwo, now: fakeClock() }, () => {});
    const home = { url: "https://shop-f.test/", fetched_at: "2026-11-19T00:00:00.000Z" };
    const contact = { url: "https://shop-f.test/contact", fetched_at: "2026-11-19T00:00:01.000Z" };
    expect(result.leads[0]).toMatchObject({
      emails: ["hello@shop-f.test", "sales@shop-f.test"],
      instagram: "https://www.instagram.com/shopf_home",
      facebook: "https://www.facebook.com/shopftest",
    });
    expect(result.leads[0]!.sources).toEqual([
      { field: "email", value: "hello@shop-f.test", ...home },
      { field: "email", value: "sales@shop-f.test", ...contact },
      { field: "instagram", value: "https://www.instagram.com/shopf_home", ...home },
      { field: "facebook", value: "https://www.facebook.com/shopftest", ...contact },
    ]);
  });

  it("records only the fields that were asked for", async () => {
    const result = await enrichLeads([shopE()], { emails: false, socials: true, deep: true, fetchSite, now: fakeClock() }, () => {});
    expect(result.leads[0]!.sources!.map((s) => s.field)).toEqual(["instagram"]);
  });
});

describe("enrichLeads when cancelled", () => {
  it("starts no new site after the signal aborts", async () => {
    const controller = new AbortController();
    const fetched: string[] = [];
    const fetchSite: SiteFetcher = async (url) => {
      fetched.push(url);
      controller.abort();
      return { ok: false, reason: "timeout" };
    };
    const leads = Array.from({ length: 10 }, (_, i) =>
      lead(`Shop ${i}`, { website: `https://shop-${i}.test/`, phone: "06-281 2345", category: "Florist" }),
    );
    await enrichLeads(leads, { ...ALL, fetchSite, signal: controller.signal });
    expect(fetched).toEqual(["https://shop-0.test/"]);
  });

  it("reads no contact page once the signal aborts", async () => {
    const controller = new AbortController();
    const fetched: string[] = [];
    const fixture = fixtureFetcher(SITES);
    const fetchSite: SiteFetcher = async (url, o) => {
      fetched.push(url);
      controller.abort();
      return fixture(url, o);
    };
    await enrichLeads([shopD()], { ...ALL, deep: true, fetchSite, signal: controller.signal });
    expect(fetched).toEqual(["https://shop-d.test/"]);
  });
});

describe("safeFetch when cancelled", () => {
  it("returns at once without pacing, resolving or connecting", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const result = await safeFetch("https://shop-a.test/", {
      timeoutMs: 1000,
      maxBytes: 1024,
      signal: controller.signal,
      pacer: { wait: async () => void calls.push("pace") },
      lookup: async () => (calls.push("lookup"), ["93.184.216.34"]),
      transport: async () => {
        calls.push("connect");
        throw new Error("unreachable");
      },
    });
    // robots.txt fails first, and an unreachable robots.txt refuses the site.
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("enrichLeads phone from tel: links", () => {
  const web = (website: string, phone?: string) =>
    toLead({ title: "Web Shop", source: "web", query: "events", city: "", website, ...(phone ? { phone } : {}) }, "MY");
  /** Serves each URL's HTML from `table`; anything else is unreachable. */
  const pages = (table: Record<string, string>): SiteFetcher => async (url) =>
    table[url] === undefined ? { ok: false, reason: "http_error" } : { ok: true, finalUrl: url, html: table[url]! };
  const at = () => new Date("2026-11-19T08:00:00.000Z");

  it("fills a missing phone from the first valid tel: link, in E.164, with WhatsApp for a mobile", async () => {
    const fetchSite = pages({ "https://events.test/": '<a href="tel:12">bad</a><a href="tel:012-345 6789">Call</a><a href="tel:06-281 2345">Office</a>' });
    const result = await enrichLeads([web("https://events.test/")], { ...ALL, country: "MY", fetchSite, now: at });
    expect(result.leads[0]).toMatchObject({ phone: "+60123456789", whatsapp: "https://wa.me/60123456789" });
    expect(result.leads[0]!.sources).toContainEqual({
      field: "phone",
      value: "+60123456789",
      url: "https://events.test/",
      fetched_at: "2026-11-19T08:00:00.000Z",
    });
  });

  it("gives a fixed line no WhatsApp link", async () => {
    const fetchSite = pages({ "https://events.test/": '<a href="tel:06-281 2345">Office</a>' });
    const result = await enrichLeads([web("https://events.test/")], { ...ALL, country: "MY", fetchSite });
    expect(result.leads[0]).toMatchObject({ phone: "+6062812345", whatsapp: "" });
  });

  it("reads a contact page's tel: link in deep mode", async () => {
    const fetchSite = pages({
      "https://events.test/": '<a href="/contact">Contact</a>',
      "https://events.test/contact": '<a href="tel:+60123456789">Call</a><a href="mailto:hi@events.test">Mail</a>',
    });
    const result = await enrichLeads([web("https://events.test/")], { ...ALL, deep: true, fetchSite });
    expect(result.leads[0]).toMatchObject({ phone: "+60123456789" });
  });

  it("keeps a phone the lead already has", async () => {
    const fetchSite = pages({ "https://events.test/": '<a href="tel:012-345 6789">Call</a> Office 06-281 2345' });
    const result = await enrichLeads([web("https://events.test/", "06-281 2345")], { ...ALL, country: "MY", fetchSite });
    expect(result.leads[0]!.phone).toBe("06-281 2345");
    expect(result.leads[0]!.sources!.some((s) => s.field === "phone")).toBe(false);
  });

  it("never guesses from numbers in the page text, nor reads a national number without a country", async () => {
    const fetchSite = pages({ "https://events.test/": "<p>Call 012-345 6789</p>", "https://national.test/": '<a href="tel:012-345 6789">Call</a>' });
    const result = await enrichLeads([web("https://events.test/"), web("https://national.test/")], { ...ALL, fetchSite });
    expect(result.leads.map((l) => l.phone ?? "")).toEqual(["", ""]);
  });

  it("takes no phone from a site that is not the listing's", async () => {
    // The listing's phone is missing, so its category is the identity check.
    const lead = toLead({ title: "Shop", source: "web", query: "q", city: "", website: "https://other.test/", category: "Florist" }, "MY");
    const fetchSite = pages({ "https://other.test/": '<p>Car repair</p><a href="tel:+60123456789">Call</a>' });
    const result = await enrichLeads([lead], { ...ALL, fetchSite });
    expect(result.leads[0]).toMatchObject({ website_status: "website_mismatch" });
    expect(result.leads[0]!.phone).toBeUndefined();
  });
});

describe("enrichLeads cancelled while a site is being read", () => {
  /** A fetcher whose request hangs until the run's signal aborts, then fails as safeFetch does. */
  const hangsUntilAbort: SiteFetcher = (_url, o) =>
    new Promise((resolve) => o.signal!.addEventListener("abort", () => resolve({ ok: false, reason: "timeout" }), { once: true }));

  it("does not count or mark the cut-off site as unreachable", async () => {
    const controller = new AbortController();
    const started = vi.fn();
    const fetchSite: SiteFetcher = (url, o) => (started(url), hangsUntilAbort(url, o));
    const progress = vi.fn();
    const run = enrichLeads([shopA()], { ...ALL, fetchSite, signal: controller.signal }, progress);
    while (started.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    controller.abort();
    const result = await run;
    expect(result.counts).toEqual({ toCheck: 1, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 });
    expect(result.leads[0]!.website_status).not.toBe("site_unreachable");
    expect(progress).not.toHaveBeenCalled();
  });

  it("still counts a real timeout as unreachable", async () => {
    const fetchSite: SiteFetcher = async () => ({ ok: false, reason: "timeout" });
    const result = await enrichLeads([shopA()], { ...ALL, fetchSite, signal: new AbortController().signal });
    expect(result.counts).toEqual({ toCheck: 1, fetched: 0, unreachable: 1, mismatched: 0, skipped: 0 });
    expect(result.leads[0]!.website_status).toBe("site_unreachable");
  });
});

describe("enrichLeads email types and MX checks", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it("classifies emails, caches MX lookups once per domain per run, and never deletes emails with no mail server", async () => {
    const pages: Record<string, string> = {
      "https://one.test/": '<p>Florist. Contact Info+promo@one.test or alice.tan@one.test</p>',
      "https://two.test/": '<p>Florist. Email sales@one.test or bob.lee@dead.test</p>',
      "https://three.test/": '<p>Florist. Email hello@slow.test</p>',
    };
    const fetchSite: SiteFetcher = async (url) =>
      url in pages ? { ok: true, finalUrl: url, html: pages[url]! } : { ok: false, reason: "http_error" };

    const mxCalls: string[] = [];
    const mxResolver: MxResolver = {
      resolveMx: async (domain) => {
        mxCalls.push(domain);
        if (domain === "one.test") return [{ exchange: "mx.one.test", priority: 10 }];
        if (domain === "dead.test") return [];
        if (domain === "slow.test") return new Promise(() => {});
        return [];
      },
      resolve4: async () => {
        throw err("ENOTFOUND");
      },
    };

    const leads = [
      lead("One", { website: "https://one.test/", category: "Florist" }),
      lead("Two", { website: "https://two.test/", category: "Florist" }),
      lead("Three", { website: "https://three.test/", category: "Florist" }),
    ];

    const result = await enrichLeads(leads, { ...ALL, fetchSite, mxResolver, mxTimeoutMs: 25 });
    expect(result.leads[0]).toMatchObject({
      emails: ["info+promo@one.test", "alice.tan@one.test"],
      email_types: ["generic", "personal"],
      email_mx: ["ok", "ok"],
    });
    // Emails on dead.test and slow.test are kept, never deleted.
    expect(result.leads[1]).toMatchObject({
      emails: ["sales@one.test", "bob.lee@dead.test"],
      email_types: ["generic", "personal"],
      email_mx: ["ok", "no mail server"],
    });
    expect(result.leads[2]).toMatchObject({
      emails: ["hello@slow.test"],
      email_types: ["generic"],
      email_mx: ["unknown"],
    });
    // one.test was checked once across both leads and all three emails on that domain.
    expect(mxCalls.filter((d) => d === "one.test")).toHaveLength(1);
    expect(new Set(mxCalls)).toEqual(new Set(["one.test", "dead.test", "slow.test"]));
  });
});
