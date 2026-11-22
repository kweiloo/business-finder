// The job API, served on 127.0.0.1 to the web UI and to local tools.
// Every request must name localhost in `Host` and, when sent, `Origin`:
// that stops a web page on another site, or a DNS-rebinding host name that
// resolves to 127.0.0.1, from driving the API from the user's browser.
// A POST body must also be declared as JSON: a cross-site page can only send
// a "simple" type such as text/plain without a CORS preflight.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { FULL_EXTRA_COLUMNS, LEAN_COLUMNS, toCsv, toJson } from "../core/export/csv.js";
import { defaultFileName } from "../core/export/filename.js";
import { dedupeTerms, parseKeywords } from "../core/keywords.js";
import { MAX_WHOLE_CITY_LIMIT } from "../core/searchSize.js";
import type { RunOptions } from "../core/types.js";
import { listSummaries, readList } from "../jobs/combine.js";
import { applyListQuery, parseListQuery } from "../jobs/filter.js";
import { groupOf, listedJob } from "../jobs/lists.js";
import { isJobId, processAlive, type Job, type JobStore } from "../jobs/store.js";
import { JobWorker, type Runner } from "../jobs/worker.js";
import { VERSION } from "../version.js";

export type AppDeps = { store: JobStore; runner: Runner };

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** `localhost` or `127.0.0.1`, optionally with a port; lowercased. Null for anything else. */
function localHost(value: string | undefined): string | null {
  if (!value) return null;
  const host = value.trim().toLowerCase();
  const match = /^([a-z0-9.]+)(?::(\d{1,5}))?$/.exec(host);
  if (!match || !LOCAL_HOSTNAMES.has(match[1]!)) return null;
  return host;
}

/**
 * 403 unless `Host` is localhost or 127.0.0.1 and `Origin`, when present,
 * is exactly `http://<that host and port>`. Applies to every method.
 */
export function localhostOnly(): MiddlewareHandler {
  return async (c, next) => {
    const host = localHost(c.req.header("host") ?? new URL(c.req.url).host);
    const origin = c.req.header("origin");
    if (!host || (origin !== undefined && origin.toLowerCase() !== `http://${host}`)) {
      return c.json({ error: "Business Finder only answers requests from this computer." }, 403);
    }
    await next();
  };
}

type Invalid = { error: string; field: string };

const DEFAULTS = { depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 600 };

function wholeNumber(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min;
}

/** Validates a POST body into `RunOptions`, filling defaults; returns the first problem otherwise. */
export function parseRunOptions(body: unknown): RunOptions | Invalid {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { field: "body", error: "Send the search as a JSON object." };
  }
  const b = body as Record<string, unknown>;
  let keywords: string[];
  if (b.keywords !== undefined) {
    if (!Array.isArray(b.keywords) || b.keywords.some((k) => typeof k !== "string" || !k.trim())) {
      return { field: "keywords", error: "Enter what to search for." };
    }
    keywords = dedupeTerms(b.keywords);
    if (keywords.length === 0) return { field: "keywords", error: "Enter what to search for." };
  } else {
    const rawKeyword = typeof b.keyword === "string" ? b.keyword : "";
    keywords = parseKeywords(rawKeyword);
    if (keywords.length === 0) return { field: "keyword", error: "Enter what to search for." };
  }
  const keyword = keywords[0]!;

  let cities: string[];
  if (b.cities !== undefined) {
    if (!Array.isArray(b.cities) || b.cities.some((c) => typeof c !== "string" || !c.trim())) {
      return { field: "cities", error: "Enter a city." };
    }
    cities = dedupeTerms(b.cities);
    if (cities.length === 0) return { field: "cities", error: "Enter a city." };
  } else {
    const rawCity = typeof b.city === "string" ? b.city.trim() : "";
    if (!rawCity) return { field: "city", error: "Enter a city." };
    cities = [rawCity];
  }
  const city = cities[0]!;

  const o: RunOptions = {
    ...DEFAULTS,
    keyword,
    ...(keywords.length > 1 ? { keywords } : {}),
    city,
    ...(cities.length > 1 ? { cities } : {}),
  };
  if (b.depth !== undefined) {
    if (!wholeNumber(b.depth, 1)) return { field: "depth", error: "Depth must be a whole number of at least 1." };
    o.depth = b.depth;
  }
  if (b.maxSeconds !== undefined) {
    if (!wholeNumber(b.maxSeconds, 1)) return { field: "maxSeconds", error: "The time limit must be a whole number of seconds." };
    o.maxSeconds = b.maxSeconds;
  }
  if (b.limit !== undefined) {
    if (!wholeNumber(b.limit, 0)) return { field: "limit", error: "The limit must be a whole number of 0 or more." };
    if (b.limit > MAX_WHOLE_CITY_LIMIT) return { field: "limit", error: `The limit must be at most ${MAX_WHOLE_CITY_LIMIT}.` };
    o.limit = b.limit;
  }
  if (b.wholeCity !== undefined) {
    if (typeof b.wholeCity !== "boolean") return { field: "wholeCity", error: "wholeCity must be true or false." };
    o.wholeCity = b.wholeCity;
  }
  if (b.lang !== undefined) {
    if (typeof b.lang !== "string" || !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(b.lang.trim())) {
      return { field: "lang", error: "The language must be a code such as en or zh-CN." };
    }
    o.lang = b.lang.trim();
  }
  if (b.country !== undefined) {
    if (typeof b.country !== "string" || !/^[a-z]{2}$/i.test(b.country.trim())) {
      return { field: "country", error: "The country must be a two-letter code such as MY." };
    }
    o.country = b.country.trim().toUpperCase();
  }
  for (const flag of ["emails", "socials", "deep"] as const) {
    if (b[flag] === undefined) continue;
    if (typeof b[flag] !== "boolean") return { field: flag, error: `${flag} must be true or false.` };
    o[flag] = b[flag];
  }
  return o;
}

/** `attachment` with an ASCII `filename`, plus RFC 5987 `filename*` when the name is not ASCII. */
function attachment(name: string, ext: "csv" | "json"): string {
  if (/^[\x20-\x7e]+$/.test(name) && !/["\\]/.test(name)) return `attachment; filename="${name}"`;
  return `attachment; filename="business-finder-export.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** True when `Content-Type` is `application/json`, with or without parameters. */
function isJson(contentType: string | undefined): boolean {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** The lead fields a row on the list page shows, and the two statuses that say whether its website was checked yet. */
export const ROW_FIELDS = [
  "title",
  "phone",
  "whatsapp",
  "emails",
  "email_types",
  "email_mx",
  "website",
  "category",
  "address",
  "review_rating",
  "review_count",
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube",
  "x",
  "source",
  "email_status",
  "website_status",
  "first_seen",
  "new",
  "not_found_last_time",
] as const;

function notFound(c: Context) {
  return c.json({ error: "No such job." }, 404);
}

function omitCause<T extends { cause?: string }>(job: T): Omit<T, "cause"> {
  const { cause: _, ...rest } = job;
  return rest;
}

export function createApp(deps: AppDeps): Hono {
  const { store } = deps;
  const worker = new JobWorker(store, deps.runner);
  const app = new Hono();

  app.use("*", localhostOnly());

  // The pid lets a CLI run check that the server on the recorded port is the recorded one.
  app.get("/api/v1/health", (c) => c.json({ ok: true, version: VERSION, pid: process.pid }));

  app.post("/api/v1/jobs", async (c) => {
    if (!isJson(c.req.header("content-type"))) {
      return c.json({ error: "Send the search as JSON (Content-Type: application/json)." }, 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "The request body is not valid JSON.", field: "body" }, 400);
    }
    const options = parseRunOptions(body);
    if ("error" in options) return c.json(options, 422);
    const job = store.create(options);
    worker.enqueue(job.id);
    return c.json({ id: job.id }, 201, { Location: `/api/v1/jobs/${job.id}` });
  });

  app.get("/api/v1/jobs", (c) => c.json({ jobs: store.list().map(omitCause) }));

  // One entry per search: repeated runs of a search are one list, counted combined.
  app.get("/api/v1/lists", (c) => c.json({ lists: listSummaries(store).map(omitCause) }, 200, { "Cache-Control": "no-store" }));

  // Any run's id opens its search's list: the run the list follows, its title and how many runs it combines.
  app.get("/api/v1/lists/:id", (c) => {
    const id = c.req.param("id");
    const group = isJobId(id) ? groupOf(store.list(), id) : null;
    if (!group) return notFound(c);
    return c.json(omitCause({ ...listedJob(group), runs: group.runs.length }), 200, { "Cache-Control": "no-store" });
  });

  app.get("/api/v1/jobs/:id", (c) => {
    const id = c.req.param("id");
    const job = isJobId(id) ? store.get(id) : null;
    return job ? c.json(omitCause(job)) : notFound(c);
  });

  app.delete("/api/v1/jobs/:id", (c) => {
    const id = c.req.param("id");
    if (!isJobId(id) || !store.get(id)) return notFound(c);
    if (worker.running === id) return c.json({ error: "This search is still running. Cancel it first." }, 409);
    worker.dequeue(id);
    store.delete(id);
    return c.body(null, 204);
  });

  // Deletes every run of a search (`searchKey`) as one list. Refuses if any
  // run is still running, and deletes the requested id last so a partial
  // failure leaves the list reachable with what remains.
  app.delete("/api/v1/lists/:id", (c) => {
    const id = c.req.param("id");
    const group = isJobId(id) ? groupOf(store.list(), id) : null;
    if (!group) return notFound(c);
    const active = (r: Job) =>
      worker.running === r.id ||
      ((r.status === "running" || r.status === "queued") && (!r.owner || processAlive(r.owner.pid)));
    if (group.runs.some(active)) {
      return c.json({ error: "This search is still running. Cancel it first." }, 409);
    }
    const ordered = [
      ...group.runs.filter((r) => r.id !== id).reverse(),
      ...group.runs.filter((r) => r.id === id),
    ];
    const remaining: string[] = [];
    for (const run of ordered) {
      if (run.id === id && remaining.length > 0) {
        remaining.push(run.id);
        continue;
      }
      try {
        worker.dequeue(run.id);
        store.delete(run.id);
      } catch {
        remaining.push(run.id);
      }
    }
    if (remaining.length > 0) {
      const total = group.runs.length;
      const error =
        total === 1
          ? "This list could not be deleted. Try again."
          : `${remaining.length} of ${total} searches could not be deleted. Try again.`;
      return c.json({ error, remaining }, 500);
    }
    return c.body(null, 204);
  });

  // No body, so no Content-Type check; a cross-site POST still fails the Origin check.
  app.post("/api/v1/jobs/:id/cancel", (c) => {
    const id = c.req.param("id");
    if (!isJobId(id)) return notFound(c);
    const outcome = worker.cancel(id);
    switch (outcome) {
      case "unknown":
        return notFound(c);
      case "finished":
        return c.json({ error: "This search has already finished." }, 409);
      case "elsewhere": {
        const where = store.get(id)?.owner?.kind === "cli"
          ? "in a terminal. Stop it there with Ctrl+C."
          : "in another Business Finder server. Cancel it there.";
        return c.json({ error: `This search is running ${where}` }, 409);
      }
      default:
        return c.json({ status: outcome }, 202);
    }
  });

  // The rows the page shows: every run of the job's search combined, also
  // while a run is going (rows are saved batch by batch and filled in as
  // their websites are checked). Only the fields a row shows, so polling a
  // long list stays small. `list` says what the markers are judged against.
  app.get("/api/v1/jobs/:id/rows", (c) => {
    const id = c.req.param("id");
    const read = isJobId(id) ? readList(store, id) : null;
    if (!read) return notFound(c);
    const { list } = read;
    const rows = list.rows.map((lead) => {
      const l = lead as unknown as Record<string, unknown>;
      return Object.fromEntries(ROW_FIELDS.map((f) => [f, l[f] ?? null]));
    });
    const summary = {
      runs: list.runs,
      latest: list.latest?.createdAt ?? null,
      runDates: list.runDates,
      fresh: list.fresh,
      missing: list.missing,
    };
    return c.json({ rows, list: summary }, 200, { "Cache-Control": "no-store" });
  });

  // Exports the whole list: every run of this job's search, combined.
  app.get("/api/v1/jobs/:id/download", (c) => {
    const id = c.req.param("id");
    const read = isJobId(id) ? readList(store, id) : null;
    if (!read) return notFound(c);
    // The run the list follows: a re-run still going holds the export back, as on the page.
    const job = read.group.shown;
    const format = c.req.query("format") ?? "csv";
    const columnSet = c.req.query("columns") ?? "lean";
    if (format !== "csv" && format !== "json") return c.json({ error: "format must be csv or json.", field: "format" }, 422);
    if (columnSet !== "lean" && columnSet !== "full") {
      return c.json({ error: "columns must be lean or full.", field: "columns" }, 422);
    }
    if (job.status === "queued" || job.status === "running") {
      return c.json({ error: "This search has not finished yet." }, 409);
    }
    const columns = columnSet === "full" ? [...LEAN_COLUMNS, ...FULL_EXTRA_COLUMNS] : LEAN_COLUMNS;
    const query = parseListQuery(new URL(c.req.url).searchParams);
    const leads = applyListQuery(read.list.rows, query);
    const name = defaultFileName(job.options.keyword, job.options.city, new Date(job.createdAt), format);
    const headers = {
      "Content-Disposition": attachment(name, format),
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    return c.body(format === "csv" ? toCsv(leads, columns) : toJson(leads, columns), 200, headers);
  });

  app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

  return app;
}
