// Reads contact details out of a business website's HTML. Every pattern is
// length-bounded so a 2 MB page of hostile or binary content stays linear.

import { phoneCountry } from "../leads/phone.js";
import type { Lead, SocialNetwork } from "../types.js";
import { LONG_TLDS } from "./tlds.js";

export type { SocialNetwork };
export type Socials = Record<SocialNetwork, string>;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", period: ".", hyphen: "-",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (match, code: string) => {
    if (code[0] !== "#") return NAMED_ENTITIES[code.toLowerCase()] ?? match;
    const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
  });
}

function safeDecodeURI(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Emails

const EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi;
const DOT = String.raw`(?:\s+dot\s+|\s*[\[({]\s*dot\s*[\])}]\s*)`;
// "name at shop dot test": only rewritten when at least one written-out dot
// follows, so "Visit us at shop.test" stays a sentence.
const SPACED_AT = new RegExp(String.raw`\b([a-z0-9._%+-]{1,64})\s+at\s+([a-z0-9-]{1,63}(?:${DOT}[a-z0-9-]{1,63}){1,4})\b`, "gi");
// `(?<!\s)` starts a match only at the start of a whitespace run. Without it the
// leading `\s*` is retried from every position in the run, which is quadratic
// in the run's length and blocks the event loop on a page of blank lines.
const BRACKET_AT = /(?<!\s)\s*[\[({]\s*at\s*[\])}]\s*/gi;
const BRACKET_DOT = /(?<!\s)\s*[\[({]\s*dot\s*[\])}]\s*/gi;
const BLOCKED_DOMAIN_PARTS = [
  "example", "sentry", "wixpress", "godaddy", "domain.com", "email.com", "yourdomain", "mysite.com", "schema.org", "w3.org",
];
// Contact-form placeholder text such as "you@yourcompany.com". Matched as whole
// labels so a real business like acmecompany.com.my is kept.
const PLACEHOLDER_LABELS = new Set([
  "yourcompany", "mycompany", "companyname", "yourbusiness", "yourwebsite", "yoursite", "yourname",
]);
const FILE_SUFFIX = /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif|tiff?|css|js|json|mp4|webm|woff2?)$/;

/** `company.com`, `company.com.my` and the like: the label "company" followed only by suffix labels. */
function isPlaceholderDomain(domain: string): boolean {
  const labels = domain.split(".");
  if (labels.some((label) => PLACEHOLDER_LABELS.has(label))) return true;
  return labels[0] === "company" && labels.slice(1).every((label) => label.length <= 3);
}

/** A hostname without a leading www., m., mobile. or web. label. */
const bareHost = (host: string) => host.toLowerCase().replace(/^(www|m|mobile|web)\./, "");

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

// A generic second level followed by a label longer than any country code:
// "shop.com.sgt" is "shop.com.sg" plus run-on text, but without the site's host
// there is no telling where the domain really ended.
const RUN_ON_AFTER_GENERIC = /\.(com|net|org|edu|gov)\.[a-z]{3,}$/;

type Found = { raw: string; fromMailto: boolean };

function cleanEmail({ raw, fromMailto }: Found, siteHost: string): string | null {
  let email = raw.trim().toLowerCase().replace(/\.+$/, "");
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return null;
  let domain = email.slice(at + 1);
  // Text that runs on after an address ("...@shop.com.myp: +60") lands in the
  // TLD. When the site's own host plus a few letters is the whole domain and
  // those letters do not complete a real TLD (brand.co + m is brand.com), the
  // letters are that run-on text. A mailto value ends at its attribute quote,
  // so page text cannot run on into it.
  if (!fromMailto && siteHost && domain.length > siteHost.length && domain.startsWith(siteHost)) {
    const extra = domain.slice(siteHost.length);
    const lastLabel = domain.slice(domain.lastIndexOf(".") + 1);
    if (/^[a-z]+$/.test(extra) && !LONG_TLDS.has(lastLabel)) {
      domain = siteHost;
      email = `${email.slice(0, at)}@${domain}`;
    }
  }
  if (!fromMailto && RUN_ON_AFTER_GENERIC.test(domain)) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/.test(domain) || domain.includes("..")) return null;
  if (FILE_SUFFIX.test(domain)) return null;
  if (BLOCKED_DOMAIN_PARTS.some((part) => domain.includes(part))) return null;
  if (isPlaceholderDomain(domain)) return null;
  return email;
}

/**
 * Applies the current email filter and run-on-domain trim to an already-saved
 * email, using `pageUrl` (its source URL or the lead's website) for the site
 * host. Returns null when the email should be dropped.
 */
export function cleanStoredEmail(email: string, pageUrl?: string): string | null {
  return cleanEmail({ raw: email, fromMailto: false }, hostOf(pageUrl));
}

/**
 * Addresses from `mailto:` links and page text, including `[at]`/`(at)`/` at ` + `[dot]` forms, lower-cased and deduped.
 * `pageUrl` is the page's own address; it lets a domain that ran on past the site's host be trimmed back to it.
 */
export function extractEmails(html: string, pageUrl?: string): string[] {
  const siteHost = hostOf(pageUrl);
  const text = decodeEntities(html);
  const found: Found[] = [];
  for (const match of text.matchAll(/mailto:([^"'?#\s<>]{1,320})/gi)) {
    found.push({ raw: safeDecodeURI(match[1]!), fromMailto: true });
  }
  const plain = text
    .replace(SPACED_AT, (_m, local: string, domain: string) => `${local}@${domain.replace(new RegExp(DOT, "gi"), ".")}`)
    .replace(BRACKET_AT, "@")
    .replace(BRACKET_DOT, ".");
  for (const match of plain.matchAll(EMAIL)) {
    // A `mailto:` value was read above, whole; reading it again as text would trim it.
    if (plain.slice(Math.max(0, match.index - 7), match.index).toLowerCase() === "mailto:") continue;
    found.push({ raw: match[0], fromMailto: false });
  }

  const out: string[] = [];
  for (const item of found) {
    const email = cleanEmail(item, siteHost);
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Links

type Anchor = { href: string; text: string };

const ANCHOR_TEXT_LIMIT = 2000;

/**
 * Replaces every tag with a space and, when `dropCode` is set, drops the
 * contents of `<script>` and `<style>`. One forward pass with `indexOf`; an
 * unclosed tag ends the text instead of being rescanned from every `<`.
 */
function stripTags(html: string, dropCode = false): string {
  const lower = dropCode ? html.toLowerCase() : html;
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt), " ");
    const gt = html.indexOf(">", lt);
    if (gt < 0) break;
    i = gt + 1;
    if (!dropCode) continue;
    const name = /^(script|style)(?![a-z0-9-])/.exec(lower.slice(lt + 1, lt + 8))?.[1];
    if (!name) continue;
    const close = lower.indexOf(`</${name}`, i);
    const closeEnd = close < 0 ? -1 : lower.indexOf(">", close);
    i = closeEnd < 0 ? html.length : closeEnd + 1;
  }
  return out.join("");
}

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`, "i").exec(attrs);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim() : null;
}

/** `<a>` tags in document order, found with `indexOf` so unclosed tags cannot make the scan quadratic. */
function anchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  const lower = html.toLowerCase();
  let at = 0;
  for (;;) {
    const start = lower.indexOf("<a", at);
    if (start < 0) break;
    const next = lower[start + 2];
    at = start + 2;
    if (next === undefined || !/[\s/>]/.test(next)) continue;
    const tagEnd = lower.indexOf(">", start);
    if (tagEnd < 0) break;
    const href = attr(html.slice(start + 2, tagEnd), "href");
    // Link text ends at `</a`, the next `<a` or 2000 characters, whichever comes first.
    const window = lower.slice(tagEnd + 1, tagEnd + 1 + ANCHOR_TEXT_LIMIT);
    const ends = [window.indexOf("</a"), window.indexOf("<a")].filter((i) => i >= 0);
    const inner = html.slice(tagEnd + 1, tagEnd + 1 + (ends.length ? Math.min(...ends) : window.length));
    const text = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    if (href) out.push({ href, text });
    at = tagEnd + 1;
  }
  return out;
}

function resolveHttp(href: string, baseUrl: string): URL | null {
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

const NETWORK_HOSTS: Record<string, SocialNetwork> = {
  "instagram.com": "instagram",
  "facebook.com": "facebook",
  "fb.com": "facebook",
  "linkedin.com": "linkedin",
  "tiktok.com": "tiktok",
  "youtube.com": "youtube",
  "x.com": "x",
  "twitter.com": "x",
};
const NOT_A_PROFILE = /\/(sharer|share|intent\/|plugins\/|dialog\/)|^\/(watch|embed|p|reel|tr|login|home\.php)(\/|$)/i;

function networkOf(host: string): SocialNetwork | null {
  const bare = bareHost(host);
  if (NETWORK_HOSTS[bare]) return NETWORK_HOSTS[bare]!;
  if (bare.endsWith(".linkedin.com")) return "linkedin"; // country subdomains such as my.linkedin.com
  return null;
}

/** The first profile link per network; share, intent, plugin and dialog links are skipped. */
export function extractSocials(html: string, baseUrl: string): Socials {
  const out: Socials = { instagram: "", facebook: "", linkedin: "", tiktok: "", youtube: "", x: "" };
  for (const { href } of anchors(html)) {
    const url = resolveHttp(href, baseUrl);
    if (!url) continue;
    const network = networkOf(url.hostname);
    if (!network || out[network]) continue;
    if (url.pathname === "/" || NOT_A_PROFILE.test(url.pathname)) continue;
    out[network] = url.href;
  }
  return out;
}

/**
 * The targets of `tel:` links, in page order and deduped, with any `;ext=` or
 * other parameter dropped. Numbers that only appear in the page text are not
 * read: a wrong phone is worse than none.
 */
export function extractTelLinks(html: string): string[] {
  const out: string[] = [];
  for (const { href } of anchors(html)) {
    const match = /^tel:([^;?#]{1,40})/i.exec(href);
    if (!match) continue;
    const number = safeDecodeURI(match[1]!).replace(/\s+/g, " ").trim();
    if (number && !out.includes(number)) out.push(number);
  }
  return out;
}

const CONTACT_WORDS =
  /contact|about|hubungi|tentang|kontak|mengenai|pertanyaan|联系|聯繫|关于|關於|联络|聯絡|lianxi|guanyu|kefu|ติดต่อ|เกี่ยวกับ|สอบถาม|tittor|tidtor|tidthor|soptham|sobtham|liên[\s-]*hệ|giới[\s-]*thiệu|lien[\s-]*he|gioi[\s-]*thieu|contato|contacto|sobre|quem[\s-]*somos|fale[\s-]*conosco|fale[\s-]*connosco|acerca|quienes[\s-]*somos|quiénes[\s-]*somos|nosotros|nous[\s-]*contacter|contactez|a[\s-]*propos|à[\s-]*propos|apropos|qui[\s-]*sommes|kontakt|ueber[\s-]*uns|über[\s-]*uns|uber[\s-]*uns|impressum|お問い合わせ|会社概要|문의|연락처|소개|தொடர்பு/i;

const NON_PAGE_SUFFIX = /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif|tiff?|css|js|json|mp4|webm|woff2?|pdf|zip)$/i;

/** Non-overlapping inner `[start, end]` spans of `<tag ...>...</tag>` found in linear time. */
function findTagSpans(html: string, lower: string, tag: string): [number, number][] {
  const spans: [number, number][] = [];
  const openPrefix = `<${tag}`;
  const closePrefix = `</${tag}`;
  let at = 0;
  let depth = 0;
  let spanStart = -1;
  while (at < lower.length) {
    const lt = lower.indexOf("<", at);
    if (lt < 0) break;
    if (lower.startsWith(openPrefix, lt)) {
      const next = lower[lt + openPrefix.length];
      if (next !== undefined && /[\s/>]/.test(next)) {
        const gt = lower.indexOf(">", lt);
        if (gt < 0) break;
        if (depth === 0) spanStart = gt + 1;
        depth += 1;
        at = gt + 1;
        continue;
      }
    } else if (lower.startsWith(closePrefix, lt)) {
      const next = lower[lt + closePrefix.length];
      if (next !== undefined && /[\s>]/.test(next)) {
        const gt = lower.indexOf(">", lt);
        if (depth > 0) {
          depth -= 1;
          if (depth === 0 && spanStart >= 0) {
            spans.push([spanStart, lt]);
            spanStart = -1;
          }
        }
        if (gt < 0) break;
        at = gt + 1;
        continue;
      }
    }
    at = lt + 1;
  }
  if (depth > 0 && spanStart >= 0) spans.push([spanStart, html.length]);
  return spans;
}

function mergeSpans(spans: [number, number][]): [number, number][] {
  if (spans.length <= 1) return spans;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    const prev = merged[merged.length - 1]!;
    if (s <= prev[1]) prev[1] = Math.max(prev[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function navOrFooterLinks(html: string, base: URL): string[] {
  const lower = html.toLowerCase();
  const spans = mergeSpans([
    ...findTagSpans(html, lower, "nav"),
    ...findTagSpans(html, lower, "footer"),
  ]);
  const normPath = (p: string) => p.replace(/\/+$/, "") || "/";
  const baseHost = bareHost(base.hostname);
  const basePath = normPath(base.pathname);
  const seenPaths = new Set<string>();
  const out: string[] = [];
  for (const [start, end] of spans) {
    for (const { href } of anchors(html.slice(start, end))) {
      const url = resolveHttp(href, base.href);
      if (!url || bareHost(url.hostname) !== baseHost) continue;
      const pathKey = normPath(url.pathname);
      if (pathKey === basePath) continue;
      if (NON_PAGE_SUFFIX.test(url.pathname)) continue;
      if (seenPaths.has(pathKey)) continue;
      seenPaths.add(pathKey);
      out.push(url.href);
      if (out.length === 3) return out;
    }
  }
  return out;
}

/**
 * Up to three same-site links that look like contact or about pages.
 * When no contact or about word matches, falls back to up to three same-site
 * links from the page's `<nav>` or `<footer>`.
 */
export function contactLinks(html: string, baseUrl: string): string[] {
  const base = resolveHttp(baseUrl, baseUrl);
  if (!base) return [];
  const out: string[] = [];
  for (const { href, text } of anchors(html)) {
    const url = resolveHttp(href, base.href);
    if (!url || bareHost(url.hostname) !== bareHost(base.hostname) || url.href === base.href) continue;
    if (!CONTACT_WORDS.test(safeDecodeURI(url.pathname)) && !CONTACT_WORDS.test(text)) continue;
    if (!out.includes(url.href)) out.push(url.href);
    if (out.length === 3) break;
  }
  return out.length > 0 ? out : navOrFooterLinks(html, base);
}

// ---------------------------------------------------------------------------
// Identity check

function visibleText(html: string): string {
  return decodeEntities(stripTags(html, true)).normalize("NFC").toLowerCase();
}

const CJK_RUNS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_GENERIC_SUFFIXES = /(?:私人有限公司|股份有限公司|有限公司|株式会社|茶室|中心|集团|公司)$/;
const NON_CJK_TOKEN = /\p{L}{4,}/gu;

function tokenizeWords(text: string): string[] {
  return text.normalize("NFC").replace(CJK_RUNS, " ").toLowerCase().match(NON_CJK_TOKEN) ?? [];
}

function buildCountryTokens(locale: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  let dn: Intl.DisplayNames;
  try {
    dn = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
  } catch {
    return tokens;
  }
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const name = dn.of(String.fromCharCode(a, b));
      if (!name) continue;
      for (const token of tokenizeWords(name)) tokens.add(token);
    }
  }
  return tokens;
}

const ENGLISH_COUNTRY_TOKENS = buildCountryTokens("en");
const COUNTRY_TOKENS_BY_LOCALE = new Map<string, ReadonlySet<string>>([["en", ENGLISH_COUNTRY_TOKENS]]);

function countryTokensForLocale(locale: string): ReadonlySet<string> {
  const cached = COUNTRY_TOKENS_BY_LOCALE.get(locale);
  if (cached) return cached;
  const built = buildCountryTokens(locale);
  COUNTRY_TOKENS_BY_LOCALE.set(locale, built);
  return built;
}

function normalizeLanguage(locale: string | undefined): string | undefined {
  const trimmed = locale?.trim();
  if (!trimmed) return undefined;
  try {
    return new Intl.Locale(trimmed).language.toLowerCase();
  } catch {
    return undefined;
  }
}

function localeFromCountry(country: string | undefined): string | undefined {
  const code = country?.trim().toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(code)) return undefined;
  try {
    return new Intl.Locale(`und-${code}`).maximize().language.toLowerCase();
  } catch {
    return undefined;
  }
}

function htmlLang(html: string): string | undefined {
  const match = /<html\b[^>]{0,400}\blang\s*=\s*(?:"([^"]{2,35})"|'([^']{2,35})'|([^\s>]{2,35}))/i.exec(html.slice(0, 2000));
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim() || undefined;
}

function leadLocales(html: string, lead: Lead, opts?: { country?: string; locale?: string }): string[] {
  const out: string[] = [];
  const add = (lang: string | undefined) => {
    if (lang && lang !== "en" && !out.includes(lang)) out.push(lang);
  };
  add(normalizeLanguage(opts?.locale));
  add(localeFromCountry(opts?.country));
  if (!opts?.locale && !opts?.country) {
    const waDigits = lead.whatsapp?.startsWith("https://wa.me/") ? `+${lead.whatsapp.slice("https://wa.me/".length)}` : "";
    const cc = (lead.phone ? phoneCountry(lead.phone) : undefined) ?? (waDigits ? phoneCountry(waDigits) : undefined);
    add(localeFromCountry(cc));
  }
  add(normalizeLanguage(htmlLang(html)));
  return out;
}

const NON_DISTINCTIVE_NAME_TOKENS = new Set([
  "sendirian", "berhad", "enterprise", "enterprises", "holdings", "holding", "group",
  "company", "corp", "corporation", "limited", "incorporated", "gmbh", "sarl", "ltda", "eirl",
  "trading", "ventures", "associates", "partners", "resources", "industries", "services",
  "service", "solutions", "management", "international", "global", "national",
  "asia", "syarikat", "pusat", "perniagaan", "perusahaan", "kumpulan", "pengurusan",
  "acara", "events", "shop", "store", "kedai", "center", "centre", "digital", "online", "official",
  "domain", "parked", "welcome", "home", "page", "with", "from", "that", "this", "your",
  "plaza", "mall",
  // Street and neighbourhood words: English, Malay & Indonesian, Chinese pinyin, Thai, Vietnamese, Portuguese, Spanish, French, German.
  "street", "road", "avenue", "lane", "drive", "boulevard", "alley", "crescent", "terrace", "highway", "parkway",
  "jalan", "lorong", "persiaran", "lebuh", "lengkok", "simpang", "taman", "bandar", "kota", "kampung", "kampong",
  "gang", "desa", "kelurahan", "kecamatan",
  "dalu", "dadao", "jiedao", "hutong", "guangchang",
  "ถนน", "ซอย", "ตรอก", "หมู่บ้าน", "thanon", "muban",
  "đường", "duong", "phố", "pho", "ngõ", "ngo", "hẻm", "hem", "quận", "quan", "phường", "phuong",
  "rua", "avenida", "praça", "praca", "travessa", "alameda", "estrada", "largo", "rodovia", "bairro",
  "calle", "carrera", "paseo", "camino", "carretera", "pasaje", "ronda", "rambla",
  "rue", "chemin", "impasse", "allée", "allee", "quai", "faubourg", "quartier", "passage",
  "straße", "strasse", "platz", "gasse", "weg", "allee", "damm", "chaussee", "viertel",
]);

function distinctiveNameParts(lead: Lead, locales: readonly string[] = []): { tokens: string[]; cjk: string } {
  const title = (lead.title ?? "").trim();
  if (!title) return { tokens: [], cjk: "" };
  const cityTokens = new Set(tokenizeWords(lead.city ?? ""));
  const rawTokens = tokenizeWords(title);
  const countryTokenSets = [ENGLISH_COUNTRY_TOKENS, ...locales.map(countryTokensForLocale)];
  const tokens = [
    ...new Set(
      rawTokens.filter(
        (t) => !NON_DISTINCTIVE_NAME_TOKENS.has(t) && !cityTokens.has(t) && !countryTokenSets.some((set) => set.has(t)),
      ),
    ),
  ];

  const cjkRaw = (title.match(CJK_RUNS) ?? []).join("");
  let cjk = "";
  if (cjkRaw.length >= 2) {
    const stripped = cjkRaw.replace(CJK_GENERIC_SUFFIXES, "");
    cjk = stripped.length >= 2 ? cjkRaw : "";
  }
  return { tokens, cjk };
}

/**
 * True when the page shows the listing's phone (last seven digits, in text or
 * a `tel:` link), a word of four or more letters from its category, or its
 * business name (whole-word distinctive 4+ letter tokens — requiring two when
 * two or more exist — or the full CJK name). A lead with none of these cannot
 * be contradicted, so it counts as a match.
 */
export function matchesListing(html: string, lead: Lead, opts?: { country?: string; locale?: string }): boolean {
  const phoneDigits = (lead.phone ?? "").replace(/\D/g, "");
  const tail = phoneDigits.length >= 7 ? phoneDigits.slice(-7) : "";
  const categoryWords = tokenizeWords(lead.category ?? "");
  const { tokens: nameTokens, cjk } = distinctiveNameParts(lead, leadLocales(html, lead, opts));
  if (!tail && categoryWords.length === 0 && nameTokens.length === 0 && !cjk) return true;

  const text = visibleText(html);
  if (tail) {
    const telLinks = [...html.matchAll(/tel:([^"'\s<>]{1,40})/gi)].map((m) => m[1]).join(" ");
    const digits = `${text} ${telLinks}`.replace(/[\s\-().\/+ ]/g, "");
    if (digits.includes(tail)) return true;
  }
  if (categoryWords.some((word) => text.includes(word))) return true;
  if (nameTokens.length > 0) {
    const textWords = new Set(text.match(/\p{L}+/gu) ?? []);
    const hits = nameTokens.filter((token) => textWords.has(token)).length;
    if (hits >= (nameTokens.length >= 2 ? 2 : 1)) return true;
  }
  if (cjk && (text.includes(cjk) || text.replace(/\s+/g, "").includes(cjk))) return true;
  return false;
}
