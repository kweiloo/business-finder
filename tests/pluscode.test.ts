import { describe, expect, it } from "vitest";
import { plusCode } from "../src/core/geo/pluscode.js";

describe("plusCode", () => {
  it("encodes a 10-digit Open Location Code", () => {
    expect(plusCode(47.36559, 8.524997)).toBe("8FVC9G8F+6X");
  });

  // Rows from open-location-code test_data/encoding.csv (code length 10).
  it.each([
    [20.3700625, 2.7821875, "7FG49QCJ+2V"],
    [-41.2730625, 174.7859375, "4VCPPQGP+Q9"],
    [-89.9999375, -179.9999375, "22222222+22"],
    [90, 1, "CFX3X2X2+X2"],
    [47.0000625, 728.0000625, "8FVC2222+22"],
    [-41.2730625, -905.2140625, "4VCPPQGP+Q9"],
    [1.2, 3.4, "6FH56C22+22"],
    // These two land one cell south without rounding away float noise.
    [66.89, -106, "95RPV2R2+22"],
    [48.64, 42.02, "8HW4J2RC+22"],
  ])("encodes %f, %f as %s", (lat, lon, code) => {
    expect(plusCode(lat, lon)).toBe(code);
  });

  it("returns an empty string for non-finite input", () => {
    expect(plusCode(Number.NaN, 1)).toBe("");
    expect(plusCode(1, Number.POSITIVE_INFINITY)).toBe("");
  });
});
