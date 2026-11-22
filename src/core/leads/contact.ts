// Shared contact-link predicates and URL display helpers.
// Imports nothing from Node or the DOM so the server, CLI and web UI share
// the exact same rules for what counts as a website or a WhatsApp link.

/** Scraped URLs are only linked when they are plain web addresses. */
export function safeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A short, readable form of a URL: host and path without `www.` or a trailing slash. */
export function shortUrl(href: string): string {
  const url = new URL(href);
  const path = url.pathname.replace(/\/+$/, "");
  return url.hostname.replace(/^www\./, "") + path;
}

/** Hosts (without `www.`/`m.`) whose links open a WhatsApp chat. The one list both the label and the chat icon read. */
export const WHATSAPP_HOSTS = ["wa.me", "api.whatsapp.com", "whatsapp.com"] as const;

// Host (without `www.`/`m.`) -> the network name shown instead of the address.
const NETWORKS: Record<string, string> = {
  ...Object.fromEntries(WHATSAPP_HOSTS.map((host) => [host, "WhatsApp"])),
  "facebook.com": "Facebook",
  "fb.com": "Facebook",
  "fb.me": "Facebook",
  "instagram.com": "Instagram",
  "linkedin.com": "LinkedIn",
  "tiktok.com": "TikTok",
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "x.com": "X",
  "twitter.com": "X",
  "linktr.ee": "Linktree",
};

/** The network a link belongs to ("WhatsApp", "Facebook", ...), or null for any other site. */
export function networkOf(href: string): string | null {
  const host = new URL(href).hostname.toLowerCase().replace(/^(www|m|web|mobile)\./, "");
  return NETWORKS[host] ?? null;
}

/**
 * What a website link says. A business website shows its short address; a
 * WhatsApp chat or a social profile listed as the website shows the network's
 * name, so the column does not pass a Facebook page off as a website.
 */
export function websiteLabel(href: string): { text: string; network: string | null } {
  const network = networkOf(href);
  return { text: network ?? shortUrl(href), network };
}

/**
 * A web address (http or https) that opens a WhatsApp chat. It reads the same
 * host list as the website label, so a link labelled WhatsApp is always the
 * WhatsApp icon.
 */
export function chatHref(value: string | null | undefined): string | null {
  const href = safeHref(value);
  return href && networkOf(href) === "WhatsApp" ? href : null;
}

export type ContactLike = {
  phone?: string | null;
  whatsapp?: string | null;
  emails?: readonly string[] | null;
  website?: string | null;
};

/**
 * The row's WhatsApp chat: its WhatsApp link, or a website field that is
 * really a chat link. The header count, filter and row icon all read this.
 */
export function whatsappHref(lead: Pick<ContactLike, "whatsapp" | "website">): string | null {
  return chatHref(lead.whatsapp) ?? chatHref(lead.website);
}

export function hasWhatsApp(lead: Pick<ContactLike, "whatsapp" | "website">): boolean {
  return whatsappHref(lead) !== null;
}

/** A real website link (not a WhatsApp chat link stored in the website field). */
export function websiteHref(lead: Pick<ContactLike, "website">): string | null {
  const href = safeHref(lead.website);
  return href && !chatHref(href) ? href : null;
}

export function hasWebsite(lead: Pick<ContactLike, "website">): boolean {
  return websiteHref(lead) !== null;
}

export function hasEmail(lead: Pick<ContactLike, "emails">): boolean {
  return (lead.emails?.length ?? 0) > 0;
}

export function hasPhone(lead: Pick<ContactLike, "phone">): boolean {
  return typeof lead.phone === "string" && lead.phone.trim() !== "";
}
