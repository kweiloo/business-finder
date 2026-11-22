// Classifies extracted email addresses as generic (role/group inboxes such as
// info@ or sales@), personal (two-part separated name-like local parts such as
// first.last, first_last, or first-last), or not_sure (single words or
// unrecognised addresses that do not clearly look like a person's name).
// Imports nothing from Node or the DOM so the backend and web UI share it.

import type { EmailMxStatus } from "./mx.js";

export type EmailType = "generic" | "personal" | "not_sure";

/** Plain-language label for an email type on the list page. */
export function emailTypeLabel(type: EmailType): string {
  if (type === "generic") return "shared inbox";
  if (type === "personal") return "a person's address";
  return "not sure";
}

/** Plain-language label for an email type in CSV/Excel exports; empty when unknown. */
export function emailTypeCsvLabel(type: unknown): string {
  if (type === "generic") return "shared inbox";
  if (type === "personal") return "a person's address";
  if (type === "not_sure") return "not sure";
  return "";
}

/** Plain-language label for an email domain's mail-server status on the list page. */
export function emailMxLabel(mx: EmailMxStatus | undefined): string | null {
  if (mx === "ok") return "address can receive mail";
  if (mx === "no mail server") return "cannot receive mail";
  if (mx === "unknown") return "could not check mail";
  return null;
}

/** Plain-language yes/no label for `Can receive mail` in CSV/Excel exports; empty when unknown. */
export function emailMxCsvLabel(mx: unknown): string {
  if (mx === "ok") return "yes";
  if (mx === "no mail server") return "no";
  return "";
}

/** Fixed list of generic/role local-part prefixes (lowercased, without +tags). */
export const GENERIC_EMAIL_PREFIXES = [
  // English
  "info",
  "sales",
  "hello",
  "hi",
  "hey",
  "admin",
  "administrator",
  "enquiry",
  "enquiries",
  "inquiry",
  "inquiries",
  "booking",
  "bookings",
  "reservation",
  "reservations",
  "reserve",
  "contact",
  "contactus",
  "contact-us",
  "support",
  "help",
  "helpdesk",
  "service",
  "services",
  "office",
  "mail",
  "email",
  "general",
  "reception",
  "frontdesk",
  "team",
  "staff",
  "orders",
  "order",
  "billing",
  "accounts",
  "accounting",
  "finance",
  "invoice",
  "invoices",
  "hr",
  "careers",
  "jobs",
  "recruitment",
  "marketing",
  "media",
  "press",
  "pr",
  "partners",
  "partnership",
  "partnerships",
  "feedback",
  "complaints",
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "webmaster",
  "postmaster",
  "hostmaster",
  "abuse",
  "security",
  "privacy",
  "legal",
  "compliance",
  "newsletter",
  "news",
  "events",
  "shop",
  "store",
  "appointment",
  "appointments",
  "concierge",
  "customercare",
  "customerservice",
  "customer-service",
  "customer.service",
  // Malay & Indonesian
  "pertanyaan",
  "jualan",
  "tempahan",
  "pentadbir",
  "hubungi",
  "hubungikami",
  "hubungi-kami",
  "khidmat",
  "khidmatpelanggan",
  "pelanggan",
  "bantuan",
  "sokongan",
  "pejabat",
  "akaun",
  "kewangan",
  "kerjaya",
  "jawatan",
  "pemasaran",
  "aduan",
  "maklumbalas",
  "pengurusan",
  "helo",
  "kontak",
  "penjualan",
  "pemesanan",
  "reservasi",
  "dukungan",
  "layanan",
  "keuangan",
  "akuntansi",
  "kantor",
  "karir",
  "lowongan",
  "rekrutmen",
  "humas",
  "pengaduan",
  "halo",
  "sekretariat",
  // Chinese pinyin
  "kefu",
  "lianxi",
  "zixun",
  "xiaoshou",
  "yewu",
  "shangwu",
  "hezuo",
  "fuwu",
  "shouhou",
  "yuyue",
  "yuding",
  "dingdan",
  "caiwu",
  "renshi",
  "zhaopin",
  "shichang",
  "tousu",
  "fankui",
  "bangongshi",
  "nihao",
  "gongsi",
  // Thai (romanized)
  "tittor",
  "tidtor",
  "tidthor",
  "soptham",
  "sobtham",
  "borikan",
  "lookkha",
  "lukkha",
  "chuayluea",
  "banchi",
  "karnngoen",
  "kanngoen",
  "samakngan",
  "bukkhon",
  "talad",
  "sawadee",
  "sawasdee",
  // Vietnamese (romanized)
  "lienhe",
  "lien-he",
  "hotro",
  "cskh",
  "tuvan",
  "kinhdoanh",
  "banhang",
  "datban",
  "datlich",
  "datphong",
  "dichvu",
  "khachhang",
  "ketoan",
  "taichinh",
  "nhansu",
  "tuyendung",
  "vanphong",
  "xinchao",
  "gopy",
  "khieunai",
  // Portuguese & Spanish
  "geral",
  "contato",
  "atendimento",
  "contacto",
  "ventas",
  "vendas",
  "comercial",
  "reservas",
  "suporte",
  "ajuda",
  "financeiro",
  "contabilidade",
  "faturacao",
  "faturamento",
  "rh",
  "carreiras",
  "vagas",
  "emprego",
  "imprensa",
  "parcerias",
  "ouvidoria",
  "sac",
  "administracao",
  "secretaria",
  "orcamento",
  "orcamentos",
  "pedidos",
  "clientes",
  "loja",
  "eventos",
  "atencion",
  "soporte",
  "ayuda",
  "hola",
  "consultas",
  "administracion",
  "facturacion",
  "contabilidad",
  "finanzas",
  "rrhh",
  "empleo",
  "prensa",
  "tienda",
  "oficina",
  "reclamos",
  "sugerencias",
  "informacion",
  // French
  "bonjour",
  "salut",
  "accueil",
  "assistance",
  "aide",
  "ventes",
  "commande",
  "commandes",
  "facturation",
  "comptabilite",
  "compta",
  "recrutement",
  "carrieres",
  "emploi",
  "presse",
  "partenariat",
  "partenariats",
  "direction",
  "secretariat",
  "courrier",
  "serviceclient",
  "service-client",
  "sav",
  "boutique",
  "evenements",
  "demande",
  "renseignements",
  // German
  "kontakt",
  "hallo",
  "anfrage",
  "anfragen",
  "verkauf",
  "vertrieb",
  "buchung",
  "buchungen",
  "reservierung",
  "reservierungen",
  "termin",
  "termine",
  "kundenservice",
  "kundendienst",
  "hilfe",
  "buero",
  "buro",
  "verwaltung",
  "buchhaltung",
  "rechnungen",
  "finanzen",
  "karriere",
  "bewerbung",
  "personal",
  "bestellung",
  "bestellungen",
  "empfang",
  "allgemein",
  "praxis",
  "kanzlei",
  "zentrale",
  "impressum",
] as const;

const GENERIC_PREFIX_SET: ReadonlySet<string> = new Set(GENERIC_EMAIL_PREFIXES);

const NON_NAME_WORDS = new Set([
  "company", "business", "corp", "group", "studio", "agency", "digital", "online", "official",
  "global", "solutions", "management", "event", "hotel", "hotels", "cafe", "clinic", "dental",
  "florist", "travel", "tours", "design", "creative", "tech", "systems", "academy", "school",
  "center", "centre", "house", "club", "syarikat", "kedai", "restoran", "pusat", "test",
  "user", "name", "you", "your", "sample", "demo", "example", "web", "site", "app", "dev",
  "api", "bot", "auto", "system", "server", "root", "host", "domain", "www", "works",
  "ventures", "labs", "print", "gifts", "wedding", "planner", "bakery", "flowers", "kitchen",
  "photography",
]);

const PUBLIC_MAIL_HOSTS = new Set([
  "gmail", "googlemail", "yahoo", "ymail", "hotmail", "outlook", "live", "msn", "icloud", "me",
  "aol", "proton", "protonmail", "zoho", "gmx", "mail", "com", "net", "org", "edu", "gov",
]);

function domainBrandLabels(domain: string): Set<string> {
  const labels = new Set<string>();
  for (const part of domain.split(".")) {
    if (part.length >= 3 && !PUBLIC_MAIL_HOSTS.has(part)) labels.add(part);
  }
  return labels;
}

function isNameLike(base: string, domain: string): boolean {
  if (!/^[a-z]{1,20}[._-][a-z]{2,20}$/.test(base)) return false;
  const brandLabels = domainBrandLabels(domain);
  const [first, last] = base.split(/[._-]/) as [string, string];
  const bad = (w: string) => GENERIC_PREFIX_SET.has(w) || NON_NAME_WORDS.has(w) || brandLabels.has(w);
  return !bad(first) && !bad(last);
}

/**
 * Classifies an email address as `"generic"` (role/group prefix, ignoring case
 * and `+tags`), `"personal"` (two-part separated local part such as `first.last`,
 * `first_last`, or `first-last`), or `"not_sure"` when neither clearly applies.
 */
export function classifyEmail(email: string): EmailType {
  const normalized = email.trim().toLowerCase();
  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@")) return "not_sure";
  const domain = normalized.slice(at + 1);
  if (!domain.includes(".")) return "not_sure";
  const local = normalized.slice(0, at);
  const plus = local.indexOf("+");
  const base = plus >= 0 ? local.slice(0, plus) : local;
  if (!base) return "not_sure";
  if (GENERIC_PREFIX_SET.has(base)) return "generic";
  return isNameLike(base, domain) ? "personal" : "not_sure";
}
