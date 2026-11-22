// Shared keyword and city list helpers. Kept free of Node imports so both
// the backend and the web UI parse and display multi-keyword searches alike.

/** Splits raw keyword text on commas (ASCII or CJK) or newlines, trims, and dedupes case-insensitively. */
export function parseKeywords(raw: string): string[] {
  return dedupeTerms(raw.split(/[,，、\r\n]+/));
}

/** Trims and deduplicates terms case-insensitively while keeping the first typed spelling and order. */
export function dedupeTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const clean = raw.trim();
    if (!clean) continue;
    const key = clean.replace(/\s+/g, " ").toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/** All keywords in a search, falling back to the single `keyword` field. */
export function keywordsOf(options: { keyword: string; keywords?: readonly string[] }): string[] {
  if (options.keywords && options.keywords.length > 0) {
    const cleaned = dedupeTerms(options.keywords);
    if (cleaned.length > 0) return cleaned;
  }
  const single = options.keyword.trim();
  return single ? [single] : [];
}

/** All cities in a search, falling back to the single `city` field. */
export function citiesOf(options: { city: string; cities?: readonly string[] }): string[] {
  if (options.cities && options.cities.length > 0) {
    const cleaned = dedupeTerms(options.cities);
    if (cleaned.length > 0) return cleaned;
  }
  const single = options.city.trim();
  return single ? [single] : [];
}
