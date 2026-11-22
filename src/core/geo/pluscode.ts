// Open Location Code ("plus code") encoding, 10 digits: about 14 × 14 m.
// Follows the reference algorithm and its integer arithmetic from
// github.com/google/open-location-code, so float input such as 1.2 lands in
// the same cell as the published test vectors.

const ALPHABET = "23456789CFGHJMPQRVWX";
const BASE = 20;
const PAIRS = 5;
/** Cells per degree at 10 digits: 20^3. */
const PAIR_PRECISION = 8000;
/** The reference works at 15-digit precision, then drops the grid digits. */
const LAT_GRID = 5 ** 5;
const LNG_GRID = 4 ** 5;
const FINAL_LAT_PRECISION = PAIR_PRECISION * LAT_GRID;
const FINAL_LNG_PRECISION = PAIR_PRECISION * LNG_GRID;

/** Scales and floors `degrees`, rounding away float noise below 1e-6 of a cell. */
const toInt = (degrees: number, precision: number) => Math.floor(Math.round(degrees * precision * 1e6) / 1e6);

/** The 10-digit plus code (`XXXXXXXX+XX`) for a point, or `""` for non-finite input. */
export function plusCode(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";

  let latInt = toInt(Math.min(90, Math.max(-90, lat)) + 90, FINAL_LAT_PRECISION);
  // The north pole belongs to the topmost cell.
  latInt = Math.min(latInt, 180 * FINAL_LAT_PRECISION - 1);
  const lngSpan = 360 * FINAL_LNG_PRECISION;
  let lngInt = toInt(lon + 180, FINAL_LNG_PRECISION) % lngSpan;
  if (lngInt < 0) lngInt += lngSpan;

  latInt = Math.floor(latInt / LAT_GRID);
  lngInt = Math.floor(lngInt / LNG_GRID);

  const digits: string[] = [];
  for (let i = 0; i < PAIRS; i++) {
    digits.unshift(ALPHABET[lngInt % BASE]!);
    digits.unshift(ALPHABET[latInt % BASE]!);
    latInt = Math.floor(latInt / BASE);
    lngInt = Math.floor(lngInt / BASE);
  }
  return `${digits.slice(0, 8).join("")}+${digits.slice(8).join("")}`;
}
