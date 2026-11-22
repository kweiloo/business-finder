// Plain-language lines built from a job's counts. Counts only: no scraped
// text ever goes into a sentence written by the UI.

type WebsiteCounts = { toCheck: number; fetched: number; unreachable: number; mismatched: number; skipped: number; notChecked?: number };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 websites didn't answer in time and were skipped." */
export function skippedLine(n: number): string {
  return n === 1 ? "1 website didn't answer in time and was skipped." : `${n} websites didn't answer in time and were skipped.`;
}

/**
 * Why some leads have no email, e.g.
 * "Looked for emails on 10 websites: 5 read, 4 didn't answer, 1 was a different business."
 * Parts that are zero are left out; websites whose check was stopped get
 * their own sentence ("1 website didn't answer in time and was skipped.").
 */
export function websitesLine(r: WebsiteCounts): string {
  if (r.toCheck === 0) return "None of these places listed a website to look for emails on.";
  const parts = [
    r.fetched > 0 && `${r.fetched} read`,
    r.unreachable > 0 && `${r.unreachable} didn't answer`,
    r.mismatched > 0 && (r.mismatched === 1 ? "1 was a different business" : `${r.mismatched} were different businesses`),
    r.skipped > 0 && `${r.skipped} skipped`,
  ].filter((p): p is string => typeof p === "string");
  const skipped = r.notChecked ?? 0;
  const looked = `Looked for emails on ${plural(r.toCheck, "website", "websites")}`;
  if (skipped === 0) return `${looked}: ${parts.join(", ")}.`;
  return parts.length > 0 ? `${looked}: ${parts.join(", ")}. ${skippedLine(skipped)}` : `${looked}. ${skippedLine(skipped)}`;
}
