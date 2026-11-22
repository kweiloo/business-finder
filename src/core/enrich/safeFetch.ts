// Fetches business websites without letting a listing point the crawler at a
// private network. Every hop (first request, redirects, robots.txt) resolves
// the host, refuses the hop if any address is not public, then connects to
// the exact address that was checked so a second DNS answer cannot swap it.

import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { USER_AGENT } from "../../version.js";
import { NO_DEBUG_LOG, type DebugLog } from "../debugLog.js";

export { USER_AGENT };
const MAX_REDIRECTS = 5;
/**
 * How much of a robots.txt is parsed. RFC 9309 section 2.5 asks crawlers to
 * parse at least 500 KiB; anything after that is ignored, not refused.
 */
export const ROBOTS_PARSE_BYTES = 500 * 1024;

/**
 * Why a fetch failed. Every reason means the same thing to a lead: the site
 * could not be read (`website_status: "site_unreachable"`); the split exists
 * for logs and tests.
 */
export type FetchFailure =
  | "private_address"
  | "timeout"
  | "http_error"
  | "too_large"
  | "not_html"
  | "robots_disallowed"
  | "invalid_url"
  | "dns_failed"
  | "network_error"
  | "too_many_redirects";

export type FetchResult = { ok: true; finalUrl: string; html: string } | { ok: false; reason: FetchFailure };

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type TransportResponse = {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Releases the connection when the body is not read to the end. */
  close?: () => void;
};

/** Sends one GET to `url` over a connection to `address`; never follows redirects. */
export type Transport = (
  url: URL,
  address: ResolvedAddress,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<TransportResponse>;

type RobotsRule = { allow: boolean; pattern: string };
/** `refused` set: the site cannot be fetched at all, for that reason. */
type RobotsRules = { rules: RobotsRule[]; refused?: FetchFailure };
/** robots.txt rules per origin, shared by every fetch in one run. */
export type RobotsCache = Map<string, Promise<RobotsRules>>;

export type SafeFetchOptions = {
  /** Limit for one hop: DNS, connect, headers and body together. */
  timeoutMs: number;
  /** Largest body accepted after decompression. */
  maxBytes: number;
  /** Resolves a host name to its addresses. Defaults to the system resolver. */
  lookup?: (host: string) => Promise<string[]>;
  transport?: Transport;
  /** Without a cache, robots.txt is read again on every call. */
  robots?: RobotsCache;
  /**
   * Spaces requests to one host. Without one, every call shares a pacer for
   * the whole process, so no caller can exceed one request per second per host.
   */
  pacer?: Pick<HostPacer, "wait">;
  /** Stops the request like a timeout, e.g. when the user cancels the run. */
  signal?: AbortSignal;
  /** Logs each request and each decompress before and after; hosts and paths go to this log only. */
  debug?: DebugLog;
};

export type SiteFetcher = (url: string, opts: SafeFetchOptions) => Promise<FetchResult>;

// ---------------------------------------------------------------------------
// Address checks

function parseIPv4(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split(".").map(Number);
}

/** 16 bytes, or null. Accepts `::` shorthand, an IPv4 tail and a `%zone`. */
function parseIPv6(input: string): number[] | null {
  const ip = input.split("%")[0]!;
  if (isIP(ip) !== 6) return null;
  let text = ip;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const v4 = parseIPv4(text.slice(lastColon + 1));
  if (v4) {
    tail.push(...v4);
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const [head = "", rest] = text.split("::");
  const groups = (s: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const left = groups(head);
  const right = rest === undefined ? [] : groups(rest);
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const words = [...left, ...Array<number>(fill).fill(0), ...right];
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
  const bytes = words.flatMap((w) => [w >> 8, w & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function isPublicIPv4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay anycast
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicIPv6(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicIPv4(b.slice(12)); // IPv4-mapped
  if (zero(0, 12)) return false; // unspecified, loopback, IPv4-compatible
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) return false; // IPv4-translated ::ffff:0:0/96
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) {
    return isPublicIPv4(b.slice(12)); // NAT64
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) {
    return false; // local-use NAT64 64:ff9b:1::/48
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isPublicIPv4(b.slice(2, 6)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // documentation
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return false; // discard prefix
  if ((b[0]! & 0xfe) === 0xfc) return false; // unique local fc00::/7
  if (b[0] === 0xfe && b[1]! >= 0x80) return false; // link-local fe80::/10, site-local fec0::/10
  if (b[0] === 0xff) return false; // multicast
  return true;
}

/** True only for a literal IPv4 or IPv6 address that is routable on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6(ip);
  return v6 ? isPublicIPv6(v6) : false;
}

async function systemLookup(host: string): Promise<string[]> {
  const results = await dnsLookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

type Resolved = { ok: true; address: ResolvedAddress } | { ok: false; reason: "private_address" | "dns_failed" };

async function resolvePublic(hostname: string, lookup: (host: string) => Promise<string[]>): Promise<Resolved> {
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(host)) {
    return isPublicAddress(host)
      ? { ok: true, address: { address: host, family: isIP(host) as 4 | 6 } }
      : { ok: false, reason: "private_address" };
  }
  let addresses: unknown;
  try {
    addresses = await lookup(host);
  } catch {
    return { ok: false, reason: "dns_failed" };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, reason: "dns_failed" };
  if (!addresses.every((a) => typeof a === "string" && isPublicAddress(a))) return { ok: false, reason: "private_address" };
  const address = addresses[0] as string;
  return { ok: true, address: { address, family: isIP(address) as 4 | 6 } };
}

// ---------------------------------------------------------------------------
// Pacing

/** Keeps request starts to one host at least `intervalMs` apart (default 1 s). */
export class HostPacer {
  private readonly next = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: { intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Resolves when a request to `host` may start. The slot is reserved synchronously. */
  async wait(host: string): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, slot + this.intervalMs);
    if (slot > now) await this.sleep(slot - now);
  }
}

/**
 * The pacer every fetch in this process uses unless a caller passes its own,
 * so one request per second per host holds across runs that overlap.
 * Separate processes (a CLI scrape next to `serve`) each have their own.
 */
export const SHARED_HOST_PACER = new HostPacer();

// ---------------------------------------------------------------------------
// Transport

function pinnedLookup(address: ResolvedAddress): LookupFunction {
  return ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  }) as unknown as LookupFunction;
}

/** Plain `node:http`/`node:https`; works on Node and Bun, which both honour `lookup`. */
export const nodeTransport: Transport = (url, address, { headers, signal }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      { method: "GET", headers, signal, agent: false, lookup: pinnedLookup(address) },
      (res) => {
        const flat: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        }
        res.on("error", () => {}); // surfaced through the body iterator
        resolve({ status: res.statusCode ?? 0, headers: flat, body: res, close: () => res.destroy() });
      },
    );
    req.on("error", reject);
    req.end();
  });

// ---------------------------------------------------------------------------
// Fetch

class Failure extends Error {
  readonly reason: FetchFailure;

  constructor(reason: FetchFailure) {
    super(reason);
    this.reason = reason;
  }
}

function parseHttpUrl(input: string, base?: URL): URL | null {
  let url: URL;
  try {
    url = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  url.hash = "";
  return url;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Failure("timeout"));
      return;
    }
    const onAbort = () => reject(new Failure("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** What to do with a body over its limit: refuse it, or keep the first `limit` bytes. */
type Overflow = "fail" | "truncate";
type Body = { bytes: Uint8Array; truncated: boolean };

async function readAll(body: AsyncIterable<Uint8Array>, limit: number, signal: AbortSignal, overflow: Overflow): Promise<Body> {
  const iterator = body[Symbol.asyncIterator]();
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      let step: IteratorResult<Uint8Array>;
      try {
        step = await raceAbort(iterator.next(), signal);
      } catch (error) {
        throw error instanceof Failure ? error : new Failure(signal.aborted ? "timeout" : "network_error");
      }
      if (step.done) break;
      const chunk = step.value instanceof Uint8Array ? step.value : new TextEncoder().encode(String(step.value));
      if (size + chunk.byteLength > limit) {
        if (overflow === "fail") throw new Failure("too_large");
        parts.push(chunk.subarray(0, limit - size));
        size = limit;
        truncated = true;
        break;
      }
      size += chunk.byteLength;
      parts.push(chunk);
    }
  } finally {
    iterator.return?.()?.catch?.(() => {});
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes: out, truncated };
}

async function decompress(bytes: Uint8Array, encoding: string, limit: number, signal: AbortSignal, overflow: Overflow): Promise<Body> {
  const stream =
    encoding === "gzip" || encoding === "x-gzip" ? createGunzip()
    : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress()
    : null;
  if (!stream) throw new Failure("http_error");
  stream.end(bytes);
  try {
    return await readAll(stream, limit, signal, overflow);
  } finally {
    stream.destroy();
  }
}

function decode(bytes: Uint8Array, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

type Hop = { status: number; headers: Record<string, string | undefined>; bytes?: Uint8Array; truncated?: boolean };

/**
 * One request: pace, resolve and check the host, connect to the checked
 * address, and read the body when `read` says so. Never follows redirects.
 */
async function requestOnce(
  url: URL,
  opts: SafeFetchOptions,
  accept: string,
  read: (status: number, headers: Record<string, string | undefined>) => number | null,
  overflow: Overflow,
): Promise<Hop> {
  // A cancelled run must not queue behind the host pacer for every page left.
  const stopIfCancelled = () => {
    if (opts.signal?.aborted) throw new Failure("timeout");
  };
  stopIfCancelled();
  await (opts.pacer ?? SHARED_HOST_PACER).wait(url.hostname);
  stopIfCancelled();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  timer.unref?.();
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
  const debug = opts.debug ?? NO_DEBUG_LOG;
  const where = { host: url.host, path: url.pathname + url.search };
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  debug("hop_start", where);
  let outcome: Record<string, string | number> = { result: "error" };
  try {
    const resolved = await raceAbort(resolvePublic(url.hostname, opts.lookup ?? systemLookup), signal);
    if (!resolved.ok) throw new Failure(resolved.reason);
    const headers = {
      "user-agent": USER_AGENT,
      accept,
      "accept-encoding": "gzip, deflate, br",
    };
    let res: TransportResponse;
    try {
      res = await raceAbort((opts.transport ?? nodeTransport)(url, resolved.address, { headers, signal }), signal);
    } catch (error) {
      throw error instanceof Failure ? error : new Failure(signal.aborted ? "timeout" : "network_error");
    }
    try {
      const limit = read(res.status, res.headers);
      const encoding = (res.headers["content-encoding"] ?? "").trim().toLowerCase();
      outcome = { status: res.status, encoding: encoding || "none" };
      if (limit === null) return { status: res.status, headers: res.headers };
      const compressed = encoding !== "" && encoding !== "identity";
      // A cut compressed stream cannot be decoded, so a compressed body is never truncated raw.
      let body = await readAll(res.body, limit, signal, compressed ? "fail" : overflow);
      outcome.bytes = body.bytes.byteLength;
      if (compressed) {
        const t = performance.now();
        debug("decompress_start", { ...where, encoding, bytes: body.bytes.byteLength });
        try {
          body = await decompress(body.bytes, encoding, limit, signal, overflow);
        } catch (error) {
          debug("decompress_done", { ...where, encoding, result: "error", ms: Math.round(performance.now() - t) });
          throw error instanceof Failure && error.reason !== "network_error" ? error : new Failure("network_error");
        }
        debug("decompress_done", { ...where, encoding, bytes: body.bytes.byteLength, ms: Math.round(performance.now() - t) });
      }
      return { status: res.status, headers: res.headers, bytes: body.bytes, truncated: body.truncated };
    } finally {
      res.close?.();
    }
  } catch (error) {
    outcome = { ...outcome, result: error instanceof Failure ? error.reason : "network_error" };
    throw error;
  } finally {
    clearTimeout(timer);
    debug("hop_done", { ...where, ...outcome, ms: ms() });
  }
}

const isRedirect = (status: number) => [301, 302, 303, 307, 308].includes(status);

/**
 * Follows up to five redirects; each hop goes through `requestOnce` and, if
 * given, `beforeHop`. A body over `maxBytes` fails with `too_large`, or with
 * `overflow: "truncate"` is cut to its first `maxBytes`.
 */
async function follow(
  start: URL,
  opts: SafeFetchOptions,
  accept: string,
  maxBytes: number,
  overflow: Overflow,
  beforeHop?: (url: URL) => Promise<void>,
): Promise<{ url: URL; hop: Hop }> {
  let url = start;
  for (let redirects = 0; ; redirects++) {
    await beforeHop?.(url);
    const hop = await requestOnce(url, opts, accept, (status) => (isRedirect(status) || status < 200 || status >= 300 ? null : maxBytes), overflow);
    if (!isRedirect(hop.status)) return { url, hop };
    if (redirects >= MAX_REDIRECTS) throw new Failure("too_many_redirects");
    const location = hop.headers.location;
    if (!location) throw new Failure("http_error");
    const next = parseHttpUrl(location, url);
    if (!next) throw new Failure("invalid_url");
    url = next;
  }
}

// ---------------------------------------------------------------------------
// robots.txt

function parseRobots(text: string): RobotsRules {
  type Group = { agents: string[]; rules: RobotsRule[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let collectingAgents = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!collectingAgents || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase().split("/")[0]!.trim());
      collectingAgents = true;
    } else if (key === "allow" || key === "disallow") {
      collectingAgents = false;
      if (current && value) current.rules.push({ allow: key === "allow", pattern: value });
    }
  }
  const own = groups.filter((g) => g.agents.includes("business-finder"));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  return { rules: chosen.flatMap((g) => g.rules) };
}

/**
 * robots.txt path matching: `*` is any run of characters, a trailing `$`
 * anchors the end, otherwise the rule is a prefix. Two-pointer glob match, no
 * regex, so a hostile pattern such as `/*a*a*a*b` cannot backtrack for long.
 */
export function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const glob = anchored ? pattern.slice(0, -1) : `${pattern}*`;
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < path.length) {
    if (p < glob.length && glob[p] === "*") {
      star = p++;
      resume = s;
    } else if (p < glob.length && glob[p] === path[s]) {
      p++;
      s++;
    } else if (star >= 0) {
      p = star + 1;
      s = ++resume;
    } else {
      return false;
    }
  }
  while (p < glob.length && glob[p] === "*") p++;
  return p === glob.length;
}

function robotsAllows({ rules }: RobotsRules, url: URL): boolean {
  const path = url.pathname + url.search;
  if (url.pathname === "/robots.txt") return true;
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

const ALLOW_ALL: RobotsRules = { rules: [] };
const DISALLOW_ALL: RobotsRules = { rules: [{ allow: false, pattern: "/" }] };

/** The bytes up to and including the last line break; a cut-off last line is dropped. */
function completeLines(bytes: Uint8Array): Uint8Array {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 0x0a || bytes[i] === 0x0d) return bytes.subarray(0, i + 1);
  }
  return bytes.subarray(0, 0);
}

/**
 * Reads `/robots.txt` for an origin, following RFC 9309 section 2.3.1:
 * - 2xx: parse the rules.
 * - 4xx ("unavailable"), or more than five redirects (which the RFC lets a
 *   crawler treat as unavailable): allow everything.
 * - 5xx, or the file is unreachable (timeout, network error, a compressed
 *   file over the size cap): disallow the whole site.
 * - A file over 500 KiB: parse its first 500 KiB, complete lines only
 *   (section 2.5).
 * - The site's address is refused (it resolves to a private address, or DNS
 *   fails): no page on it is fetched, and the page reports that reason rather
 *   than robots.txt. A DNS failure is not cached, so the next page on that
 *   site tries again.
 */
async function loadRobots(origin: URL, opts: SafeFetchOptions): Promise<RobotsRules> {
  const robotsUrl = new URL("/robots.txt", origin);
  try {
    const { hop } = await follow(robotsUrl, opts, "text/plain, */*;q=0.1", ROBOTS_PARSE_BYTES, "truncate");
    if (hop.status >= 500) return DISALLOW_ALL;
    if (hop.status < 200 || hop.status >= 300 || !hop.bytes) return ALLOW_ALL;
    return parseRobots(new TextDecoder("utf-8").decode(hop.truncated ? completeLines(hop.bytes) : hop.bytes));
  } catch (error) {
    const reason = error instanceof Failure ? error.reason : "network_error";
    if (reason === "too_many_redirects") return ALLOW_ALL;
    if (reason === "private_address" || reason === "dns_failed") return { rules: [], refused: reason };
    return DISALLOW_ALL;
  }
}

async function checkRobots(url: URL, opts: SafeFetchOptions): Promise<void> {
  const cache = opts.robots ?? new Map();
  let rules = cache.get(url.origin);
  if (!rules) {
    rules = loadRobots(url, opts);
    cache.set(url.origin, rules);
  }
  const loaded = await rules;
  if (loaded.refused === "dns_failed" && cache.get(url.origin) === rules) cache.delete(url.origin);
  if (loaded.refused) throw new Failure(loaded.refused);
  if (!robotsAllows(loaded, url)) throw new Failure("robots_disallowed");
}

// ---------------------------------------------------------------------------

const HTML_TYPES = ["text/html", "application/xhtml+xml"];

/**
 * Fetches one public HTML page. Never throws: every problem a website can
 * cause (bad URL, DNS failure, private address, reset, slow or huge body,
 * redirect loop, robots.txt refusal, non-HTML content) becomes `ok: false`.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<FetchResult> {
  try {
    const start = parseHttpUrl(url);
    if (!start) return { ok: false, reason: "invalid_url" };
    const { url: finalUrl, hop } = await follow(
      start,
      opts,
      "text/html, application/xhtml+xml;q=0.9, */*;q=0.1",
      opts.maxBytes,
      "fail",
      (hopUrl) => checkRobots(hopUrl, opts),
    );
    if (hop.status < 200 || hop.status >= 300 || !hop.bytes) return { ok: false, reason: "http_error" };
    const contentType = hop.headers["content-type"] ?? "";
    const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
    if (mediaType && !HTML_TYPES.includes(mediaType)) return { ok: false, reason: "not_html" };
    if (!mediaType && hop.bytes.subarray(0, 1024).includes(0)) return { ok: false, reason: "not_html" };
    return { ok: true, finalUrl: finalUrl.href, html: decode(hop.bytes, contentType) };
  } catch (error) {
    return { ok: false, reason: error instanceof Failure ? error.reason : "network_error" };
  }
}
