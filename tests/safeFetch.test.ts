import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostPacer,
  isPublicAddress,
  nodeTransport,
  ROBOTS_PARSE_BYTES,
  ruleMatches,
  safeFetch,
  type SafeFetchOptions,
  type Transport,
  type TransportResponse,
} from "../src/core/enrich/safeFetch.js";
import { VERSION } from "../src/version.js";

const PUBLIC_IP = "93.184.216.34";

function respond(status: number, headers: Record<string, string> = {}, body: string | Uint8Array = ""): TransportResponse {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    status,
    headers,
    body: (async function* () { yield bytes; })(),
  };
}

const html = (body: string) => respond(200, { "content-type": "text/html; charset=utf-8" }, body);

/** Routes requests by full URL; robots.txt is a 404 unless listed. */
function routes(table: Record<string, () => TransportResponse | Promise<TransportResponse>>) {
  return vi.fn<Transport>(async (url) => {
    const handler = table[url.href];
    if (handler) return handler();
    if (url.pathname === "/robots.txt") return respond(404);
    throw new Error(`unexpected request ${url.href}`);
  });
}

function opts(over: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
  return {
    timeoutMs: 1000,
    maxBytes: 2 * 1024 * 1024,
    lookup: async () => [PUBLIC_IP],
    robots: new Map(),
    // No pacing in unit tests; the fallback pacer has its own test below.
    pacer: { wait: async () => {} },
    ...over,
  };
}

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "127.255.0.9", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1",
    "0.0.0.0", "0.1.2.3", "100.64.0.1", "100.127.255.254", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.5", "64:ff9b::7f00:1", "2002:7f00:1::",
    "::ffff:0:127.0.0.1", "::ffff:0:808:808", "64:ff9b:1::808:808", "64:ff9b:1:ffff::1", "192.88.99.1", "192.88.99.255",
    "not an ip", "", "999.1.1.1",
  ])("refuses %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([PUBLIC_IP, "8.8.8.8", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "192.88.98.1", "192.88.100.1"])(
    "accepts %s", (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    });
});

describe("safeFetch", () => {
  it("fetches a public HTML page with the business-finder user agent, pinned to the checked address", async () => {
    const transport = routes({ "https://shop.test/": () => html("<p>hello</p>") });
    const result = await safeFetch("https://shop.test/", opts({ transport }));
    expect(result).toEqual({ ok: true, finalUrl: "https://shop.test/", html: "<p>hello</p>" });
    const page = transport.mock.calls.find(([url]) => url.pathname === "/")!;
    expect(page[1]).toEqual({ address: PUBLIC_IP, family: 4 });
    expect(page[2].headers["user-agent"]).toBe("business-finder/" + VERSION + " (+https://github.com/kweiloo/business-finder)");
  });

  it("refuses a host that resolves to a loopback address without connecting", async () => {
    const transport = routes({});
    const result = await safeFetch("https://shop.test/", opts({ transport, lookup: async () => ["127.0.0.1"] }));
    expect(result).toEqual({ ok: false, reason: "private_address" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a host when any one of its addresses is not public", async () => {
    const transport = routes({});
    const result = await safeFetch("https://shop.test/", opts({ transport, lookup: async () => [PUBLIC_IP, "10.0.0.5"] }));
    expect(result).toEqual({ ok: false, reason: "private_address" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["http://127.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0x7f.1/"])(
    "refuses the IP literal %s", async (url) => {
      const transport = routes({});
      const lookup = vi.fn(async () => [PUBLIC_IP]);
      expect(await safeFetch(url, opts({ transport, lookup }))).toEqual({ ok: false, reason: "private_address" });
      expect(transport).not.toHaveBeenCalled();
    });

  it("refuses a redirect hop to a private host", async () => {
    const transport = routes({
      "https://shop.test/": () => respond(302, { location: "http://intranet.test/admin" }),
    });
    const lookup = async (host: string) => (host === "intranet.test" ? ["10.0.0.5"] : [PUBLIC_IP]);
    expect(await safeFetch("https://shop.test/", opts({ transport, lookup }))).toEqual({ ok: false, reason: "private_address" });
    expect(transport.mock.calls.map(([url]) => url.hostname)).not.toContain("intranet.test");
  });

  it("refuses a redirect hop to a loopback literal", async () => {
    const transport = routes({ "https://shop.test/": () => respond(301, { location: "http://127.0.0.1:8080/" }) });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "private_address" });
  });

  it("follows a relative redirect and reports the final URL", async () => {
    const transport = routes({
      "https://shop.test/": () => respond(302, { location: "/home" }),
      "https://shop.test/home": () => html("home"),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: true, finalUrl: "https://shop.test/home", html: "home" });
  });

  it("stops after five redirects", async () => {
    const transport = routes({
      "https://shop.test/": () => respond(302, { location: "/a" }),
      "https://shop.test/a": () => respond(302, { location: "/" }),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "too_many_redirects" });
    expect(transport.mock.calls.filter(([url]) => url.pathname !== "/robots.txt")).toHaveLength(6);
  });

  it("treats an invalid or non-http redirect target as an invalid URL", async () => {
    for (const location of ["http://[broken", "file:///etc/passwd", "javascript:alert(1)"]) {
      const transport = routes({ "https://shop.test/": () => respond(302, { location }) });
      expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "invalid_url" });
    }
  });

  it("treats a redirect without a Location header as an HTTP error", async () => {
    const transport = routes({ "https://shop.test/": () => respond(302) });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "http_error" });
  });

  it.each(["not a url", "ftp://shop.test/", "", "https://"])("rejects the URL %j", async (url) => {
    expect(await safeFetch(url, opts({ transport: routes({}) }))).toEqual({ ok: false, reason: "invalid_url" });
  });

  it("refuses a page that robots.txt disallows for every agent", async () => {
    const transport = routes({
      "https://shop.test/robots.txt": () => respond(200, { "content-type": "text/plain" }, "User-agent: *\nDisallow: /\n"),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "robots_disallowed" });
  });

  it("honours a business-finder group over the * group", async () => {
    const robots = "User-agent: *\nDisallow: /\n\nUser-agent: Business-Finder\nDisallow: /private\n";
    const transport = routes({
      "https://shop.test/robots.txt": () => respond(200, {}, robots),
      "https://shop.test/": () => html("ok"),
    });
    const cache = new Map();
    expect(await safeFetch("https://shop.test/", opts({ transport, robots: cache }))).toMatchObject({ ok: true });
    expect(await safeFetch("https://shop.test/private/x", opts({ transport, robots: cache })))
      .toEqual({ ok: false, reason: "robots_disallowed" });
  });

  it("lets a longer Allow rule win over a shorter Disallow", async () => {
    const transport = routes({
      "https://shop.test/robots.txt": () => respond(200, {}, "User-agent: *\nDisallow: /\nAllow: /contact\n"),
      "https://shop.test/contact": () => html("contact"),
    });
    expect(await safeFetch("https://shop.test/contact", opts({ transport }))).toMatchObject({ ok: true });
  });

  it("reads robots.txt once per host for the run", async () => {
    const transport = routes({
      "https://shop.test/": () => html("a"),
      "https://shop.test/contact": () => html("b"),
    });
    const cache = new Map();
    await safeFetch("https://shop.test/", opts({ transport, robots: cache }));
    await safeFetch("https://shop.test/contact", opts({ transport, robots: cache }));
    expect(transport.mock.calls.filter(([url]) => url.pathname === "/robots.txt")).toHaveLength(1);
  });

  it("ignores a missing or garbled robots.txt", async () => {
    for (const robots of [() => respond(404), () => respond(200, {}, new Uint8Array([0, 255, 254, 10, 68, 105, 115]))]) {
      const transport = routes({
        "https://shop.test/robots.txt": robots,
        "https://shop.test/": () => html("ok"),
      });
      expect(await safeFetch("https://shop.test/", opts({ transport }))).toMatchObject({ ok: true });
    }
  });

  it("treats a robots.txt server error as disallowing the site", async () => {
    const transport = routes({ "https://shop.test/robots.txt": () => respond(503) });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "robots_disallowed" });
  });

  it("treats a robots.txt that cannot be reached as disallowing the site (RFC 9309)", async () => {
    const reset = () => Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    for (const [robots, timeoutMs] of [[reset, 1000], [() => new Promise<never>(() => {}), 30]] as const) {
      const transport = routes({
        "https://shop.test/robots.txt": robots,
        "https://shop.test/": () => html("ok"),
      });
      expect(await safeFetch("https://shop.test/", opts({ transport, timeoutMs }))).toEqual({ ok: false, reason: "robots_disallowed" });
      expect(transport.mock.calls.map(([url]) => url.pathname)).toEqual(["/robots.txt"]);
    }
  });

  it("fetches no page when the robots.txt lookup fails, and reports the DNS failure", async () => {
    let calls = 0;
    const lookup = async () => {
      if (calls++ === 0) throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
      return [PUBLIC_IP];
    };
    const transport = routes({ "https://shop.test/": () => html("ok") });
    expect(await safeFetch("https://shop.test/", opts({ transport, lookup }))).toEqual({ ok: false, reason: "dns_failed" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("fetches no page when robots.txt redirects to a private host", async () => {
    const transport = routes({
      "https://shop.test/robots.txt": () => respond(302, { location: "http://10.0.0.5/robots.txt" }),
      "https://shop.test/": () => html("ok"),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "private_address" });
    expect(transport.mock.calls.map(([url]) => url.pathname)).toEqual(["/robots.txt"]);
  });

  it("treats a robots.txt redirect loop as no robots.txt", async () => {
    const transport = routes({
      "https://shop.test/robots.txt": () => respond(302, { location: "/robots.txt?again" }),
      "https://shop.test/robots.txt?again": () => respond(302, { location: "/robots.txt" }),
      "https://shop.test/": () => html("ok"),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toMatchObject({ ok: true });
  });

  it("tries robots.txt again on the next page after a DNS failure", async () => {
    let calls = 0;
    const lookup = async () => {
      if (calls++ === 0) throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
      return [PUBLIC_IP];
    };
    const transport = routes({ "https://shop.test/": () => html("ok") });
    const cache = new Map();
    expect(await safeFetch("https://shop.test/", opts({ transport, lookup, robots: cache }))).toEqual({ ok: false, reason: "dns_failed" });
    expect(await safeFetch("https://shop.test/", opts({ transport, lookup, robots: cache }))).toMatchObject({ ok: true });
  });

  it("keeps a private-address refusal for the rest of the run", async () => {
    let calls = 0;
    const lookup = async () => (calls++ === 0 ? ["10.0.0.5"] : [PUBLIC_IP]);
    const transport = routes({ "https://shop.test/": () => html("ok") });
    const cache = new Map();
    expect(await safeFetch("https://shop.test/", opts({ transport, lookup, robots: cache }))).toEqual({ ok: false, reason: "private_address" });
    expect(await safeFetch("https://shop.test/", opts({ transport, lookup, robots: cache }))).toEqual({ ok: false, reason: "private_address" });
  });

  it("parses the first 500 KiB of an oversize robots.txt", async () => {
    const head = "User-agent: *\nDisallow: /private\n";
    const robots = head + "# filler line for size\n".repeat(Math.ceil((600 * 1024) / 23));
    expect(robots.length).toBeGreaterThan(ROBOTS_PARSE_BYTES);
    const transport = routes({
      "https://shop.test/robots.txt": () => respond(200, { "content-type": "text/plain" }, robots),
      "https://shop.test/": () => html("ok"),
    });
    const cache = new Map();
    expect(await safeFetch("https://shop.test/", opts({ transport, robots: cache }))).toMatchObject({ ok: true });
    expect(await safeFetch("https://shop.test/private/x", opts({ transport, robots: cache })))
      .toEqual({ ok: false, reason: "robots_disallowed" });
  });

  it("ignores the partial last line of a robots.txt cut at 500 KiB", async () => {
    // The cut lands inside "Disallow: /private", leaving "Disallow: /pr".
    const cut = "Disallow: /pr";
    const head = "User-agent: *\n" + "# filler\n".repeat(Math.floor((ROBOTS_PARSE_BYTES - 200) / 9));
    const pad = "#".repeat(ROBOTS_PARSE_BYTES - head.length - cut.length - 1) + "\n";
    const robots = head + pad + "Disallow: /private\n" + "# tail\n".repeat(100);
    expect((head + pad + cut).length).toBe(ROBOTS_PARSE_BYTES);
    const transport = routes({
      "https://shop.test/robots.txt": () => respond(200, {}, robots),
      "https://shop.test/promo": () => html("ok"),
    });
    expect(await safeFetch("https://shop.test/promo", opts({ transport }))).toMatchObject({ ok: true });
  });

  it("parses the first 500 KiB of an oversize gzip robots.txt", async () => {
    const robots = "User-agent: *\nDisallow: /private\n" + "# filler line for size\n".repeat(30_000);
    const transport = routes({
      "https://shop.test/robots.txt": () => respond(200, { "content-encoding": "gzip" }, gzipSync(robots)),
      "https://shop.test/": () => html("ok"),
      "https://shop.test/private/x": () => html("no"),
    });
    const cache = new Map();
    expect(await safeFetch("https://shop.test/", opts({ transport, robots: cache }))).toMatchObject({ ok: true });
    expect(await safeFetch("https://shop.test/private/x", opts({ transport, robots: cache })))
      .toEqual({ ok: false, reason: "robots_disallowed" });
  });

  it("disallows the site when a gzip robots.txt is over 500 KiB on the wire", async () => {
    // Hex noise barely compresses, so the gzip body itself exceeds the cap.
    // A cut gzip stream cannot be decoded reliably, so it must end as too_large
    // (disallow all) instead of being cut raw and parsed from its first part.
    const lines = randomBytes(640 * 1024).toString("hex").match(/.{1,64}/g)!.map((hex) => `# ${hex}`);
    const wire = gzipSync("User-agent: *\nAllow: /\n" + lines.join("\n") + "\n");
    expect(wire.byteLength).toBeGreaterThan(ROBOTS_PARSE_BYTES);
    const transport = routes({
      "https://shop.test/robots.txt": () => respond(200, { "content-encoding": "gzip" }, wire),
      "https://shop.test/": () => html("ok"),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "robots_disallowed" });
    expect(transport.mock.calls.map(([url]) => url.pathname)).toEqual(["/robots.txt"]);
  });

  it("caps the body size", async () => {
    const transport = routes({ "https://shop.test/": () => html("x".repeat(2048)) });
    expect(await safeFetch("https://shop.test/", opts({ transport, maxBytes: 1024 }))).toEqual({ ok: false, reason: "too_large" });
  });

  it("caps the decompressed size of a gzip body", async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024, 0x61));
    const transport = routes({
      "https://shop.test/": () => respond(200, { "content-type": "text/html", "content-encoding": "gzip" }, bomb),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport, maxBytes: 1024 }))).toEqual({ ok: false, reason: "too_large" });
  });

  it("decompresses a gzip body", async () => {
    const transport = routes({
      "https://shop.test/": () => respond(200, { "content-type": "text/html", "content-encoding": "gzip" }, gzipSync("<p>zipped</p>")),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toMatchObject({ ok: true, html: "<p>zipped</p>" });
  });

  it("reports a corrupt compressed body as a network error", async () => {
    const transport = routes({
      "https://shop.test/": () => respond(200, { "content-type": "text/html", "content-encoding": "gzip" }, "not gzip"),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "network_error" });
  });

  it("refuses non-HTML content", async () => {
    const transport = routes({ "https://shop.test/": () => respond(200, { "content-type": "image/png" }, "\u0089PNG") });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "not_html" });
  });

  it("refuses a binary body that has no content type", async () => {
    const transport = routes({ "https://shop.test/": () => respond(200, {}, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1])) });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "not_html" });
  });

  it("decodes the declared charset and falls back to UTF-8 for an unknown one", async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    let transport = routes({ "https://shop.test/": () => respond(200, { "content-type": "text/html; charset=windows-1252" }, latin1) });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toMatchObject({ html: "café" });
    transport = routes({ "https://shop.test/": () => respond(200, { "content-type": "text/html; charset=bogus-9" }, "café") });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toMatchObject({ html: "café" });
  });

  it("reports HTTP error statuses", async () => {
    const transport = routes({ "https://shop.test/": () => respond(500, { "content-type": "text/html" }, "oops") });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "http_error" });
  });

  it("times out a server that never answers", async () => {
    const transport = routes({
      "https://shop.test/": () => new Promise<never>(() => {}),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport, timeoutMs: 30 }))).toEqual({ ok: false, reason: "timeout" });
  });

  it("times out a body that trickles forever", async () => {
    const transport = routes({
      "https://shop.test/": () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: (async function* () {
          for (;;) {
            yield new Uint8Array([0x61]);
            await new Promise((r) => setTimeout(r, 5));
          }
        })(),
      }),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport, timeoutMs: 40 }))).toEqual({ ok: false, reason: "timeout" });
  });

  it("reports a connection reset as a network error", async () => {
    const transport = routes({
      "https://shop.test/": () => Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "network_error" });
  });

  it("reports a body stream that errors midway as a network error", async () => {
    const transport = routes({
      "https://shop.test/": () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: (async function* () {
          yield new Uint8Array([0x61]);
          throw new Error("aborted");
        })(),
      }),
    });
    expect(await safeFetch("https://shop.test/", opts({ transport }))).toEqual({ ok: false, reason: "network_error" });
  });

  it("reports a DNS failure", async () => {
    const lookup = async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); };
    expect(await safeFetch("https://shop.test/", opts({ transport: routes({}), lookup }))).toEqual({ ok: false, reason: "dns_failed" });
    expect(await safeFetch("https://shop.test/", opts({ transport: routes({}), lookup: async () => [] })))
      .toEqual({ ok: false, reason: "dns_failed" });
  });

  it("waits for the host pacer before every request", async () => {
    const pacer = { wait: vi.fn(async () => {}) };
    const transport = routes({ "https://shop.test/": () => html("ok") });
    await safeFetch("https://shop.test/", opts({ transport, pacer }));
    expect(pacer.wait.mock.calls).toEqual([["shop.test"], ["shop.test"]]);
  });
});

describe("safeFetch pacing without a pacer", () => {
  it("still keeps requests to one host at least a second apart", async () => {
    const starts: number[] = [];
    const transport = vi.fn<Transport>(async (url) => {
      starts.push(performance.now());
      return url.pathname === "/robots.txt" ? respond(404) : html("ok");
    });
    const { pacer: _unused, ...unpaced } = opts({ transport });
    const result = await safeFetch("https://unpaced.test/", unpaced);
    expect(result).toMatchObject({ ok: true });
    expect(starts).toHaveLength(2);
    // Timers may fire a millisecond early; 950 ms still proves pacing happened.
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(950);
  }, 5000);
});

describe("nodeTransport", () => {
  let server: http.Server;
  let port: number;
  let hits: number;

  beforeEach(async () => {
    hits = 0;
    server = http.createServer((_req, res) => {
      hits++;
      res.end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const headers = { "user-agent": "test" };

  it("connects to the checked address, not to what the host name resolves to", async () => {
    // `.test` never resolves, so reaching the server proves the pinned address was used.
    const res = await nodeTransport(new URL(`http://pinned.test:${port}/`), { address: "127.0.0.1", family: 4 }, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    let body = "";
    for await (const chunk of res.body) body += Buffer.from(chunk).toString();
    expect(res.status).toBe(200);
    expect(body).toBe("pinned");
    expect(hits).toBe(1);
  });

  it("never reaches localhost when the checked address is elsewhere", async () => {
    // 192.0.2.1 is TEST-NET-1: nothing answers, so the attempt fails or times out.
    const attempt = nodeTransport(new URL(`http://localhost:${port}/`), { address: "192.0.2.1", family: 4 }, {
      headers,
      signal: AbortSignal.timeout(500),
    });
    await expect(attempt).rejects.toThrow();
    expect(hits).toBe(0);
  });
});

describe("HostPacer", () => {
  it("spaces requests to one host at least a second apart and leaves other hosts alone", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const pacer = new HostPacer({
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    await pacer.wait("a.test");
    await pacer.wait("a.test");
    await pacer.wait("b.test");
    await pacer.wait("a.test");
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("reserves slots in call order when requests to one host start together", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const pacer = new HostPacer({ now: () => now, sleep: async (ms) => { sleeps.push(ms); } });
    await Promise.all([pacer.wait("a.test"), pacer.wait("a.test"), pacer.wait("a.test")]);
    expect(sleeps).toEqual([1000, 2000]);
  });
});

describe("ruleMatches", () => {
  it.each([
    ["/", "/anything", true],
    ["/private", "/private/x", true],
    ["/private", "/public", false],
    ["/*.php$", "/index.php", true],
    ["/*.php$", "/index.php?x=1", false],
    ["/a*b", "/a/c/b/d", true],
    ["/fish$", "/fish", true],
    ["/fish$", "/fishes", false],
    ["/x?y=", "/x?y=1", true],
  ])("%s against %s is %s", (pattern, path, expected) => {
    expect(ruleMatches(pattern, path)).toBe(expected);
  });

  it("stays fast on a pattern built to backtrack", () => {
    const started = performance.now();
    expect(ruleMatches(`/${"*a".repeat(40)}b`, `/${"a".repeat(2000)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("safeFetch cancelled in flight", () => {
  it("stops a request that is waiting on the server as soon as the signal aborts", async () => {
    const controller = new AbortController();
    let connected!: () => void;
    const connecting = new Promise<void>((r) => (connected = r));
    const transport = routes({
      "https://shop.test/": () => (connected(), new Promise<never>(() => {})),
    });
    const run = safeFetch("https://shop.test/", opts({ transport, timeoutMs: 60_000, signal: controller.signal }));
    await connecting;
    const t = performance.now();
    controller.abort();
    expect(await run).toEqual({ ok: false, reason: "timeout" });
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
