import { describe, expect, it } from "vitest";
import {
  ENTRIES_INDEX,
  FIELD_PATHS,
  LIST_PATHS,
  MAX_IMAGES,
  STRUCTURED_PATHS,
  addDerivedFields,
  dig,
  parseBatch,
  parsePlaceLink,
} from "../src/core/sources/browser/fields.js";
import { makeBatch } from "./fixtures/batch.js";

describe("dig", () => {
  it("follows an index path through nested arrays", () => {
    expect(dig([0, [1, [2, "deep"]]], [1, 1, 1])).toBe("deep");
  });

  it("returns undefined when the path leaves the structure", () => {
    expect(dig([0, [1]], [1, 5, 0])).toBeUndefined();
    expect(dig("not an array", [0])).toBeUndefined();
    expect(dig(null, [0])).toBeUndefined();
  });
});

describe("parseBatch", () => {
  it("round-trips a synthetic batch and derives cid from data_id", () => {
    const places = parseBatch(
      makeBatch([{ title: "Test Shop A", phone: "012-000 0001", data_id: "0x1:0xff" }]),
    );
    expect(places).toHaveLength(1);
    expect(places[0]?.title).toBe("Test Shop A");
    expect(places[0]?.phone).toBe("012-000 0001");
    expect(places[0]?.data_id).toBe("0x1:0xff");
    expect(places[0]?.cid).toBe("255");
  });

  it("reads every field in the index-path table", () => {
    const [place] = parseBatch(
      makeBatch([
        {
          title: "Test Shop B",
          category: "Test category",
          address: "1 Example Road, Test City",
          website: "https://shop-b.example.com/",
          phone: "012-000 0002",
          review_rating: 4.5,
          review_count: 120,
          latitude: 1.25,
          longitude: 103.5,
          place_id: "ChIJTestPlaceB",
          data_id: "0xabc:0x10",
        },
      ]),
    );
    expect(place).toEqual({
      title: "Test Shop B",
      category: "Test category",
      address: "1 Example Road, Test City",
      website: "https://shop-b.example.com/",
      phone: "012-000 0002",
      review_rating: 4.5,
      review_count: 120,
      latitude: 1.25,
      longitude: 103.5,
      place_id: "ChIJTestPlaceB",
      data_id: "0xabc:0x10",
      cid: "16",
      categories: "Test category",
      plus_code: "6PH57G22+22",
      link: "https://www.google.com/maps/search/?api=1&query=Test%20Shop%20B&query_place_id=ChIJTestPlaceB",
    });
  });

  it("keeps cid exact for ids beyond the safe integer range", () => {
    const [place] = parseBatch(makeBatch([{ title: "Test Shop C", data_id: "0x1:0xffffffffffffffff" }]));
    expect(place?.cid).toBe("18446744073709551615");
  });

  it("skips entries without a title", () => {
    const places = parseBatch(makeBatch([{ phone: "012-000 0003" }, { title: "Test Shop D" }]));
    expect(places.map((p) => p.title)).toEqual(["Test Shop D"]);
  });

  it("returns [] for a body that is not JSON", () => {
    expect(parseBatch("not json")).toEqual([]);
    expect(parseBatch(")]}'\n{broken")).toEqual([]);
    expect(parseBatch("")).toEqual([]);
  });

  it("returns [] when the entries slot is missing", () => {
    expect(parseBatch(")]}'\n[]")).toEqual([]);
    expect(parseBatch(`)]}'\n${JSON.stringify(new Array(ENTRIES_INDEX).fill(null))}`)).toEqual([]);
    expect(parseBatch(")]}'\n{\"a\":1}")).toEqual([]);
  });

  it("accepts a body without the anti-JSON prefix", () => {
    const body = makeBatch([{ title: "Test Shop E" }]).replace(/^\)\]\}'\n/, "");
    expect(parseBatch(body).map((p) => p.title)).toEqual(["Test Shop E"]);
  });

  it("ignores values of the wrong type instead of passing them through", () => {
    const [place] = parseBatch(
      makeBatch([{ title: "Test Shop F", review_rating: "4.5", phone: 120, data_id: "no-colon" }]),
    );
    expect(place).toEqual({ title: "Test Shop F", data_id: "no-colon" });
  });

  it("reads the extra scalar place fields", () => {
    const [place] = parseBatch(
      makeBatch([
        {
          title: "Test Shop H",
          reviews_link: "https://search.example.com/reviews?id=h",
          status: "Open now",
          thumbnail: "https://images.example.com/h.jpg",
          timezone: "Asia/Kuala_Lumpur",
          price_range: "RM 20-40",
          descriptions: "A test shop that sells test goods.",
        },
      ]),
    );
    expect(place).toEqual({
      title: "Test Shop H",
      reviews_link: "https://search.example.com/reviews?id=h",
      status: "Open now",
      thumbnail: "https://images.example.com/h.jpg",
      timezone: "Asia/Kuala_Lumpur",
      price_range: "RM 20-40",
      descriptions: "A test shop that sells test goods.",
      // The thumbnail is the first photo of the [72, 0] gallery.
      images: '[{"title":"","image":"https://images.example.com/h.jpg"}]',
    });
  });

  it("joins the category list with ' | ' and keeps the first as category", () => {
    const [place] = parseBatch(makeBatch([{ title: "Test Shop I", categories: ["Hotel", "Resort"] }]));
    expect(place?.categories).toBe("Hotel | Resort");
    expect(place?.category).toBe("Hotel");
  });

  it("skips non-string and empty items in the category list", () => {
    const [place] = parseBatch(makeBatch([{ title: "Test Shop J", categories: ["Hotel", 3, "", "Spa"] }]));
    expect(place?.categories).toBe("Hotel | Spa");
    const [none] = parseBatch(makeBatch([{ title: "Test Shop K", categories: [] }]));
    expect(none?.categories).toBeUndefined();
  });

  it("computes plus_code from the coordinates", () => {
    const [place] = parseBatch(makeBatch([{ title: "Test Shop L", latitude: 20.3700625, longitude: 2.7821875 }]));
    expect(place?.plus_code).toBe("7FG49QCJ+2V");
    const [noCoords] = parseBatch(makeBatch([{ title: "Test Shop M", latitude: 1.5 }]));
    expect(noCoords?.plus_code).toBeUndefined();
  });

  it("builds a Maps link from place_id, and none without it", () => {
    const [place] = parseBatch(makeBatch([{ title: "Café & Bar Test", place_id: "ChIJ Test/1" }]));
    expect(place?.link).toBe(
      "https://www.google.com/maps/search/?api=1&query=Caf%C3%A9%20%26%20Bar%20Test&query_place_id=ChIJ%20Test%2F1",
    );
    const [noId] = parseBatch(makeBatch([{ title: "Test Shop N" }]));
    expect(noId?.link).toBeUndefined();
  });

  it("leaves an existing link untouched", () => {
    const place = addDerivedFields({
      title: "Test Shop O",
      place_id: "ChIJTestPlaceO",
      link: "https://www.google.com/maps/place/Test+Shop+O",
    });
    expect(place.link).toBe("https://www.google.com/maps/place/Test+Shop+O");
  });

  it("covers exactly the documented fields", () => {
    expect(Object.keys(FIELD_PATHS).sort()).toEqual(
      [
        "address",
        "category",
        "data_id",
        "descriptions",
        "latitude",
        "longitude",
        "phone",
        "place_id",
        "price_range",
        "review_count",
        "review_rating",
        "reviews_link",
        "status",
        "thumbnail",
        "timezone",
        "title",
        "website",
      ].sort(),
    );
    expect(Object.keys(LIST_PATHS)).toEqual(["categories"]);
    expect(Object.keys(STRUCTURED_PATHS).sort()).toEqual(
      ["about", "complete_address", "menu", "open_hours", "order_online", "reservations"].sort(),
    );
  });

  it("writes the category list before category when both are given", () => {
    const [place] = parseBatch(
      makeBatch([{ title: "Test Shop P", category: "Spa", categories: ["Hotel", "Resort"] }]),
    );
    expect(place?.category).toBe("Spa");
    expect(place?.categories).toBe("Spa | Resort");
  });
});

/** One day as Google sends it: name, day number (Monday = 1), date, time slots. */
const day = (name: string, n: number, ...slots: string[]) => [name, n, [2026, 11, n], slots.map((s) => [s, []]), 0, 1];
const WEEK = [
  day("Thursday", 4, "9 AM–6 PM"),
  day("Friday", 5, "9 AM–1 PM", "2–6 PM"),
  day("Saturday", 6, "10 AM–4 PM"),
  day("Sunday", 7, "Closed"),
  day("Monday", 1, "9 AM–6 PM"),
  day("Tuesday", 2, "9 AM–6 PM"),
  day("Wednesday", 3, "9 AM–6 PM"),
];

describe("parseBatch structured fields", () => {
  it("reads opening hours Monday first, keyed by day number", () => {
    const [place] = parseBatch(makeBatch([{ title: "Test Shop Q", open_hours: WEEK }]));
    expect(place?.open_hours).toBe(
      '{"Monday":["9 AM–6 PM"],"Tuesday":["9 AM–6 PM"],"Wednesday":["9 AM–6 PM"],' +
        '"Thursday":["9 AM–6 PM"],"Friday":["9 AM–1 PM","2–6 PM"],"Saturday":["10 AM–4 PM"],"Sunday":["Closed"]}',
    );
  });

  it("leaves opening hours empty unless all seven days are present", () => {
    const [place] = parseBatch(makeBatch([{ title: "Test Shop R", open_hours: WEEK.slice(1) }]));
    expect(place?.open_hours).toBeUndefined();
    const twice = [...WEEK.slice(1), day("Friday", 5, "9 AM–6 PM")];
    expect(parseBatch(makeBatch([{ title: "Test Shop S", open_hours: twice }]))[0]?.open_hours).toBeUndefined();
  });

  it("reads the address parts", () => {
    const parts = ["Test Borough", "1 Example Road", "1 Example Road", "Test City", "75000", "Test State", "MY"];
    const [place] = parseBatch(makeBatch([{ title: "Test Shop T", complete_address: parts }]));
    expect(place?.complete_address).toBe(
      '{"borough":"Test Borough","street":"1 Example Road","city":"Test City",' +
        '"postal_code":"75000","state":"Test State","country":"MY"}',
    );
    const sparse = [null, null, null, "Test City", null, null, "MY"];
    expect(parseBatch(makeBatch([{ title: "Test Shop U", complete_address: sparse }]))[0]?.complete_address).toBe(
      '{"borough":"","street":"","city":"Test City","postal_code":"","state":"","country":"MY"}',
    );
    const empty = parseBatch(makeBatch([{ title: "Test Shop V", complete_address: [null, ""] }]))[0];
    expect(empty?.complete_address).toBeUndefined();
  });

  it("reads attribute groups and the accepted credit cards", () => {
    const option = (name: string, ...items: [number, string][]) => [
      `/geo/test/${name}`,
      name,
      [1, items, [1, name]],
      null,
      [4],
      0,
    ];
    const about = [
      [
        "accessibility",
        "Accessibility",
        [
          option("Wheelchair-accessible entrance", [1, "Wheelchair-accessible entrance"]),
          option("Wheelchair-accessible toilet", [0, "No wheelchair-accessible toilet"]),
        ],
      ],
      ["payments", "Payments", [option("Credit cards", [1, "Visa"], [1, "Mastercard"], [0, "American Express"])]],
      [null, "No id", []],
    ];
    const [place] = parseBatch(makeBatch([{ title: "Test Shop W", about }]));
    expect(place?.about).toBe(
      '[{"id":"accessibility","name":"Accessibility","options":[' +
        '{"name":"Wheelchair-accessible entrance","enabled":true},' +
        '{"name":"Wheelchair-accessible toilet","enabled":false}]},' +
        '{"id":"payments","name":"Payments","options":[' +
        '{"name":"Credit cards","enabled":true,"values":["Visa","Mastercard"]}]}]',
    );
    expect(place?.credit_cards_accepted).toBe("Visa, Mastercard");
  });

  it("leaves credit cards empty without a payments group", () => {
    const [place] = parseBatch(makeBatch([{ title: "Test Shop X", about: [["accessibility", "Accessibility", []]] }]));
    expect(place?.about).toBe('[{"id":"accessibility","name":"Accessibility","options":[]}]');
    expect(place?.credit_cards_accepted).toBeUndefined();
  });

  it("reads reservation links and drops links that are not http(s)", () => {
    const reservations = [
      ["https://book.example.com/t/1", "book.example.com", null, null, "token"],
      ["javascript:alert(1)", "evil.example.com"],
      ["http://reserve.example.com/", "reserve.example.com"],
    ];
    const [place] = parseBatch(makeBatch([{ title: "Test Shop Y", reservations }]));
    expect(place?.reservations).toBe(
      '[{"link":"https://book.example.com/t/1","source":"book.example.com"},' +
        '{"link":"http://reserve.example.com/","source":"reserve.example.com"}]',
    );
    const onlyBad = [["javascript:alert(1)", "evil.example.com"]];
    expect(parseBatch(makeBatch([{ title: "Test Shop Z", reservations: onlyBad }]))[0]?.reservations).toBeUndefined();
  });

  it("reads order-online links from the type 3 action group only", () => {
    const link = (source: string, url: string) => [[source], [null, null, [url, [url]]]];
    const order_online = [
      [1, null, [link("book.example.com", "https://book.example.com/1")], null, 21631],
      [
        3,
        null,
        [link("food.example.com", "https://food.example.com/order/1"), link("bad.example.com", "ftp://bad.example.com/")],
        null,
        21633,
      ],
      [4, null, null, null, 21634, ["Order online"]],
    ];
    const [place] = parseBatch(makeBatch([{ title: "Test Shop AA", order_online }]));
    expect(place?.order_online).toBe('[{"link":"https://food.example.com/order/1","source":"food.example.com"}]');
  });

  it("reads the menu link", () => {
    const menu = ["https://menu.example.com/ab", "menu.example.com"];
    const [place] = parseBatch(makeBatch([{ title: "Test Shop AB", menu }]));
    expect(place?.menu).toBe('{"link":"https://menu.example.com/ab","source":"menu.example.com"}');
    const bad = parseBatch(makeBatch([{ title: "Test Shop AC", menu: ["data:text/html,x", "x"] }]))[0];
    expect(bad?.menu).toBeUndefined();
  });

  it("reads photos from the three galleries, deduped and filtered", () => {
    const titled = (title: string, url: string) => [null, null, title, [[null, null, null, null, null, null, [url]]]];
    const plain = (url: string) => [null, null, null, null, null, null, [url, "", [10, 10]]];
    const long = `https://img.example.com/${"a".repeat(1000)}.jpg`;
    const [place] = parseBatch(
      makeBatch([
        {
          title: "Test Shop AD",
          galleries: [
            [titled("Menu", "https://img.example.com/1.jpg"), titled("All", "http://img.example.com/insecure.jpg")],
            [plain("https://img.example.com/2.jpg"), plain("https://user:pw@img.example.com/3.jpg")],
            [plain("https://img.example.com/2.jpg"), plain(long), plain("https://img.example.com/4.jpg")],
          ],
        },
      ]),
    );
    expect(place?.images).toBe(
      '[{"title":"Menu","image":"https://img.example.com/1.jpg"},' +
        '{"title":"","image":"https://img.example.com/2.jpg"},' +
        '{"title":"","image":"https://img.example.com/4.jpg"}]',
    );
  });

  it("keeps at most 20 photos", () => {
    const plain = (i: number) => [null, null, null, null, null, null, [`https://img.example.com/${i}.jpg`]];
    const gallery = Array.from({ length: 21 }, (_, i) => plain(i));
    const [place] = parseBatch(makeBatch([{ title: "Test Shop AE", galleries: [[], gallery] }]));
    const images = JSON.parse(place?.images ?? "[]") as { image: string }[];
    expect(MAX_IMAGES).toBe(20);
    expect(images).toHaveLength(20);
    expect(images.at(-1)?.image).toBe("https://img.example.com/19.jpg");
  });

  it("leaves structured fields unset when their slots hold the wrong type", () => {
    const [place] = parseBatch(
      makeBatch([
        {
          title: "Test Shop AF",
          open_hours: "x",
          complete_address: 3,
          about: "x",
          reservations: {},
          order_online: 1,
          menu: 2,
          galleries: [["x"], [null]],
        },
      ]),
    );
    expect(place).toEqual({ title: "Test Shop AF" });
  });
});

describe("parsePlaceLink", () => {
  const href =
    "https://www.google.com/maps/place/Test+Shop+G/data=!4m7!3m6!1s0x31d1e3a5b6c7d8e9:0x1a2b3c4d5e6f7a8b!8m2!3d2.1896!4d102.2501!16s%2Fg%2F11test!19sChIJTestPlaceG?authuser=0&hl=en&rclk=1";

  it("extracts the ids and coordinates from a /maps/place/ URL", () => {
    expect(parsePlaceLink(href, "Test Shop G")).toEqual({
      link: href,
      title: "Test Shop G",
      data_id: "0x31d1e3a5b6c7d8e9:0x1a2b3c4d5e6f7a8b",
      latitude: 2.1896,
      longitude: 102.2501,
      place_id: "ChIJTestPlaceG",
      cid: "1885667171979197067",
    });
  });

  it("falls back to the name in the path when no label is given", () => {
    expect(parsePlaceLink(href).title).toBe("Test Shop G");
    const encoded = href.replace("Test+Shop+G", "Caf%C3%A9+%26+Bar+Test");
    expect(parsePlaceLink(encoded).title).toBe("Café & Bar Test");
  });

  it("parses negative coordinates", () => {
    const p = parsePlaceLink("https://www.google.com/maps/place/X/data=!3d-33.86!4d-151.2", "X");
    expect(p.latitude).toBe(-33.86);
    expect(p.longitude).toBe(-151.2);
  });

  it("leaves missing parts undefined", () => {
    expect(parsePlaceLink("https://www.google.com/maps/search/test", "Label")).toEqual({
      link: "https://www.google.com/maps/search/test",
      title: "Label",
      data_id: undefined,
      latitude: undefined,
      longitude: undefined,
      place_id: undefined,
    });
  });
});

describe("parseBatch address without the place's name", () => {
  const addressOf = (title: string, address: string) => parseBatch(makeBatch([{ title, address }]))[0]?.address;

  it("drops a leading name and its comma", () => {
    expect(addressOf("Clínica São Dente", "Clínica São Dente, R. Borges Carneiro 20B, 1200-619 Lisboa")).toBe(
      "R. Borges Carneiro 20B, 1200-619 Lisboa",
    );
  });

  it("drops a leading name and its spaced hyphen, keeping the branch suffix", () => {
    expect(
      addressOf(
        "Klinik Pergigian Senyum",
        "Klinik Pergigian Senyum - Cawangan Cheras, 12 Jalan Cheras, 56000 Kuala Lumpur",
      ),
    ).toBe("Cawangan Cheras, 12 Jalan Cheras, 56000 Kuala Lumpur");
  });

  it("matches the name ignoring case and surrounding whitespace", () => {
    expect(addressOf("  Clínica São Dente ", "  CLÍNICA SÃO DENTE ,  R. Borges Carneiro 20B, 1200-619 Lisboa")).toBe(
      "R. Borges Carneiro 20B, 1200-619 Lisboa",
    );
  });

  it("leaves an address that does not start with the name unchanged", () => {
    expect(addressOf("Clínica São Dente", "R. Borges Carneiro 20B, 1200-619 Lisboa")).toBe(
      "R. Borges Carneiro 20B, 1200-619 Lisboa",
    );
    // Starts with the name's text, but the name is not followed by a separator.
    expect(addressOf("Rua Augusta", "Rua Augusta 100, 1100-053 Lisboa")).toBe("Rua Augusta 100, 1100-053 Lisboa");
  });

  it("drops a leading name followed by an Arabic comma", () => {
    expect(addressOf("مطعم الياسمين", "مطعم الياسمين، شارع الملك فهد، الرياض")).toBe("شارع الملك فهد، الرياض");
  });

  it("drops a leading name followed by a full-width comma", () => {
    expect(addressOf("小林花店", "小林花店，中山路 12 号，台北市")).toBe("中山路 12 号，台北市");
  });

  it("drops a leading name and its spaced en dash, keeping the branch suffix", () => {
    expect(
      addressOf(
        "Klinik Pergigian Senyum",
        "Klinik Pergigian Senyum – Cawangan Cheras, 12 Jalan Cheras, 56000 Kuala Lumpur",
      ),
    ).toBe("Cawangan Cheras, 12 Jalan Cheras, 56000 Kuala Lumpur");
  });

  it("does not treat a hyphen with no space after it as a separator", () => {
    expect(addressOf("ABC", "ABC -Mart, 5 Jalan Bunga, 75000 Melaka")).toBe("ABC -Mart, 5 Jalan Bunga, 75000 Melaka");
    expect(addressOf("ABC", "ABC –Mart, 5 Jalan Bunga, 75000 Melaka")).toBe("ABC –Mart, 5 Jalan Bunga, 75000 Melaka");
  });

  it("keeps an address that is the name alone, or the name and a bare separator", () => {
    expect(addressOf("Clínica São Dente", "Clínica São Dente")).toBe("Clínica São Dente");
    expect(addressOf("Clínica São Dente", "Clínica São Dente, ")).toBe("Clínica São Dente, ");
  });
});
