// A small client for the local job API (/api/v1). Every failure becomes an
// `ApiError` whose message is ready to show next to the button that caused it.

import { type ListQuery, writeListQuery } from "../../src/jobs/filter";
import type { Job, LeadRow, ListInfo, RowsMeta } from "./types";
import type { Listed } from "./lib/lists";
import type { JobRequest } from "./lib/search";
import { toLeadRow } from "./lib/source";

export type { Job, JobStatus, LeadRow, LeadSource, ListInfo, Progress, Reconciliation, RowsMeta } from "./types";

export type ExportFormat = "csv" | "json";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    /** The request field the server rejected, when it named one. */
    readonly field?: string,
    /** The HTTP status, when the server answered. */
    readonly status?: number,
  ) {
    super(message);
  }
}

const UNREACHABLE = "Business Finder has stopped answering. Start it again, then try once more.";

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: "application/json", ...init?.headers } });
  } catch {
    throw new ApiError(UNREACHABLE);
  }
  if (res.ok) return res;
  let body: { error?: unknown; field?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    // Not a JSON error body; fall through to the generic message.
  }
  const message = typeof body.error === "string" ? body.error : "Business Finder could not do that. Try again.";
  throw new ApiError(message, typeof body.field === "string" ? body.field : undefined, res.status);
}

export async function createJob(options: JobRequest): Promise<string> {
  const res = await request("/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  const { id } = (await res.json()) as { id: string };
  return id;
}

export async function getJob(id: string, signal?: AbortSignal): Promise<Job> {
  const res = await request(`/api/v1/jobs/${encodeURIComponent(id)}`, signal ? { signal } : undefined);
  return (await res.json()) as Job;
}

/** Every job the server still has, newest first. */
export async function listJobs(signal?: AbortSignal): Promise<Job[]> {
  const res = await request("/api/v1/jobs", signal ? { signal } : undefined);
  const { jobs } = (await res.json()) as { jobs: Job[] };
  return jobs;
}

/** Every saved list, one per search (repeated runs of a search are one list), newest first. */
export async function listLists(signal?: AbortSignal): Promise<Listed[]> {
  const res = await request("/api/v1/lists", signal ? { signal } : undefined);
  const { lists } = (await res.json()) as { lists: Listed[] };
  return lists;
}

/** The list any run `id` belongs to: the run it follows, its title and how many runs it combines. */
export async function getList(id: string, signal?: AbortSignal): Promise<ListInfo> {
  const res = await request(`/api/v1/lists/${encodeURIComponent(id)}`, signal ? { signal } : undefined);
  return (await res.json()) as ListInfo;
}

/**
 * Stops a queued or running search; the places it saved so far are kept. The
 * job then reads `cancelled`. A search that already finished, or runs in a
 * terminal, answers with a message to show next to the button.
 */
export async function cancelJob(id: string): Promise<void> {
  await request(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

/**
 * Deletes a saved list and every run of its search. Refuses with 409 when any
 * run is still running, or reports which runs remain if a delete fails midway.
 */
export async function deleteList(id: string): Promise<void> {
  await request(`/api/v1/lists/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function downloadPath(id: string, format: ExportFormat, query?: ListQuery, columns: "lean" | "full" = "lean"): string {
  const params = new URLSearchParams({ format, columns });
  if (query) writeListQuery(params, query);
  return `/api/v1/jobs/${encodeURIComponent(id)}/download?${params}`;
}

/**
 * The list's rows as the page shows them, every run of its search combined,
 * also while a run is still going: rows are saved batch by batch, and filled
 * in as their websites are checked. `meta` says what the markers are judged
 * against.
 */
export async function getLeads(id: string, signal?: AbortSignal): Promise<{ rows: LeadRow[]; meta: RowsMeta }> {
  const res = await request(`/api/v1/jobs/${encodeURIComponent(id)}/rows`, signal ? { signal } : undefined);
  const body = (await res.json()) as { rows: Record<string, unknown>[]; list?: Partial<RowsMeta> };
  const rows = body.rows.map(toLeadRow);
  const meta: RowsMeta = {
    runs: body.list?.runs ?? 1,
    latest: body.list?.latest ?? null,
    ...(body.list?.runDates ? { runDates: body.list.runDates } : {}),
    fresh: body.list?.fresh ?? 0,
    missing: body.list?.missing ?? 0,
  };
  return { rows, meta };
}

/** The file name from `Content-Disposition`, preferring the RFC 5987 `filename*`. */
function fileName(header: string | null, format: ExportFormat): string {
  const star = header && /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // Malformed encoding; use the plain name below.
    }
  }
  const plain = header && /filename="([^"]+)"/i.exec(header);
  return plain?.[1] ?? `business-finder-export.${format}`;
}

/** Fetches an export (filtered and sorted to match what is shown) and hands it to the browser as a file download. */
export async function downloadExport(id: string, format: ExportFormat, query?: ListQuery): Promise<void> {
  const res = await request(downloadPath(id, format, query));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(res.headers.get("Content-Disposition"), format);
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke after the click has been handled so the download can start.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
