// Export file names shared by the CLI and the HTTP download.

/** Lowercase, words joined by `-`, safe in a file name on every platform. */
export function slug(text: string, fallback: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || fallback;
}

/** `business-finder-<keyword>-<city>-<yyyymmdd-hhmm>.<ext>` in local time. */
export function defaultFileName(keyword: string, city: string, now: Date, ext: "csv" | "json"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `business-finder-${slug(keyword, "keyword")}-${slug(city, "city")}-${stamp}.${ext}`;
}
