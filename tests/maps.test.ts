import { describe, expect, it } from "vitest";
import type { NetworkHandlers } from "../src/core/sources/browser/cdp.js";
import {
  CONSENT_COOKIES,
  PAGE_SCRIPTS,
  collectPlaces,
  mapsQuery,
  searchUrl,
  type CollectTiming,
  type MapsPage,
  type PageState,
} from "../src/core/sources/browser/maps.js";
import { makeBatch } from "./fixtures/batch.js";

const FAST: CollectTiming = { firstBatchMs: 300, settleMs: 60, slowBatchMs: 300, pollMs: 5 };
const BATCH_URL = "https://www.google.com/search?tb=1&tbm=map&authuser=0&hl=en&pb=x";
const SEARCH = searchUrl("test shop", 2.1, 102.2, "en", "MY");

/** A batch of `n` synthetic places with ids unique to `batchNo`. */
function batchOf(batchNo: number, n = 20): string {
  return makeBatch(
    Array.from({ length: n }, (_, i) => ({
      title: `Test Shop ${batchNo}-${i}`,
      phone: `012-000 ${String(batchNo * 100 + i).padStart(4, "0")}`,
      data_id: `0x1:0x${(batchNo * 100 + i).toString(16)}`,
    })),
  );
}

type Control = {
  /** Emits one batch request and, a tick later, its answer. */
  batch(body: string, opts?: { status?: number; redirect?: boolean }): void;
  /** Emits one batch request that fails without a response. */
  fail(): void;
  setUrl(url: string): void;
  setState(state: Partial<PageState>): void;
};

type Script = {
  onNavigate?: (c: Control) => void;
  /** Called on each feed scroll with the 1-based scroll number. */
  onScroll?: (c: Control, n: number) => void;
  links?: { href: string; label: string }[];
  state?: Partial<PageState>;
};

/** A scripted stand-in for CdpPage: network events and page-probe answers come from `script`. */
class FakePage implements MapsPage {
  cookies: { name: string; value: string; domain: string }[] = [];
  scrolls = 0;
  private currentUrl = "about:blank";
  private handlers: NetworkHandlers | undefined;
  private bodies = new Map<string, string>();
  private nextId = 1;
  private state: PageState;

  constructor(private readonly script: Script) {
    this.state = { feed: true, end: false, unusual: false, height: 1000, ...script.state };
  }

  private control: Control = {
    batch: (body, opts = {}) => {
      const id = `req-${this.nextId++}`;
      this.bodies.set(id, body);
      this.handlers?.request(id, BATCH_URL);
      // A redirect re-sends the same request id; the 30x itself never reaches `response`.
      if (opts.redirect) this.handlers?.request(id, BATCH_URL);
      setTimeout(() => this.handlers?.response(id, BATCH_URL, opts.status ?? 200, "application/json"), 5);
    },
    fail: () => {
      const id = `req-${this.nextId++}`;
      this.handlers?.request(id, BATCH_URL);
      setTimeout(() => this.handlers?.failed(id), 5);
    },
    setUrl: (url) => {
      this.currentUrl = url;
    },
    setState: (state) => {
      this.state = { ...this.state, ...state };
    },
  };

  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
    this.script.onNavigate?.(this.control);
  }

  async eval<T>(expr: string): Promise<T> {
    if (expr === PAGE_SCRIPTS.state) return this.state as T;
    if (expr === PAGE_SCRIPTS.scroll) {
      this.scrolls += 1;
      this.script.onScroll?.(this.control, this.scrolls);
      return true as T;
    }
    if (expr === PAGE_SCRIPTS.feedLinks) return (this.script.links ?? []) as T;
    if (expr === PAGE_SCRIPTS.acceptConsent) return false as T;
    throw new Error(`unexpected page script: ${expr.slice(0, 60)}`);
  }

  async url(): Promise<string> {
    return this.currentUrl;
  }

  async setCookie(name: string, value: string, domain: string): Promise<void> {
    this.cookies.push({ name, value, domain });
  }

  onNetwork(h: NetworkHandlers): () => void {
    this.handlers = h;
    return () => {
      this.handlers = undefined;
    };
  }

  async responseBody(id: string): Promise<string> {
    return this.bodies.get(id) ?? "";
  }
}

describe("searchUrl", () => {
  it("builds the Maps search URL with language and country", () => {
    expect(searchUrl("souvenir shop", 2.3293744, 102.2880962, "en", "MY")).toBe(
      "https://www.google.com/maps/search/souvenir%20shop/@2.3293744,102.2880962,15z?hl=en&gl=MY",
    );
  });
});

describe("mapsQuery", () => {
  it("names the place in the query when one is given, so Google reads it", () => {
    expect(mapsQuery("hotel", "George Town, Penang, Malaysia")).toBe("hotel in George Town, Penang, Malaysia");
    expect(searchUrl(mapsQuery("hotel", "Ipoh"), 4.6, 101.1, "en", "MY")).toBe("https://www.google.com/maps/search/hotel%20in%20Ipoh/@4.6,101.1,15z?hl=en&gl=MY");
  });

  it("keeps the keyword alone without a place", () => {
    expect(mapsQuery("hotel")).toBe("hotel");
    expect(mapsQuery("hotel", "  ")).toBe("hotel");
  });
});

describe("collectPlaces", () => {
  it("pre-sets both consent cookies on .google.com", async () => {
    const page = new FakePage({ onNavigate: (c) => c.batch(batchOf(1)), state: { end: true } });
    await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(page.cookies).toEqual([
      { name: "CONSENT", value: CONSENT_COOKIES.CONSENT, domain: ".google.com" },
      { name: "SOCS", value: CONSENT_COOKIES.SOCS, domain: ".google.com" },
    ]);
    expect(CONSENT_COOKIES.CONSENT).toBe("YES+cb.20210720-07-p0.en+FX+410");
    expect(CONSENT_COOKIES.SOCS).toBe("CAISHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiAo_CmBg");
  });

  it("reads three batches until the end-of-list marker", async () => {
    const progress: { places: number; batches: number; found?: unknown[] }[] = [];
    const page = new FakePage({
      onNavigate: (c) => c.batch(batchOf(1)),
      onScroll: (c, n) => {
        if (n === 1) c.batch(batchOf(2));
        if (n === 2) {
          c.batch(batchOf(3));
          c.setState({ end: true });
        }
      },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, (p) => progress.push(p), { timing: FAST });
    expect(result.reason).toBe("end-of-list");
    expect(result.places).toHaveLength(60);
    expect(result.stats.batches).toBe(3);
    expect(progress.at(-1)).toMatchObject({ places: 60, batches: 3 });
    // Each batch reports only the places it added, and together they are the result.
    expect(progress.flatMap((p) => p.found ?? [])).toEqual(result.places);
  });

  it("stops at the requested depth in batches", async () => {
    const page = new FakePage({
      onNavigate: (c) => c.batch(batchOf(1)),
      onScroll: (c, n) => c.batch(batchOf(n + 1)),
    });
    const result = await collectPlaces(page, SEARCH, 2, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("depth");
    expect(result.places).toHaveLength(40);
  });

  it("ends as blocked on a 429 batch and keeps the places already read", async () => {
    const page = new FakePage({
      onNavigate: (c) => c.batch(batchOf(1)),
      onScroll: (c, n) => {
        if (n === 1) c.batch("", { status: 429 });
      },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("blocked");
    expect(result.places).toHaveLength(20);
    expect(result.places[0]?.title).toBe("Test Shop 1-0");
  });

  it("ends as blocked when a batch fails and the page moved to /sorry/", async () => {
    const page = new FakePage({
      onNavigate: (c) => c.batch(batchOf(1)),
      onScroll: (c, n) => {
        if (n === 1) {
          c.fail();
          c.setUrl("https://www.google.com/sorry/index?continue=x");
          c.setState({ feed: false });
        }
      },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("blocked");
    expect(result.places).toHaveLength(20);
  });

  it("ends as blocked when the page shows the unusual-traffic notice", async () => {
    const page = new FakePage({
      onNavigate: (c) => c.setState({ feed: false, unusual: true }),
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("blocked");
    expect(result.places).toEqual([]);
  });

  it("returns one place with a cid when the query resolves to a single place", async () => {
    const placeUrl =
      "https://www.google.com/maps/place/Test+Shop+Single/@2.1,102.2,17z/data=!3m1!4b1!4m6!3m5!1s0x31d1:0xff!8m2!3d2.1001!4d102.2002!16s%2Fg%2Fx!19sChIJtestPlaceId?hl=en";
    const page = new FakePage({
      onNavigate: (c) => {
        c.setUrl(placeUrl);
        c.setState({ feed: false });
      },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("single");
    expect(result.places).toHaveLength(1);
    expect(result.places[0]).toMatchObject({
      title: "Test Shop Single",
      data_id: "0x31d1:0xff",
      cid: "255",
      place_id: "ChIJtestPlaceId",
      latitude: 2.1001,
      longitude: 102.2002,
      link: placeUrl,
    });
  });

  it("waits for the place URL when an entry-less batch arrives first", async () => {
    // Live shape: Google answers one batch with no list entries, then switches the URL seconds later.
    const placeUrl = "https://www.google.com/maps/place/Test+Shop+Late/@2.1,102.2,15z/data=!4m6!3m5!1s0x1:0xabc!8m2!3d2.1!4d102.2";
    const page = new FakePage({
      state: { feed: false },
      onNavigate: (c) => {
        c.batch(makeBatch([]));
        setTimeout(() => c.setUrl(placeUrl), 100);
      },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("single");
    expect(result.places).toEqual([
      expect.objectContaining({ title: "Test Shop Late", data_id: "0x1:0xabc", cid: "2748", link: placeUrl }),
    ]);
  });

  it("reports no-feed when there is neither a result list nor a place", async () => {
    const page = new FakePage({ state: { feed: false } });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("no-feed");
    expect(result.places).toEqual([]);
  });

  it("keeps scrolling while the list renders more of a batch without a request", async () => {
    const page = new FakePage({
      onNavigate: (c) => c.batch(batchOf(1)),
      onScroll: (c, n) => {
        // Google renders a batch's places a few at a time; only the 4th scroll asks for more.
        if (n <= 3) c.setState({ height: 1000 + n * 800 });
        if (n === 4) {
          c.batch(batchOf(2));
          c.setState({ end: true });
        }
      },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("end-of-list");
    expect(result.places).toHaveLength(40);
    expect(page.scrolls).toBe(4);
  });

  it("ends the list after two scrolls that send no request", async () => {
    const page = new FakePage({ onNavigate: (c) => c.batch(batchOf(1)) });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("end-of-list");
    expect(page.scrolls).toBe(2);
    expect(result.places).toHaveLength(20);
  });

  it("stops with no-growth after two answered scrolls that add nothing new", async () => {
    const page = new FakePage({
      onNavigate: (c) => c.batch(batchOf(1)),
      onScroll: (c) => c.batch(batchOf(1)),
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("no-growth");
    expect(result.places).toHaveLength(20);
    expect(page.scrolls).toBe(2);
  });

  it("dedupes places repeated across batches", async () => {
    const page = new FakePage({
      onNavigate: (c) => c.batch(batchOf(1)),
      onScroll: (c, n) => {
        if (n === 1) {
          c.batch(makeBatch([{ title: "Test Shop 1-0 again", data_id: "0x1:0x64" }, { title: "Test Shop New", data_id: "0x1:0x999" }]));
          c.setState({ end: true });
        }
      },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.places).toHaveLength(21);
    expect(result.places.filter((p) => p.data_id === "0x1:0x64")).toHaveLength(1);
  });

  it("counts a redirected batch request once", async () => {
    const page = new FakePage({
      onNavigate: (c) => c.batch(batchOf(1), { redirect: true }),
      onScroll: (c, n) => {
        if (n === 1) {
          c.batch(batchOf(2), { redirect: true });
          c.setState({ end: true });
        }
      },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("end-of-list");
    expect(result.stats.batches).toBe(2);
    expect(result.places).toHaveLength(40);
  });

  it("falls back to the feed's place links when no batch held places", async () => {
    const page = new FakePage({
      links: [
        { href: "https://www.google.com/maps/place/Test+Shop+A/data=!4m7!3m6!1s0x1:0xa!8m2!3d2.1!4d102.1", label: "Test Shop A" },
        { href: "https://www.google.com/maps/place/Test+Shop+B/data=!4m7!3m6!1s0x1:0xb!8m2!3d2.2!4d102.2", label: "Test Shop B" },
      ],
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("dom-fallback");
    expect(result.places.map((p) => p.title)).toEqual(["Test Shop A", "Test Shop B"]);
    expect(result.places[0]?.cid).toBe("10");
    expect(result.places[0]?.plus_code).toBe("6PJ44422+22");
  });

  it("stops with timeout when the time limit runs out", async () => {
    const page = new FakePage({
      onNavigate: (c) => c.batch(batchOf(1)),
      onScroll: (c, n) => c.batch(batchOf(n + 1)),
    });
    const result = await collectPlaces(page, SEARCH, 1000, 0.2, () => {}, { timing: FAST });
    expect(result.reason).toBe("timeout");
    expect(result.places.length).toBeGreaterThanOrEqual(20);
  });

  it("ends as blocked when the page stays on Google's consent wall", async () => {
    const page = new FakePage({
      onNavigate: (c) => {
        c.setUrl("https://consent.google.com/m?continue=https://www.google.com/maps");
        c.setState({ feed: false });
      },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("blocked");
    expect(result.places).toEqual([]);
  });

  it("ends as blocked when Google returns names-only results with no contact details or address", async () => {
    const page = new FakePage({
      onNavigate: (c) =>
        c.batch(makeBatch([{ title: "Name Only 1", place_id: "P1" }, { title: "Name Only 2", place_id: "P2" }])),
      state: { end: true },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.reason).toBe("blocked");
    expect(result.places).toHaveLength(2);
  });

  it("counts places read without a review count as limited", async () => {
    const page = new FakePage({
      onNavigate: (c) =>
        c.batch(makeBatch([{ title: "Test Shop Full", review_rating: 4.5, review_count: 12 }, { title: "Test Shop Limited", review_rating: 4.1 }])),
      state: { end: true },
    });
    const result = await collectPlaces(page, SEARCH, 10, 30, () => {}, { timing: FAST });
    expect(result.stats.limited).toBe(1);
  });
});
