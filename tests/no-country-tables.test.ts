// Guard against country-specific branches or lookup tables returning to `src/`.
// The skill interprets places for any country; the code stays country-neutral.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC_DIR = path.join(ROOT, "src");

const REGEX_AFTER = new Set([
  "", "(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "/", "%", "<", ">", "~", "^", "\n",
]);

/** Strips `//` and `/* *\/` comments from TypeScript source while keeping strings, templates, and regexes intact. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let prevNonSpace = "";
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i++;
        if (c === "\\") {
          if (i < source.length) {
            out += source[i]!;
            i++;
          }
          continue;
        }
        if (c === quote) break;
      }
      prevNonSpace = quote;
      continue;
    }
    if (ch === "/" && REGEX_AFTER.has(prevNonSpace)) {
      out += ch;
      i++;
      let inClass = false;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i++;
        if (c === "\\") {
          if (i < source.length) {
            out += source[i]!;
            i++;
          }
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
      }
      prevNonSpace = "/";
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) prevNonSpace = ch;
    else if (ch === "\n" && prevNonSpace === "") prevNonSpace = "\n";
    i++;
  }
  return out;
}

const RULES: readonly { label: string; pattern: RegExp }[] = [
  {
    label: "country-code comparison",
    pattern:
      /(?:===?|!==?)\s*["'`][A-Z]{2}["'`]|["'`][A-Z]{2}["'`]\s*(?:===?|!==?)|\bcase\s+["'`][A-Z]{2}["'`]\s*:|\.(?:includes|has)\(\s*["'`][A-Z]{2}["'`]\s*\)|\b(?:country|countryCode|runCountry|cc)\b\s*(?:===?|!==?)\s*["'`][a-z]{2}["'`]|["'`][a-z]{2}["'`]\s*(?:===?|!==?)\s*\b(?:country|countryCode|runCountry|cc)\b/g,
  },
  {
    label: "ISO 3166 country-keyed table",
    pattern: /(?:[{,]\s*)(?:["'`][A-Z]{2}["'`]|[A-Z]{2})\s*:|\[\s*["'`][A-Z]{2}["'`]\s*[,:\]]/g,
  },
  {
    label: "ISO 3166-2 subdivision code",
    pattern: /["'`][A-Z]{2}-[A-Z0-9]{1,3}["'`]/g,
  },
];

export type Violation = { file: string; line: number; rule: string; snippet: string };

/** Scans `source` (comments stripped) for hardcoded country comparisons or ISO 3166 tables. */
export function findCountryViolations(file: string, source: string): Violation[] {
  const clean = stripComments(source);
  const found: Violation[] = [];
  for (const { label, pattern } of RULES) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of clean.matchAll(re)) {
      const line = clean.slice(0, match.index).split("\n").length;
      found.push({ file, line, rule: label, snippet: match[0].trim() });
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("no country-specific branches or ISO 3166 tables in src/", () => {
  it("finds no literal country comparisons, ISO 3166 tables, or subdivision codes in src/", () => {
    const violations: Violation[] = [];
    for (const full of sourceFiles(SRC_DIR)) {
      const rel = path.relative(ROOT, full).replace(/\\/g, "/");
      violations.push(...findCountryViolations(rel, readFileSync(full, "utf8")));
    }
    expect(violations).toEqual([]);
  });

  it("catches country comparisons, country tables, and subdivision codes while ignoring comments", () => {
    const allowed = `
      // runCountry === "MY" and "MY-01" in a comment are fine.
      /* { "MY": ["KL"], "MY-07": ["George Town"] } */
      const url = "https://nominatim.openstreetmap.org/search"; // "http://example.test"
      const re = /https?:\\/\\//;
      const ok = encoding === "br" && mx === "ok";
    `;
    expect(findCountryViolations("allowed.ts", allowed)).toEqual([]);

    expect(findCountryViolations("cmp.ts", 'if (runCountry === "MY") {}').map((v) => v.rule)).toContain("country-code comparison");
    expect(findCountryViolations("lower.ts", 'if (country === "my") {}').map((v) => v.rule)).toContain("country-code comparison");
    expect(findCountryViolations("sw.ts", 'switch (cc) { case "SG": break; }').map((v) => v.rule)).toContain("country-code comparison");
    expect(findCountryViolations("tbl.ts", 'const T = { "MY": ["KL"], SG: ["SG"] };').map((v) => v.rule)).toContain(
      "ISO 3166 country-keyed table",
    );
    expect(findCountryViolations("sub.ts", 'const S = { "MY-01": ["JB"] };').map((v) => v.rule)).toContain(
      "ISO 3166-2 subdivision code",
    );
  });
});
