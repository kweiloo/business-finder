// The two ways a row links out: the place's website and a WhatsApp chat.
// Every row shows both, in that order; one that is missing is not a link.

import { chatHref, hasWhatsApp, websiteHref, websiteLabel, whatsappHref } from "../../../src/core/leads/contact.js";
import type { LeadRow } from "../types.js";

export { chatHref, hasWhatsApp, websiteHref, whatsappHref };

export type ContactLink = {
  href: string;
  /** The link's accessible name, which says which place it opens. */
  name: string;
  /** Where the link goes, for the hover hint: "clinica.test", "Facebook", "WhatsApp". */
  hint: string;
};

export function whatsappLink(lead: LeadRow): ContactLink | null {
  const href = whatsappHref(lead);
  return href ? { href, name: `WhatsApp ${lead.title}`, hint: "WhatsApp" } : null;
}

/**
 * The row's website. A chat link listed as the website is not a website (it
 * is the WhatsApp icon instead); a social profile is, and says which network.
 */
export function websiteLink(lead: LeadRow): ContactLink | null {
  const href = websiteHref(lead);
  if (!href) return null;
  const { text, network } = websiteLabel(href);
  const name = network ? `Open ${lead.title} on ${network}` : `Open ${lead.title}'s website`;
  return { href, name, hint: text };
}
