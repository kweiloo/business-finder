import { describe, expect, it } from "vitest";
import {
  ALL_COLUMNS,
  EXTRA_PLACE_COLUMNS,
  FULL_EXTRA_COLUMNS,
  LEAN_COLUMNS,
  resolveColumns,
  toCsv,
  toJson,
  UnknownColumnError,
} from "../src/core/export/csv.js";
import { samePhoneAs } from "../src/core/export/same-phone.js";
import { fileURLToPath } from "node:url";
import { enrichLeads, fixtureFetcher } from "../src/core/enrich/enrich.js";
import { toLead } from "../src/core/leads/normalize.js";
import type { Lead, Source } from "../src/core/types.js";

const SITES = fileURLToPath(new URL("./fixtures/sites/", import.meta.url));
const NETWORKS = ["instagram", "facebook", "linkedin", "tiktok", "youtube", "x"] as const;

const BOM = "﻿";

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    title: "Kedai Contoh Sdn Bhd",
    source: "fixture",
    query: "bakery",
    city: "Melaka",
    whatsapp: "",
    emails: [],
    email_source_url: "",
    email_status: "not_on_site",
    website_status: "no_website",
    instagram: "",
    facebook: "",
    linkedin: "",
    tiktok: "",
    youtube: "",
    x: "",
    fetched_at: "2026-11-17T00:00:00.000Z",
    ...overrides,
  };
}

/** Minimal RFC 4180 reader used to check that written CSV parses back. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function rowsOf(csv: string): string[][] {
  expect(csv.startsWith(BOM)).toBe(true);
  return parseCsv(csv.slice(BOM.length));
}

describe("column sets", () => {
  it("lists the lean columns in the documented order", () => {
    expect(LEAN_COLUMNS).toEqual([
      "title", "phone", "whatsapp", "emails", "email_types", "email_mx", "website", "category", "address",
      "review_rating", "review_count", "instagram", "facebook", "linkedin", "tiktok", "youtube", "x",
    ]);
  });

  it("lists the full extra columns: ours, then the missing extra place columns in order, then categories", () => {
    expect(FULL_EXTRA_COLUMNS).toEqual([
      "place_id", "data_id", "cid", "latitude", "longitude", "source", "email_source_url",
      "email_status", "website_status", "fetched_at", "query", "city", "link", "sources", "same_phone_as",
      "first_seen", "new", "not_found_last_time",
      "input_id", "open_hours", "popular_times", "plus_code", "reviews_per_rating", "status",
      "descriptions", "reviews_link", "thumbnail", "timezone", "price_range", "street_view_url",
      "images", "reservations", "order_online", "menu", "owner", "complete_address",
      "credit_cards_accepted", "about", "user_reviews", "user_reviews_extended", "categories",
    ]);
  });

  it("holds the 36 extra place columns in order", () => {
    expect(EXTRA_PLACE_COLUMNS).toHaveLength(36);
    expect(EXTRA_PLACE_COLUMNS.slice(0, 4)).toEqual(["input_id", "link", "title", "category"]);
    expect(EXTRA_PLACE_COLUMNS.at(-1)).toBe("emails");
  });

  it("puts every extra place column exactly once in the full set, after the lean set", () => {
    expect(ALL_COLUMNS.slice(0, LEAN_COLUMNS.length)).toEqual(LEAN_COLUMNS);
    expect(new Set(ALL_COLUMNS).size).toBe(ALL_COLUMNS.length);
    for (const name of EXTRA_PLACE_COLUMNS) expect(ALL_COLUMNS.filter((c) => c === name)).toHaveLength(1);
  });
});

describe("resolveColumns", () => {
  it("gives the lean set by default and the full set with full", () => {
    expect(resolveColumns({ full: false })).toEqual(LEAN_COLUMNS);
    expect(resolveColumns({ full: true })).toEqual(ALL_COLUMNS);
  });

  it("splits, trims and dedupes --fields in the given order", () => {
    expect(resolveColumns({ full: false, fields: " title, phone ,plus_code,phone" })).toEqual(["title", "phone", "plus_code"]);
  });

  it("names every unknown column", () => {
    let error: unknown;
    try {
      resolveColumns({ full: false, fields: "titel,phone,fone" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnknownColumnError);
    expect((error as UnknownColumnError).unknown).toEqual(["titel", "fone"]);
    expect((error as Error).message).toBe(`Unknown column(s): titel, fone. Valid columns: ${ALL_COLUMNS.join(", ")}`);
  });

  it("rejects an empty list", () => {
    expect(() => resolveColumns({ full: false, fields: " , " })).toThrow(UnknownColumnError);
  });
});

describe("extra place columns in an export", () => {
  it("fills input_id from the query", () => {
    const [header = [], row = []] = rowsOf(toCsv([lead({ plus_code: "6PM3Q7XX+XX" })], ALL_COLUMNS));
    const byName = Object.fromEntries(header.map((name, i) => [name, row[i]]));
    expect(byName.input_id).toBe("bakery");
    expect(byName.plus_code).toBe("6PM3Q7XX+XX");
    expect(JSON.parse(toJson([lead()], ["input_id"]))).toEqual([{ input_id: "bakery" }]);
  });
});

describe("samePhoneAs", () => {
  it("points each of two places sharing a phone at the other and keeps both", () => {
    const leads = [
      lead({ title: "Stay A", phone: "06-283 0000" }),
      lead({ title: "Shop B", phone: "06-283 1111" }),
      lead({ title: "Stay C", phone: "062830000" }),
      lead({ title: "No phone" }),
    ];
    expect(samePhoneAs(leads)).toEqual([["Stay C"], [], ["Stay A"], []]);
  });

  it("lists every other place when three share a phone", () => {
    const leads = ["A", "B", "C"].map((t) => lead({ title: t, phone: "+60 12-000 0001" }));
    expect(samePhoneAs(leads)).toEqual([["B", "C"], ["A", "C"], ["A", "B"]]);
  });

  it("writes the flag in CSV and JSON without dropping a row", () => {
    const leads = [lead({ title: "Stay A", phone: "06-283 0000" }), lead({ title: "Stay C", phone: "06 283 0000" })];
    const rows = rowsOf(toCsv(leads, ["title", "same_phone_as"]));
    expect(rows).toEqual([["title", "same_phone_as"], ["Stay A", "Stay C"], ["Stay C", "Stay A"]]);
    expect(JSON.parse(toJson(leads, ["same_phone_as"]))).toEqual([{ same_phone_as: ["Stay C"] }, { same_phone_as: ["Stay A"] }]);
  });
});

describe("same_phone_as in CSV", () => {
  it("joins titles with \" | \" so a title containing a comma splits back unambiguously", () => {
    const leads = [
      lead({ title: "ZZMARK-13", phone: "06-283 0000" }),
      lead({ title: "ZZMARK-22, Sdn Bhd", phone: "06-283 0000" }),
      lead({ title: "Stay C", phone: "062830000" }),
    ];
    const rows = rowsOf(toCsv(leads, ["title", "same_phone_as"]));
    expect(rows[1]).toEqual(["ZZMARK-13", "ZZMARK-22, Sdn Bhd | Stay C"]);
    expect(rows[1]![1]!.split(" | ")).toEqual(["ZZMARK-22, Sdn Bhd", "Stay C"]);
    expect(JSON.parse(toJson(leads, ["same_phone_as"]))[0]).toEqual({ same_phone_as: ["ZZMARK-22, Sdn Bhd", "Stay C"] });
  });

  it("still prefixes the cell with ' when the first title looks like a formula", () => {
    const leads = ["=HYPERLINK(1)", "Stay C", "Stay D"].map((title) => lead({ title, phone: "06-283 0000" }));
    const rows = rowsOf(toCsv(leads, ["same_phone_as"]));
    expect(rows[2]).toEqual(["'=HYPERLINK(1) | Stay D"]);
  });
});

describe("toCsv", () => {
  it("starts with a UTF-8 byte order mark", () => {
    expect(toCsv([lead()], LEAN_COLUMNS).startsWith(BOM)).toBe(true);
  });

  it("writes the header with plain-English names for email columns", () => {
    const csv = toCsv([lead()], LEAN_COLUMNS);
    expect(csv.slice(BOM.length).split("\r\n")[0]).toBe(
      "title,phone,whatsapp,emails,Email type,Can receive mail,website,category,address,review_rating,review_count,instagram,facebook,linkedin,tiktok,youtube,x",
    );
  });

  it("ends every record, the last included, with CRLF", () => {
    const csv = toCsv([lead({ title: "A" }), lead({ title: "B" })], ["title"]);
    expect(csv).toBe(`${BOM}title\r\nA\r\nB\r\n`);
  });

  it("writes only the header for an empty lead list", () => {
    expect(toCsv([], ["title", "phone"])).toBe(`${BOM}title,phone\r\n`);
  });

  it("prefixes a formula and doubles its quotes", () => {
    const csv = toCsv([lead({ title: '=HYPERLINK("x")' })], ["title"]);
    expect(csv.split("\r\n")[1]).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it.each(["=1+1", "+60123456789", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"])(
    "prefixes a string cell starting with a formula trigger: %j",
    (title) => {
      const [, row] = rowsOf(toCsv([lead({ title })], ["title"]));
      expect(row).toEqual([`'${title}`]);
    },
  );

  it("leaves a string cell alone when the trigger is not the first character", () => {
    const [, row] = rowsOf(toCsv([lead({ title: "Shop = Best", address: " -5 Jalan" })], ["title", "address"]));
    expect(row).toEqual(["Shop = Best", " -5 Jalan"]);
  });

  it("writes numbers as numbers, negative ones unprefixed", () => {
    const l = lead({ review_rating: 4.5, review_count: 0, latitude: -2.25, longitude: 102.25 });
    const [, row] = rowsOf(toCsv([l], ["review_rating", "review_count", "latitude", "longitude"]));
    expect(row).toEqual(["4.5", "0", "-2.25", "102.25"]);
  });

  it("writes a non-finite number as an empty cell", () => {
    const [, row] = rowsOf(toCsv([lead({ latitude: Number.NaN })], ["latitude", "title"]));
    expect(row).toEqual(["", "Kedai Contoh Sdn Bhd"]);
  });

  it("keeps a Chinese title intact through a round-trip", () => {
    const title = "马六甲娘惹糕点 Kuih Nyonya";
    const [, row] = rowsOf(toCsv([lead({ title })], ["title"]));
    expect(row).toEqual([title]);
  });

  it("quotes a value containing a comma", () => {
    const csv = toCsv([lead({ address: "12 Jalan Hang Jebat, Melaka" })], ["address"]);
    expect(csv.split("\r\n")[1]).toBe('"12 Jalan Hang Jebat, Melaka"');
  });

  it("quotes and round-trips values with newlines and double quotes", () => {
    const address = "Lot 5\r\nJalan Bunga\nMelaka";
    const title = 'The "Best" Bakery';
    const csv = toCsv([lead({ title, address })], ["title", "address"]);
    expect(csv).toContain('"The ""Best"" Bakery"');
    const [, row] = rowsOf(csv);
    expect(row).toEqual([title, address]);
  });

  it("writes undefined and null values as empty cells", () => {
    const l = lead({ phone: undefined, website: null as unknown as string });
    const [, row] = rowsOf(toCsv([l], ["phone", "website", "title"]));
    expect(row).toEqual(["", "", "Kedai Contoh Sdn Bhd"]);
  });

  it("writes an unknown column as an empty cell", () => {
    const [header, row] = rowsOf(toCsv([lead()], ["title", "not_a_field"]));
    expect(header).toEqual(["title", "not_a_field"]);
    expect(row).toEqual(["Kedai Contoh Sdn Bhd", ""]);
  });

  it('joins emails with ", " in one quoted cell', () => {
    const csv = toCsv([lead({ emails: ["a@shop.test", "b@shop.test"] })], ["emails"]);
    expect(csv.split("\r\n")[1]).toBe('"a@shop.test, b@shop.test"');
    expect(rowsOf(csv)[1]).toEqual(["a@shop.test, b@shop.test"]);
  });

  it("writes the lean and full columns of one lead in order", () => {
    const l = lead({
      title: "Shop A",
      phone: "+60123456789",
      whatsapp: "https://wa.me/60123456789",
      emails: ["sales@shop-a.test"],
      website: "https://shop-a.test/",
      place_id: "PLACE_A",
      latitude: 2.19,
      link: "https://www.google.com/maps/place/?q=place_id:PLACE_A",
    });
    const columns = [...LEAN_COLUMNS, ...FULL_EXTRA_COLUMNS];
    const [header = [], row = []] = rowsOf(toCsv([l], columns));
    expect(header).toEqual(columns.map((c) => (c === "email_types" ? "Email type" : c === "email_mx" ? "Can receive mail" : c)));
    const byName = Object.fromEntries(header.map((name, i) => [name, row[i]]));
    expect(byName).toMatchObject({
      title: "Shop A",
      phone: "'+60123456789",
      whatsapp: "https://wa.me/60123456789",
      emails: "sales@shop-a.test",
      place_id: "PLACE_A",
      latitude: "2.19",
      longitude: "",
      source: "fixture",
      website_status: "no_website",
      link: "https://www.google.com/maps/place/?q=place_id:PLACE_A",
    });
  });
});

describe("sources column", () => {
  const sources: Source[] = [
    { field: "email", value: "hello@shop.test", url: "https://shop.test/", fetched_at: "2026-11-19T00:00:00.000Z" },
    { field: "facebook", value: "https://www.facebook.com/shop.test", url: "https://shop.test/contact", fetched_at: "2026-11-19T00:00:01.000Z" },
  ];

  it("writes sources as one JSON cell in CSV", () => {
    const [, row = []] = rowsOf(toCsv([lead({ sources })], ["sources"]));
    expect(JSON.parse(row[0]!)).toEqual(sources);
  });

  it("writes an empty source list as [] in CSV", () => {
    expect(rowsOf(toCsv([lead({ sources: [] })], ["sources"]))[1]).toEqual(["[]"]);
  });

  it("keeps sources an array in JSON", () => {
    const [row] = JSON.parse(toJson([lead({ sources })], ["sources"])) as Record<string, unknown>[];
    expect(row).toEqual({ sources });
  });

  it("has a source for every email and social link of an enriched fixture run", async () => {
    const leads = Array.from({ length: 10 }, (_, i) =>
      toLead({ title: `Shop ${i + 1}`, website: `https://shop-${i + 1}.test/`, source: "fixture", query: "florist", city: "Melaka" }, "MY"),
    );
    const enriched = await enrichLeads(leads, { emails: true, socials: true, deep: true, fetchSite: fixtureFetcher(SITES) }, () => {});
    const rows = JSON.parse(toJson(enriched.leads, [...LEAN_COLUMNS, ...FULL_EXTRA_COLUMNS])) as Lead[];
    let found = 0;
    for (const row of rows) {
      const expected = [
        ...row.emails.map((value) => ["email", value]),
        ...NETWORKS.filter((n) => row[n]).map((n) => [n, row[n]]),
      ];
      found += expected.length;
      expect(row.sources!.map((s) => [s.field, s.value])).toEqual(expected);
      for (const s of row.sources!) expect(s.url).toMatch(/^https:\/\/shop-\d+\.test\//);
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("toJson", () => {
  it("writes one object per lead with only the chosen columns, in order", () => {
    const json = toJson([lead({ title: "Shop A", review_rating: 4.5 })], ["title", "review_rating"]);
    const parsed = JSON.parse(json) as Record<string, unknown>[];
    expect(parsed).toEqual([{ title: "Shop A", review_rating: 4.5 }]);
    expect(Object.keys(parsed[0] ?? {})).toEqual(["title", "review_rating"]);
  });

  it("keeps emails as an array and values unprefixed", () => {
    const l = lead({ title: "=1+1", emails: ["a@shop.test", "b@shop.test"] });
    const [row] = JSON.parse(toJson([l], ["title", "emails"])) as Record<string, unknown>[];
    expect(row).toEqual({ title: "=1+1", emails: ["a@shop.test", "b@shop.test"] });
  });

  it("writes missing, unknown and non-finite values as null", () => {
    const l = lead({ phone: undefined, latitude: Number.NaN });
    const [row] = JSON.parse(toJson([l], ["phone", "latitude", "not_a_field"])) as Record<string, unknown>[];
    expect(row).toEqual({ phone: null, latitude: null, not_a_field: null });
  });

  it("keeps Chinese text as readable characters", () => {
    const json = toJson([lead({ title: "马六甲娘惹糕点" })], ["title"]);
    expect(json).toContain("马六甲娘惹糕点");
  });

  it("writes an empty array for no leads", () => {
    expect(JSON.parse(toJson([], LEAN_COLUMNS))).toEqual([]);
  });
});

describe("email_types and email_mx export columns", () => {
  it("writes plain user words and headers in CSV, aligns multiple emails, leaves unknown/empty blank, and keeps raw values in JSON", () => {
    const leads = [
      lead({
        title: "Two",
        emails: ["info@a.test", "alice@b.test"],
        email_types: ["generic", "personal"],
        email_mx: ["ok", "no mail server"],
      }),
      lead({
        title: "Not Sure",
        emails: ["event2026@c.test"],
        email_types: ["not_sure"],
        email_mx: ["ok"],
      }),
      lead({
        title: "Unknown MX",
        emails: ["sales@c.test", "bob@d.test"],
        email_types: ["generic", "personal"],
        email_mx: ["unknown", "unknown"],
      }),
      lead({
        title: "Mixed MX",
        emails: ["hello@e.test", "jane@f.test"],
        email_types: ["generic", "personal"],
        email_mx: ["ok", "unknown"],
      }),
      lead({
        title: "Legacy",
        emails: ["sales@c.test"],
        email_types: ["generic"],
      }),
      lead({
        title: "No Email",
        emails: [],
        email_types: [],
        email_mx: [],
      }),
    ];
    expect(rowsOf(toCsv(leads, ["title", "emails", "email_types", "email_mx"]))).toEqual([
      ["title", "emails", "Email type", "Can receive mail"],
      ["Two", "info@a.test, alice@b.test", "shared inbox, a person's address", "yes, no"],
      ["Not Sure", "event2026@c.test", "not sure", "yes"],
      ["Unknown MX", "sales@c.test, bob@d.test", "shared inbox, a person's address", ""],
      ["Mixed MX", "hello@e.test, jane@f.test", "shared inbox, a person's address", "yes, "],
      ["Legacy", "sales@c.test", "shared inbox", ""],
      ["No Email", "", "", ""],
    ]);
    expect(JSON.parse(toJson(leads, ["title", "email_types", "email_mx"]))).toEqual([
      { title: "Two", email_types: ["generic", "personal"], email_mx: ["ok", "no mail server"] },
      { title: "Not Sure", email_types: ["not_sure"], email_mx: ["ok"] },
      { title: "Unknown MX", email_types: ["generic", "personal"], email_mx: ["unknown", "unknown"] },
      { title: "Mixed MX", email_types: ["generic", "personal"], email_mx: ["ok", "unknown"] },
      { title: "Legacy", email_types: ["generic"], email_mx: null },
      { title: "No Email", email_types: [], email_mx: [] },
    ]);
  });

  it("includes Email type and Can receive mail in the lean Excel download", () => {
    const leads = [
      lead({
        title: "Dual",
        emails: ["info@dual.test", "maria@dual.test"],
        email_types: ["generic", "personal"],
        email_mx: ["ok", "no mail server"],
      }),
    ];
    const [header = [], row = []] = rowsOf(toCsv(leads, LEAN_COLUMNS));
    const byName = Object.fromEntries(header.map((name, i) => [name, row[i]]));
    expect(byName).toMatchObject({
      emails: "info@dual.test, maria@dual.test",
      "Email type": "shared inbox, a person's address",
      "Can receive mail": "yes, no",
    });
  });
});
