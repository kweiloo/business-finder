// Which runs are one list. Every run of a search stays its own job on disk;
// runs of the same search (same keyword and place, whatever the casing and
// spacing) are shown as one list. The page, the API, every export and the CLI
// all group with this module, so they give the same answer. It imports
// nothing from Node, so the web page can use it too.

import { citiesOf, keywordsOf } from "../core/keywords.js";

/** The searched place's OpenStreetMap name and type, e.g. Bandaraya Melaka, city. */
export type JobPlace = { name: string; type: string };

/** What grouping reads from a job. */
export type RunLike = {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  options: { keyword: string; keywords?: string[]; city: string; cities?: string[] };
  place?: JobPlace;
  /** ISO 8601 time the run was created. */
  createdAt: string;
};

type Search = { keyword: string; keywords?: string[]; city: string; cities?: string[] };

const shortCity = (city: string) => {
  const first = city.split(",")[0]?.trim();
  return first || city.trim();
};

/**
 * "Dentist in Lisbon" (or "Souvenir shop +2 in Melaka" for multi-keyword):
 * the search as typed, with the first letter raised where the script has
 * capitals, and the place up to its first comma (the full place is on the
 * properties line). A list made only by `business-finder add` has no city; its
 * keyword is the `--title` it was given, shown as written.
 */
export function listTitle(search: Search): string {
  const kws = keywordsOf(search);
  const cities = citiesOf(search);
  const firstKw = kws[0] ?? search.keyword.trim();
  if (cities.length === 0) return firstKw;
  const what = `${firstKw.charAt(0).toLocaleUpperCase()}${firstKw.slice(1)}${kws.length > 1 ? ` +${kws.length - 1}` : ""}`;
  const where = `${shortCity(cities[0]!)}${cities.length > 1 ? ` +${cities.length - 1}` : ""}`;
  return `${what} in ${where}`;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * Two runs of the same search share this key: same normalized keyword set
 * (regardless of order, casing or spacing) and same normalized city set.
 * A list made by `business-finder add --title` has no city and is not a search that
 * runs again: two of them with the same title hold different places, so each
 * keeps its own key.
 */
export function searchKey(j: Pick<RunLike, "id" | "options">): string {
  const cities = citiesOf(j.options);
  if (cities.length === 0) return `\u0001${j.id}`;
  const kwKey = [...new Set(keywordsOf(j.options).map(norm))].sort().join("\u0002");
  const cityKey = [...new Set(cities.map(norm))].sort().join("\u0002");
  return `${kwKey}\u0000${cityKey}`;
}

/** The whole search for a hover hint: "dentist in Lisbon, Portugal", or "souvenir shop, 纪念品店 in Melaka". */
export function searchText(search: Search): string {
  const what = keywordsOf(search).join(", ");
  const cities = citiesOf(search);
  if (cities.length === 0) return what || search.keyword.trim();
  const where = cities.length > 1 ? cities.join("; ") : cities[0]!;
  return `${what} in ${where}`;
}

/** One search: every run of it, newest first, and the run the page follows. */
export type RunGroup<J extends RunLike> = {
  key: string;
  /** The first run's title, so "Dentist in Lisbon" does not turn into "Dentist in lisbon" when typed again. */
  title: string;
  /** The first run's searched place, so the properties line agrees with the title. */
  place?: JobPlace;
  /** Newest first. */
  runs: J[];
  /**
   * The run whose status the list shows: the newest, unless it was cancelled
   * and an older run was not, so cancelling a re-run never turns a finished
   * list into a cancelled one. A search whose runs were all cancelled shows
   * its newest run.
   */
  shown: J;
};

const byNewest = <J extends RunLike>(jobs: readonly J[]) =>
  [...jobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

/** Every search, newest first by its newest run. */
export function groupRuns<J extends RunLike>(jobs: readonly J[]): RunGroup<J>[] {
  const groups = new Map<string, J[]>();
  for (const j of byNewest(jobs)) {
    const key = searchKey(j);
    const runs = groups.get(key);
    if (runs) runs.push(j);
    else groups.set(key, [j]);
  }
  return [...groups].map(([key, runs]) => {
    const shown = runs[0]!.status === "cancelled" ? (runs.find((r) => r.status !== "cancelled") ?? runs[0]!) : runs[0]!;
    const first = runs[runs.length - 1]!;
    const place = first.place ?? [...runs].reverse().find((r) => r.place)?.place;
    return { key, title: listTitle(first.options), ...(place ? { place } : {}), runs, shown };
  });
}

/** The search run `id` belongs to; null when no job has that id. */
export function groupOf<J extends RunLike>(jobs: readonly J[], id: string): RunGroup<J> | null {
  const run = jobs.find((j) => j.id === id);
  if (!run) return null;
  const key = searchKey(run);
  return groupRuns(jobs.filter((j) => searchKey(j) === key))[0] ?? null;
}

/** A past search as the rail shows it: the run it follows, titled as the search was first typed. */
export type Listed<J extends RunLike> = J & { title: string };

/** The run a list follows, with the group's title and place so header and properties line use one source. */
export function listedJob<J extends RunLike>(group: RunGroup<J>): Listed<J> {
  return { ...group.shown, ...(group.place ? { place: group.place } : {}), title: group.title };
}

/** One entry per search, newest first; see `RunGroup.shown` for which run stands for it. */
export function collapseLists<J extends RunLike>(jobs: readonly J[]): Listed<J>[] {
  return groupRuns(jobs).map(listedJob);
}
