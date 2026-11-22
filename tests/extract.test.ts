import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contactLinks, extractEmails, extractSocials, extractTelLinks, matchesListing } from "../src/core/enrich/extract.js";
import { toLead } from "../src/core/leads/normalize.js";

const site = (name: string) => readFileSync(new URL(`./fixtures/sites/${name}`, import.meta.url), "utf8");

const lead = (over: { phone?: string; category?: string } = {}) =>
  toLead({ title: "Shop", source: "fixture", query: "florist", city: "Melaka", ...over }, "MY");

describe("extractEmails", () => {
  it("finds mailto and obfuscated addresses, lower-cased and deduped", () => {
    expect(extractEmails(site("obfuscated.html"))).toEqual([
      "sales@shop-a.test",
      "support@shop-a.test",
      "billing@shop-a.test",
      "orders@shop-a.test",
    ]);
  });

  it("drops placeholder domains, tracker domains and image file names", () => {
    const emails = extractEmails(site("obfuscated.html"));
    for (const dropped of ["user@example.com", "logo@2x.png", "you@yourdomain.com", "name@email.com", "contact@schema.org"]) {
      expect(emails).not.toContain(dropped);
    }
    expect(emails.some((e) => e.includes("sentry"))).toBe(false);
  });

  it("drops contact-form placeholder addresses on company.com", () => {
    const html = '<input type="email" placeholder="name@company.com"><input placeholder="you@company.com">';
    expect(extractEmails(html)).toEqual([]);
  });

  it("drops other whole placeholder domains such as yourcompany and company.com.my", () => {
    const html = "<p>you@yourcompany.com your@mycompany.com.my yourname@company.com.my sales@companyname.com</p>";
    expect(extractEmails(html)).toEqual([]);
  });

  it("keeps a real business whose domain contains the word company", () => {
    const html = "<p>sales@acmecompany.com.my hello@company.acme.my</p>";
    expect(extractEmails(html)).toEqual(["sales@acmecompany.com.my", "hello@company.acme.my"]);
  });

  it("trims a domain that ran on past the site's own host", () => {
    const html = '<meta name="description" content="Event planners. For inquiry:e: hello@prestigioo.com.myp: +60 12-345 6789">';
    expect(extractEmails(html, "https://www.prestigioo.com.my/")).toEqual(["hello@prestigioo.com.my"]);
  });

  it("does not trim a longer domain that only starts with the site's host at a dot", () => {
    expect(extractEmails("<p>sales@shop.test.my</p>", "https://shop.test/")).toEqual(["sales@shop.test.my"]);
  });

  it.each([
    ["a mailto link", '<a href="mailto:hello@brand.com">mail</a>', "https://brand.co/", "hello@brand.com"],
    ["page text", "<p>hello@brand.com</p>", "https://brand.co/", "hello@brand.com"],
    ["a mailto link to a longer TLD", '<a href="mailto:hi@brand.community">mail</a>', "https://brand.com/", "hi@brand.community"],
    ["page text with a longer TLD", "<p>hi@brand.community</p>", "https://brand.com/", "hi@brand.community"],
  ])("does not trim a real domain that extends the site's host, in %s", (_where, html, pageUrl, email) => {
    expect(extractEmails(html, pageUrl)).toEqual([email]);
  });

  it("never trims an address taken from a mailto link", () => {
    expect(extractEmails('<a href="mailto:hello@brand.cop">mail</a>', "https://brand.co/")).toEqual(["hello@brand.cop"]);
  });

  it("drops a text address whose domain runs on past com, net, org, edu or gov", () => {
    expect(extractEmails("<p>Email: hi@shop.com.sgt: +65 6123 4567</p>")).toEqual([]);
  });

  it("keeps a two-letter country domain under com", () => {
    expect(extractEmails("<p>hi@shop.com.my and hi@shop.co.uk</p>")).toEqual(["hi@shop.com.my", "hi@shop.co.uk"]);
  });

  it("does not turn a plain sentence with 'at' into an address", () => {
    expect(extractEmails("<p>Visit us at shop-a.test today</p>")).toEqual([]);
  });

  it("joins bracket forms across any run of whitespace", () => {
    const gap = " \n\t".repeat(100);
    expect(extractEmails(`<p>sales${gap}[at]${gap}shop-a${gap}(dot)${gap}test</p>`)).toEqual(["sales@shop-a.test"]);
  });

  it("reads a page with a long run of whitespace in linear time", () => {
    // A template can emit hundreds of KB of blank lines. A leading `\s*` that
    // may start anywhere in the run makes the scan quadratic: 80k characters
    // took 13 s and froze the event loop, so no page timeout could fire.
    const html = `<p>a${" \n".repeat(100_000)}b</p><p>sales [at] shop-a.test</p>`;
    const started = performance.now();
    expect(extractEmails(html)).toEqual(["sales@shop-a.test"]);
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 120_000);

  it("decodes entity-encoded and URL-encoded addresses", () => {
    expect(extractEmails('<a href="mailto:info%40shop-e.test">x</a> team&#64;shop-e.test')).toEqual([
      "info@shop-e.test", "team@shop-e.test",
    ]);
  });

  it("returns nothing for binary or empty input", () => {
    expect(extractEmails("")).toEqual([]);
    expect(extractEmails("\u0000�\u0001PNG\u001a")).toEqual([]);
  });
});

describe("extractSocials", () => {
  it("keeps the first profile link per network and drops share links", () => {
    expect(extractSocials(site("socials.html"), "https://shop-a.test/")).toEqual({
      instagram: "https://instagram.com/shopa_test/",
      facebook: "https://www.facebook.com/shopa.test.page",
      linkedin: "https://www.linkedin.com/company/shop-a-test",
      tiktok: "https://www.tiktok.com/@shopa.test",
      youtube: "https://www.youtube.com/@shopatest",
      x: "https://x.com/shopa_test",
    });
  });

  it("returns empty strings when no profile is linked", () => {
    expect(extractSocials('<a href="https://www.facebook.com/sharer.php?u=x">Share</a>', "https://shop-a.test/"))
      .toEqual({ instagram: "", facebook: "", linkedin: "", tiktok: "", youtube: "", x: "" });
  });
});

describe("contactLinks", () => {
  it("returns same-host links whose path or text looks like a contact page", () => {
    expect(contactLinks(site("shop-d.test.html"), "https://shop-d.test/")).toEqual([
      "https://shop-d.test/hubungi-kami",
    ]);
  });

  it("matches Chinese link text and caps the list at three", () => {
    const html = [
      '<a href="/a">联系我们</a>', '<a href="/b">关于</a>', '<a href="/about">x</a>',
      '<a href="/contact-us">y</a>', '<a href="/tentang">z</a>',
    ].join("");
    expect(contactLinks(html, "https://shop.test/")).toEqual([
      "https://shop.test/a", "https://shop.test/b", "https://shop.test/about",
    ]);
  });

  it("ignores invalid, non-http and other-host links", () => {
    const html = '<a href="http://[bad">contact</a><a href="mailto:a@b.test">contact</a><a href="https://other.test/contact">c</a>';
    expect(contactLinks(html, "https://shop.test/")).toEqual([]);
  });

  it("matches contact and about words across all app languages", () => {
    const cases: [string, string][] = [
      ['<a href="/kontak-kami">Page</a>', "https://shop.test/kontak-kami"],
      ['<a href="/p1">Mengenai kami</a>', "https://shop.test/p1"],
      ['<a href="/p2">Pertanyaan</a>', "https://shop.test/p2"],
      ['<a href="/p3">聯繫我們</a>', "https://shop.test/p3"],
      ['<a href="/p4">關於我們</a>', "https://shop.test/p4"],
      ['<a href="/lianxi">Lianxi</a>', "https://shop.test/lianxi"],
      ['<a href="/p5">ติดต่อเรา</a>', "https://shop.test/p5"],
      ['<a href="/p6">เกี่ยวกับเรา</a>', "https://shop.test/p6"],
      ['<a href="/tittor">Tittor</a>', "https://shop.test/tittor"],
      ['<a href="/p7">Liên hệ</a>', "https://shop.test/p7"],
      ['<a href="/p8">Giới thiệu</a>', "https://shop.test/p8"],
      ['<a href="/lien-he">Lien he</a>', "https://shop.test/lien-he"],
      ['<a href="/fale-conosco">Fale conosco</a>', "https://shop.test/fale-conosco"],
      ['<a href="/quem-somos">Quem somos</a>', "https://shop.test/quem-somos"],
      ['<a href="/quienes-somos">Quiénes somos</a>', "https://shop.test/quienes-somos"],
      ['<a href="/nous-contacter">Nous contacter</a>', "https://shop.test/nous-contacter"],
      ['<a href="/a-propos">À propos</a>', "https://shop.test/a-propos"],
      ['<a href="/kontakt">Kontakt</a>', "https://shop.test/kontakt"],
      ['<a href="/impressum">Impressum</a>', "https://shop.test/impressum"],
      ['<a href="/ueber-uns">Über uns</a>', "https://shop.test/ueber-uns"],
    ];
    for (const [html, expected] of cases) {
      expect(contactLinks(html, "https://shop.test/"), html).toEqual([expected]);
    }
  });

  it("falls back to up to three same-site links from footer or nav when no contact word matches", () => {
    const html = [
      '<header><a href="/promo">Promo outside nav</a></header>',
      '<nav><a href="/">Home</a><a href="/services">Services</a><a href="https://other.test/x">Other</a><a href="/logo.png">Logo</a></nav>',
      '<footer><nav><a href="/team">Team</a></nav><a href="/reach-out">Reach out</a><a href="/faq">FAQ</a></footer>',
    ].join("");
    expect(contactLinks(html, "https://shop.test/")).toEqual([
      "https://shop.test/services",
      "https://shop.test/team",
      "https://shop.test/reach-out",
    ]);
  });

  it("does not add nav or footer fallback links when a contact word already matched", () => {
    const html = '<nav><a href="/services">Services</a></nav><footer><a href="/contact">Contact</a><a href="/faq">FAQ</a></footer>';
    expect(contactLinks(html, "https://shop.test/")).toEqual(["https://shop.test/contact"]);
  });

  it("ignores query strings and skips links with the same path as the base page in nav/footer fallback", () => {
    const html = [
      '<nav>',
      '<a href="/">Home</a>',
      '<a href="/?lang=en">EN</a>',
      '<a href="/?lang=ms">BM</a>',
      '<a href="https://www.shop.test/">WWW</a>',
      '<a href="/services?ref=nav">Services</a>',
      '<a href="/services?ref=dup">Services again</a>',
      '</nav>',
      '<footer><a href="/team">Team</a></footer>',
    ].join("");
    expect(contactLinks(html, "https://shop.test/")).toEqual([
      "https://shop.test/services?ref=nav",
      "https://shop.test/team",
    ]);
  });
});

describe("matchesListing", () => {
  it("is true when the page shows the listing phone's last seven digits", () => {
    expect(matchesListing(site("shop-a.test.html"), lead({ phone: "06-281 2345", category: "Bakery" }))).toBe(true);
  });

  it("is true when the page contains a category word of four or more letters", () => {
    expect(matchesListing(site("shop-a.test.html"), lead({ category: "Florist shop" }))).toBe(true);
  });

  it("is false for a page with neither the phone nor a category word", () => {
    expect(matchesListing(site("shop-b.test.html"), lead({ phone: "06-281 2345", category: "Florist" }))).toBe(false);
  });

  it("does not match category words that only appear inside markup", () => {
    const html = '<div class="florist-banner"><p>Welcome</p></div>';
    expect(matchesListing(html, lead({ category: "Florist" }))).toBe(false);
  });

  it("matches a Malay-language page by distinctive business name token when phone and English category are absent", () => {
    const malayLead = toLead(
      { title: "Syarikat Pengurusan Acara Harmoni Sdn Bhd", category: "Event planner", source: "fixture", query: "event", city: "Kuala Lumpur" },
      "MY",
    );
    const html = "<!doctype html><html><head><title>Harmoni</title></head><body><h1>Selamat datang ke Harmoni</h1><p>Pakar majlis anda.</p></body></html>";
    expect(matchesListing(html, malayLead)).toBe(true);
  });

  it("matches a Chinese-language page by full CJK business name when phone and English category are absent", () => {
    const chineseLead = toLead(
      { title: "金辉煌活动策划有限公司", category: "Event planner", source: "fixture", query: "event", city: "Kuala Lumpur" },
      "MY",
    );
    const html = "<!doctype html><html><head><meta charset='utf-8'></head><body><h1><span>金辉煌</span><span>活动策划有限公司</span></h1><p>欢迎光临</p></body></html>";
    expect(matchesListing(html, chineseLead)).toBe(true);
  });

  it("does not falsely match an unrelated page on generic corporate, location, or CJK legal suffixes", () => {
    const genericLead = toLead(
      { title: "Melaka Services Sdn Bhd", category: "Event planner", phone: "06-281 2345", source: "fixture", query: "event", city: "Melaka" },
      "MY",
    );
    const otherHtml = "<html><body><p>Melaka Plumbing Services Sdn Bhd</p></body></html>";
    expect(matchesListing(otherHtml, genericLead)).toBe(false);

    const cjkSuffixLead = toLead(
      { title: "ABC 有限公司", category: "Event planner", phone: "03-1234 5678", source: "fixture", query: "event", city: "Kuala Lumpur" },
      "MY",
    );
    const unrelatedChinese = "<html><body><p>大华食品有限公司版权所有</p></body></html>";
    expect(matchesListing(unrelatedChinese, cjkSuffixLead)).toBe(false);
  });

  it("matches whole words only and requires two distinctive tokens when two or more exist", () => {
    const starFlorist = toLead(
      { title: "Star Florist", category: "Event planner", source: "fixture", query: "florist", city: "Melaka" },
      "MY",
    );
    expect(matchesListing("<p>Get started with our parking app</p>", starFlorist)).toBe(false);

    const megaBakery = toLead(
      { title: "Mega Bakery", category: "Event planner", source: "fixture", query: "bakery", city: "Melaka" },
      "MY",
    );
    expect(matchesListing("<p>Megabytes of storage</p>", megaBakery)).toBe(false);

    const royalPhoto = toLead(
      { title: "Royal Photography Sdn Bhd", category: "Event planner", source: "fixture", query: "photo", city: "KL" },
      "MY",
    );
    expect(matchesListing("<p>Royal Selangor pewter official store</p>", royalPhoto)).toBe(false);

    const primaDental = toLead(
      { title: "Prima Dental Clinic", category: "Event planner", source: "fixture", query: "dental", city: "KL" },
      "MY",
    );
    expect(matchesListing("<p>Prima Hotel Melaka</p>", primaDental)).toBe(false);
  });

  it("does not count country names from Intl.DisplayNames (English or lead locale) as distinctive", () => {
    const brazilRoasters = toLead(
      { title: "Brazil Coffee Roasters", category: "Roastery", source: "fixture", query: "coffee", city: "São Paulo" },
      "BR",
    );
    expect(matchesListing("<p>Brazil Coffee House</p>", brazilRoasters, { country: "BR" })).toBe(false);
    expect(matchesListing("<p>Coffee Roasters São Paulo</p>", brazilRoasters, { country: "BR" })).toBe(true);

    const brasilLocal = toLead(
      { title: "Brasil Coffee Roasters", category: "Cafeteria", source: "fixture", query: "coffee", city: "São Paulo" },
      "BR",
    );
    expect(matchesListing("<p>Brasil Coffee House</p>", brasilLocal, { country: "BR" })).toBe(false);
    expect(matchesListing('<html lang="pt"><body><p>Brasil Coffee House</p></body></html>', brasilLocal)).toBe(false);
  });

  it("does not count Portuguese street words as distinctive", () => {
    const avenidaCentral = toLead(
      { title: "Avenida Padaria Central", category: "Restaurant", source: "fixture", query: "bakery", city: "Lisboa" },
      "PT",
    );
    expect(matchesListing("<p>Avenida Central Shopping</p>", avenidaCentral, { country: "PT" })).toBe(false);

    const avenidaPadaria = toLead(
      { title: "Avenida Padaria", category: "Restaurant", source: "fixture", query: "bakery", city: "Lisboa" },
      "PT",
    );
    expect(matchesListing("<p>Padaria do Bairro</p>", avenidaPadaria, { country: "PT" })).toBe(true);
  });
});

describe("hostile pages", () => {
  it("handle two megabytes of base64, unclosed tags and stray markers quickly", () => {
    const html = [
      `<img src="data:image/png;base64,${"QUJD".repeat(250_000)}">`,
      "<a href=x ".repeat(20_000),
      "<a href=/contact>".repeat(20_000),
      "<script ".repeat(20_000),
      "a.b".repeat(50_000),
    ].join("");
    const started = performance.now();
    extractEmails(html);
    extractSocials(html, "https://shop.test/");
    contactLinks(html, "https://shop.test/");
    matchesListing(html, lead({ phone: "06-281 2345", category: "Florist" }));
    // About 1 s alone and linear in input size; with every test file running
    // in parallel on a laptop it reached 3.1 s. Catastrophic backtracking on
    // this input takes minutes, so 10 s still catches it without flaking.
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("returns empty results for an invalid base URL", () => {
    expect(contactLinks('<a href="/contact">c</a>', "not a url")).toEqual([]);
    expect(extractSocials('<a href="/x">c</a>', "not a url").facebook).toBe("");
  });
});

describe("extractTelLinks", () => {
  it("reads tel: link targets in page order, decoded and deduped", () => {
    const html = [
      '<a href="tel:+60%206-281%202345">Call</a>',
      "<a href='TEL:06-281 2345'>Office</a>",
      '<a href="tel:+60%206-281%202345">Call again</a>',
      '<a href="tel:+6012&#45;345&#32;6789">Mobile</a>',
    ].join("");
    expect(extractTelLinks(html)).toEqual(["+60 6-281 2345", "06-281 2345", "+6012-345 6789"]);
  });

  it("ignores numbers that are only in the page text, and tel: text outside a link", () => {
    expect(extractTelLinks("<p>Call +60 6-281 2345 or tel:06-281 2345</p>")).toEqual([]);
  });

  it("drops a parameter or extension suffix and an empty target", () => {
    expect(extractTelLinks('<a href="tel:+6062812345;ext=12">x</a><a href="tel:">y</a>')).toEqual(["+6062812345"]);
  });
});
