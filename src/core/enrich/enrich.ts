// Fills a lead's email and social fields, and a missing phone, from its public
// website and records why each field holds what it does.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { debugLogFromEnv, NO_DEBUG_LOG, type DebugLog } from "../debugLog.js";
import type { FieldStatus, Lead, Source } from "../types.js";
import { toE164, whatsappLink } from "../leads/phone.js";
import { classifyEmail } from "./emailType.js";
import { contactLinks, extractEmails, extractSocials, extractTelLinks, matchesListing, type SocialNetwork, type Socials } from "./extract.js";
import { createMxCache, emailDomain, NOOP_MX_RESOLVER, systemDnsResolver, type EmailMxStatus, type MxResolver } from "./mx.js";
import { SHARED_HOST_PACER, safeFetch, type HostPacer, type RobotsCache, type SafeFetchOptions, type SiteFetcher } from "./safeFetch.js";

export type { MxResolver, SiteFetcher };

export const MAX_CONCURRENT_SITES = 8;
const PAGE_TIMEOUT_MS = 15_000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const NETWORKS: SocialNetwork[] = ["instagram", "facebook", "linkedin", "tiktok", "youtube", "x"];

export type EnrichOptions = {
  emails: boolean;
  socials: boolean;
  /** Also read up to three contact or about pages when the homepage gives nothing. */
  deep: boolean;
  /**
   * ISO 3166-1 alpha-2 country for reading a national number in a `tel:`
   * link. Without it only numbers written with a leading `+` are read.
   */
  country?: string;
  /** Defaults to `safeFetch`; fixture mode passes `fixtureFetcher`. */
  fetchSite?: SiteFetcher;
  /** DNS resolver for email domain MX checks. Defaults to system DNS on live runs, or a no-network stub when `fetchSite` is injected. */
  mxResolver?: MxResolver;
  /** Per-domain MX lookup timeout in ms (default 3000). */
  mxTimeoutMs?: number;
  /**
   * Spaces requests to one host. Defaults to `SHARED_HOST_PACER`, so every
   * enrichment in this process stays under one request per second per host
   * between them. Another process (a CLI scrape next to `serve`) has its own
   * pacer; that is accepted.
   */
  pacer?: Pick<HostPacer, "wait">;
  /** Diagnostics for a run that stops; defaults to the BUSINESS_FINDER_DEBUG_LOG file, if set. */
  debug?: DebugLog;
  /** How often the debug log lists the checks still running. Default 30 s. */
  pendingReportMs?: number;
  /** Clock for each page's fetch time in `sources`. Defaults to the system clock. */
  now?: () => Date;
  /**
   * Aborted when the user cancels: no new site is started and requests in
   * flight stop. The leads returned are then incomplete and the counts do not
   * balance; the caller discards them.
   */
  signal?: AbortSignal;
  /**
   * Called with each lead as soon as its outcome is known, by its index in
   * the input: leads without a website at once, the rest as their check
   * ends. A lead cut off by a cancel is never reported. A throwing listener
   * is ignored.
   */
  onLead?: (index: number, lead: Lead) => void;
  /**
   * Called, synchronously, as each check starts and before and after each
   * page it fetches and reads, by the lead's index. A check that never ends
   * is the one whose last step is a `*_start`. A throwing listener is ignored.
   */
  onStep?: (index: number, step: CheckStep) => void;
  /**
   * Called synchronously with each page's URL as it is read, after its
   * `parse_start`. Fixture runs use it to stand in for a parser that never
   * returns; live runs leave it unset.
   */
  onRead?: (url: string) => void;
};

export type EnrichCounts = {
  /** Leads with a website. Always `fetched + unreachable + mismatched + skipped + notChecked`. */
  toCheck: number;
  fetched: number;
  unreachable: number;
  mismatched: number;
  skipped: number;
  /**
   * Websites whose check was stopped before it ended (it stopped making
   * progress, or the checks ran out of time); their rows read `not_checked`.
   * Absent when every check ended.
   */
  notChecked?: number;
};

export type EnrichProgress = { checked: number; toCheck: number };

export type CheckStep = "site_start" | "page_start" | "page_done" | "parse_start" | "parse_done";
const STEPS: ReadonlySet<string> = new Set<CheckStep>(["page_start", "page_done", "parse_start", "parse_done"]);

/**
 * Serves `https://<host>/` from `<dir>/<host>.html` and `https://<host>/<path>`
 * from `<dir>/<host>__<path>.html` (further slashes become `__`). A missing
 * file is an `http_error`, so tests and the end-to-end run never touch the
 * network.
 */
export function fixtureFetcher(dir: string): SiteFetcher {
  return async (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: "invalid_url" };
    }
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "__");
    const name = path ? `${parsed.hostname}__${path}` : parsed.hostname;
    if (!/^[a-z0-9._-]+$/i.test(name) || name.includes("..")) return { ok: false, reason: "http_error" };
    try {
      return { ok: true, finalUrl: parsed.href, html: await readFile(join(dir, `${name}.html`), "utf8") };
    } catch {
      return { ok: false, reason: "http_error" };
    }
  };
}

/** The listing's website as an absolute http(s) URL, `""` when blank, `null` when unusable. */
export function websiteUrl(website: string | undefined): string | null {
  const raw = (website ?? "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

type Page = { url: string; html: string; fetchedAt: string };
/** What one page gives; each page is read once. */
type Read = { emails: string[]; socials: Socials; matches: boolean; links: string[]; tels: string[] };
type Outcome = "fetched" | "unreachable" | "mismatched" | "skipped";
/** How a check ended in the debug log: a check cut off by a cancel is not a count. */
type LoggedOutcome = Outcome | "cancelled";

function hostOf(url: string | null): string {
  if (url === null) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function emptySocials(): Socials {
  return { instagram: "", facebook: "", linkedin: "", tiktok: "", youtube: "", x: "" };
}

/** A lead with no website to check. */
export function noWebsite(lead: Lead, emails: boolean): Lead {
  return withStatus(lead, "no_website", emails ? "no_website" : "skipped_by_option");
}

/** A lead whose website check was stopped before it ended. */
export function websiteNotChecked(lead: Lead, emails: boolean): Lead {
  return withStatus(lead, "not_checked", emails ? "not_checked" : "skipped_by_option");
}

/** "/path?query" of a URL for the debug log, `""` when it does not parse. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return "";
  }
}

function withStatus(lead: Lead, website: FieldStatus, email: FieldStatus): Lead {
  return {
    ...lead,
    ...emptySocials(),
    emails: [],
    email_types: [],
    email_mx: [],
    email_source_url: "",
    sources: [],
    website_status: website,
    email_status: email,
  };
}

async function enrichOne(
  lead: Lead,
  url: string,
  opts: EnrichOptions,
  fetchSite: SiteFetcher,
  fetchOpts: SafeFetchOptions,
  checkMx: (domain: string) => Promise<EmailMxStatus>,
  debug: DebugLog,
): Promise<{ lead: Lead; outcome: Outcome }> {
  const emailOff: FieldStatus = "skipped_by_option";
  if (!opts.emails && !opts.socials) return { lead: withStatus(lead, "skipped_by_option", emailOff), outcome: "skipped" };

  const now = opts.now ?? (() => new Date());
  const wantsPhone = !(lead.phone ?? "").trim();
  // Every fetch and every read is logged before and after, synchronously, so
  // a check that never ends leaves a `*_start` line with no `*_done`.
  const fetchPage = async (link: string) => {
    const host = hostOf(link);
    const path = pathOf(link);
    const t = performance.now();
    debug("page_start", { host, path });
    const page = await fetchSite(link, fetchOpts);
    const ms = Math.round(performance.now() - t);
    debug("page_done", { host, path, ms, ...(page.ok ? { chars: page.html.length } : { reason: page.reason }) });
    return page;
  };
  const read = (page: Page, home: boolean): Read => {
    const host = hostOf(page.url);
    const path = pathOf(page.url);
    const t = performance.now();
    debug("parse_start", { host, path, chars: page.html.length });
    opts.onRead?.(page.url);
    const found: Read = {
      emails: opts.emails ? extractEmails(page.html, page.url) : [],
      socials: opts.socials ? extractSocials(page.html, page.url) : emptySocials(),
      matches: matchesListing(page.html, lead, { country: opts.country }),
      links: home && opts.deep ? contactLinks(page.html, page.url) : [],
      tels: wantsPhone ? extractTelLinks(page.html) : [],
    };
    debug("parse_done", { host, path, ms: Math.round(performance.now() - t) });
    return found;
  };

  const home = await fetchPage(url);
  if (!home.ok) {
    return { lead: withStatus(lead, "site_unreachable", opts.emails ? "site_unreachable" : emailOff), outcome: "unreachable" };
  }

  const homePage: Page = { url: home.finalUrl, html: home.html, fetchedAt: now().toISOString() };
  const homeRead = read(homePage, true);
  const pages: { page: Page; found: Read }[] = [{ page: homePage, found: homeRead }];
  const nothingYet = (opts.emails && homeRead.emails.length === 0) || (!opts.emails && NETWORKS.every((n) => !homeRead.socials[n]));
  if (opts.deep && (nothingYet || !homeRead.matches)) {
    for (const link of homeRead.links) {
      if (opts.signal?.aborted) break;
      const fetched = await fetchPage(link);
      if (!fetched.ok) continue;
      const page: Page = { url: fetched.finalUrl, html: fetched.html, fetchedAt: now().toISOString() };
      pages.push({ page, found: read(page, false) });
    }
  }

  if (!pages.some((p) => p.found.matches)) {
    return { lead: withStatus(lead, "website_mismatch", opts.emails ? "website_mismatch" : emailOff), outcome: "mismatched" };
  }

  // Each value keeps the first page it was seen on.
  const emailSources: Source[] = [];
  const socialSources: Partial<Record<SocialNetwork, Source>> = {};
  for (const { page, found } of pages) {
    const at = { url: page.url, fetched_at: page.fetchedAt };
    for (const email of found.emails) {
      if (!emailSources.some((s) => s.value === email)) emailSources.push({ field: "email", value: email, ...at });
    }
    for (const network of NETWORKS) {
      if (!socialSources[network] && found.socials[network]) socialSources[network] = { field: network, value: found.socials[network], ...at };
    }
  }
  // A lead with no phone (a website handed in with `add`) takes the first
  // `tel:` link that is a valid number, read with the same rules as a Maps row.
  let phone: Source | undefined;
  if (wantsPhone) {
    for (const { page, found } of pages) {
      const number = found.tels.map((raw) => toE164(raw, opts.country ?? "")).find(Boolean);
      if (number) {
        phone = { field: "phone", value: number, url: page.url, fetched_at: page.fetchedAt };
        break;
      }
    }
  }
  const emails = emailSources.map((s) => s.value);
  const email_types = emails.map(classifyEmail);
  const email_mx = emails.length > 0 ? await Promise.all(emails.map((email) => checkMx(emailDomain(email)))) : [];
  const socials = emptySocials();
  for (const network of NETWORKS) socials[network] = socialSources[network]?.value ?? "";
  const sources = [...emailSources, ...NETWORKS.flatMap((n) => socialSources[n] ?? []), ...(phone ? [phone] : [])];
  return {
    lead: {
      ...lead,
      ...(phone ? { phone: phone.value, whatsapp: lead.whatsapp || whatsappLink(phone.value, opts.country ?? "") } : {}),
      ...socials,
      emails,
      email_types,
      email_mx,
      email_source_url: emailSources[0]?.url ?? "",
      sources,
      website_status: "found",
      email_status: opts.emails ? (emails.length ? "found" : "not_on_site") : emailOff,
    },
    outcome: "fetched",
  };
}

/**
 * Checks every lead's website, at most eight sites at once and at most one
 * request per second per host. Never throws for anything a website does:
 * unreadable sites become `site_unreachable`. Returns new lead objects in
 * input order. A site still being read when `signal` aborts is neither
 * counted nor written: it was cut off, not unreachable.
 */
export async function enrichLeads(
  leads: Lead[],
  opts: EnrichOptions,
  onProgress: (p: EnrichProgress) => void = () => {},
): Promise<{ leads: Lead[]; counts: EnrichCounts }> {
  const fetchSite = opts.fetchSite ?? safeFetch;
  const mxResolver = opts.mxResolver ?? (opts.fetchSite ? NOOP_MX_RESOLVER : systemDnsResolver);
  const checkMx = createMxCache({ resolver: mxResolver, timeoutMs: opts.mxTimeoutMs, signal: opts.signal });
  const debug = opts.debug ?? debugLogFromEnv();
  const fetchOpts: SafeFetchOptions = {
    timeoutMs: PAGE_TIMEOUT_MS,
    maxBytes: PAGE_MAX_BYTES,
    robots: new Map() as RobotsCache,
    pacer: opts.pacer ?? SHARED_HOST_PACER,
    signal: opts.signal,
    debug,
  };
  const counts: EnrichCounts = { toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 };
  let cancelled = 0;
  const out: Lead[] = leads.map((lead) => ({ ...lead }));
  const queue: { index: number; url: string | null }[] = [];
  const settle = (index: number) => {
    try {
      opts.onLead?.(index, out[index]!);
    } catch {
      // A failing listener must not stop the run.
    }
  };

  leads.forEach((lead, index) => {
    const url = websiteUrl(lead.website);
    if (url === "") {
      out[index] = withStatus(lead, "no_website", opts.emails ? "no_website" : "skipped_by_option");
      settle(index);
    } else {
      queue.push({ index, url });
    }
  });
  counts.toCheck = queue.length;

  let checked = 0;
  const report = () => {
    try {
      onProgress({ checked, toCheck: counts.toCheck });
    } catch {
      // A failing progress listener must not stop the run.
    }
  };

  // Diagnostics: which checks are running and how their time splits between
  // the network and reading the page. Reading is synchronous, so a check whose
  // parse time is large is one that held up every other check and timer.
  const running = new Map<number, { host: string; since: number }>();
  debug("websites_start", { toCheck: counts.toCheck });
  const pending =
    debug === NO_DEBUG_LOG
      ? undefined
      : setInterval(() => {
          for (const [n, { host, since }] of running) {
            debug("website_pending", { n, host, seconds: Math.round((performance.now() - since) / 1000) });
          }
        }, opts.pendingReportMs ?? 30_000);
  pending?.unref?.();

  let nextJob = 0;
  const worker = async () => {
    while (nextJob < queue.length && !opts.signal?.aborted) {
      const n = nextJob + 1;
      const { index, url } = queue[nextJob++]!;
      const lead = leads[index]!;
      const host = hostOf(url);
      const since = performance.now();
      let fetchMs = 0;
      const timedFetch: SiteFetcher = async (u, o) => {
        const t = performance.now();
        try {
          return await fetchSite(u, o);
        } finally {
          fetchMs += performance.now() - t;
        }
      };
      running.set(n, { host, since });
      const step = (s: CheckStep) => {
        try {
          opts.onStep?.(index, s);
        } catch {
          // A failing listener must not stop the run.
        }
      };
      // This check's page and parse lines also go to `onStep`.
      const siteDebug: DebugLog = (event, fields) => {
        debug(event, fields);
        if (STEPS.has(event)) step(event as CheckStep);
      };
      step("site_start");
      let result: { lead: Lead; outcome: Outcome };
      let error = "";
      try {
        result = url === null
          ? { lead: withStatus(lead, "site_unreachable", opts.emails ? "site_unreachable" : "skipped_by_option"), outcome: "unreachable" }
          : await enrichOne(lead, url, opts, timedFetch, fetchOpts, checkMx, siteDebug);
      } catch (e) {
        error = e instanceof Error ? e.name : "error";
        result = { lead: withStatus(lead, "site_unreachable", opts.emails ? "site_unreachable" : "skipped_by_option"), outcome: "unreachable" };
      }
      running.delete(n);
      // A cancel fails the request in flight the way a timeout does; the
      // signal is what tells them apart.
      const outcome: LoggedOutcome = opts.signal?.aborted ? "cancelled" : result.outcome;
      const ms = Math.round(performance.now() - since);
      debug("website_done", {
        n,
        host,
        outcome,
        ms,
        fetchMs: Math.round(fetchMs),
        parseMs: Math.max(0, ms - Math.round(fetchMs)),
        ...(error ? { error } : {}),
      });
      if (outcome === "cancelled") {
        cancelled += 1;
        continue;
      }
      out[index] = result.lead;
      counts[outcome] += 1;
      checked += 1;
      settle(index);
      report();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SITES, queue.length) }, worker));
  } finally {
    clearInterval(pending);
  }
  debug("websites_end", { ...counts, ...(cancelled ? { cancelled } : {}) });
  return { leads: out, counts };
}
