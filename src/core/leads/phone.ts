// Phone normalisation. The "max" metadata build is required: the smaller
// builds cannot tell mobile numbers from fixed lines, so getType() would be
// undefined and no number would ever get a WhatsApp link.
import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
  type PhoneNumber,
} from "libphonenumber-js/max";

function parse(raw: string, country: string): PhoneNumber | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const region = country.trim().toUpperCase();
  const defaultCountry: CountryCode | undefined = isSupportedCountry(region) ? region : undefined;
  const number = parsePhoneNumberFromString(text, defaultCountry);
  return number?.isValid() ? number : undefined;
}

/**
 * Converts a phone number to E.164 (`+60123456789`). National numbers are
 * read in `country` (ISO 3166-1 alpha-2); numbers written with a leading `+`
 * are read as-is. Returns null when the text is not a valid number.
 */
export function toE164(raw: string, country: string): string | null {
  return parse(raw, country)?.number ?? null;
}

/**
 * Returns `https://wa.me/<digits>` when the number is a mobile number (type
 * MOBILE or FIXED_LINE_OR_MOBILE), and an empty string otherwise.
 */
export function whatsappLink(raw: string, country: string): string {
  const number = parse(raw, country);
  if (!number) return "";
  const type = number.getType();
  if (type !== "MOBILE" && type !== "FIXED_LINE_OR_MOBILE") return "";
  return `https://wa.me/${number.number.slice(1)}`;
}

/** ISO 3166-1 alpha-2 country of an international phone number, if it parses cleanly. */
export function phoneCountry(raw: string): string | undefined {
  const text = raw.trim();
  if (!text.startsWith("+")) return undefined;
  return parsePhoneNumberFromString(text)?.country;
}
