// Finds places that share one phone number. Two listings with the same phone
// are often one business listed twice under different names, but sometimes
// two real businesses behind one switchboard, so both rows are kept and each
// is only flagged with the other's title for the user to decide.

import type { Lead } from "../types.js";

/** Phones are compared by their digits; anything shorter is not a phone. */
const MIN_DIGITS = 6;

function phoneKey(phone: string | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= MIN_DIGITS ? digits : null;
}

/**
 * For each lead, in order, the titles of the other leads with the same phone
 * (`[]` when none). Phones match on their digits, so `06-283 0000` and
 * `062830000` are the same number; a national and an international spelling
 * of one number do not match.
 */
export function samePhoneAs(leads: readonly Lead[]): string[][] {
  const byPhone = new Map<string, number[]>();
  leads.forEach((lead, i) => {
    const key = phoneKey(lead.phone);
    if (key === null) return;
    const group = byPhone.get(key);
    if (group) group.push(i);
    else byPhone.set(key, [i]);
  });
  return leads.map((lead, i) => {
    const key = phoneKey(lead.phone);
    const group = key === null ? [] : (byPhone.get(key) ?? []);
    return group.filter((j) => j !== i).map((j) => leads[j]!.title);
  });
}

/** How many leads share their phone with at least one other lead. */
export function countSamePhone(leads: readonly Lead[]): number {
  return samePhoneAs(leads).filter((others) => others.length > 0).length;
}
