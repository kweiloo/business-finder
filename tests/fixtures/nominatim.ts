// Trimmed Nominatim answers captured 2026-11-17
// (format=jsonv2&limit=5&addressdetails=1): geographic facts only.

import type { GeoHit } from "../../src/core/geo/geocode.js";

export type Capture = [name: string, addresstype: string, lat: number, lon: number, bbox: [number, number, number, number], cc: string];

export function hit([name, addresstype, lat, lon, [south, north, west, east], countryCode]: Capture): GeoHit {
  return { name, addresstype, lat, lon, countryCode, bbox: { south, north, west, east } };
}

/** The same capture as Nominatim sends it: strings for numbers, a lowercase country code. */
export function raw([name, addresstype, lat, lon, bbox, cc]: Capture) {
  return { name, addresstype, lat: String(lat), lon: String(lon), boundingbox: bbox.map(String), address: { country_code: cc.toLowerCase() } };
}

export const MELAKA_STATE: Capture = ["Melaka", "state", 2.3293744, 102.2880962, [1.8395347, 2.4990483, 101.8327984, 102.5943828], "MY"];
export const MELAKA_CITY: Capture = ["Bandaraya Melaka", "city", 2.1942647, 102.2486651, [2.0342647, 2.3542647, 102.0886651, 102.4086651], "MY"];
export const SG_COUNTRY: Capture = ["Singapore", "country", 1.357107, 103.8194992, [1.1266175, 1.5143183, 103.5655797, 104.5712337], "SG"];
export const SG_CITY: Capture = ["Singapore", "city", 1.2899175, 103.8519072, [1.1266175, 1.4787511, 103.5655797, 104.1305702], "SG"];
export const KUALA_LUMPUR: Capture = ["Kuala Lumpur", "state", 3.1516964, 101.6942371, [3.0333979, 3.2445538, 101.615139, 101.7584948], "MY"];
export const PENANG: Capture = ["Pulau Pinang", "state", 5.4065013, 100.2559077, [5.1220035, 5.5856779, 100.1749755, 100.5503059], "MY"];
export const SELANGOR: Capture = ["Selangor", "state", 3.2083304, 101.304146, [2.4045722, 3.870432, 100.3875093, 101.9698147], "MY"];
export const JB_TOWN: Capture = ["Johor Bahru", "town", 1.4581986, 103.7649059, [1.4181986, 1.4981986, 103.7249059, 103.8049059], "MY"];
export const JB_DISTRICT: Capture = ["Johor Bahru", "district", 1.5366667, 103.7205556, [1.3293552, 1.6718625, 103.5355497, 104.0233064], "MY"];
export const BANGSAR_RAIL: Capture = ["KJ16 Bangsar", "railway", 3.1276122, 101.6790987, [3.1276122, 3.1276122, 101.6790987, 101.6790987], "MY"];
export const BANGSAR_SUBURB: Capture = ["Bangsar", "suburb", 3.13083, 101.66944, [3.13083, 3.13083, 101.66944, 101.66944], "MY"];
export const CALIFORNIA: Capture = ["California", "state", 36.7014631, -118.755997, [32.528832, 42.009518, -124.482003, -114.131211], "US"];
export const BANGKOK: Capture = ["Bangkok", "city", 13.7524938, 100.4935089, [13.494, 13.955, 100.327, 100.938], "TH"];
