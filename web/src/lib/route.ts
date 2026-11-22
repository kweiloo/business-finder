// The URL is the page state: `/` is a new list, `/?job=<id>` is that list,
// and active filters/sort sit next to `?job=` so reloading keeps the view.

import { type ListQuery, parseListQuery, writeListQuery } from "../../../src/jobs/filter.js";

export { type ListQuery };

/** The open list's job id, or null for the new-list form. */
export function jobIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("job")?.trim();
  return id ? id : null;
}

/** Active filters and sort from the URL query string. */
export function listQueryFromSearch(search: string): ListQuery {
  return parseListQuery(search);
}

/** The address of a list (with optional active filters/sort), or of the new-list form for null. */
export function urlForJob(id: string | null, query?: ListQuery): string {
  if (id === null) return "/";
  const params = new URLSearchParams({ job: id });
  if (query) writeListQuery(params, query);
  return `/?${params}`;
}

/**
 * Every search starts a new list with its own URL; nothing ever changes a
 * list that already exists, so an old list is never shown under a form that
 * no longer matches it. Throws what `create` throws and stays put.
 */
export async function startList<Q>(query: Q, deps: { create(query: Q): Promise<string>; go(url: string): void }): Promise<void> {
  const id = await deps.create(query);
  deps.go(urlForJob(id));
}
