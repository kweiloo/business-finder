import { describe, expect, it } from "vitest";
import { BASE_ZOOM, buildGrid, canSplitCell, MAX_BASE_CELLS, MAX_SPLIT_DEPTH, splitCell } from "../src/core/geo/grid.js";
import { BANGSAR_SUBURB, hit, JB_TOWN, KUALA_LUMPUR, SG_CITY } from "./fixtures/nominatim.js";

describe("buildGrid", () => {
  it("returns one cell centered on the place for a tiny or point bbox", () => {
    const bangsar = hit(BANGSAR_SUBURB);
    const pointCells = buildGrid(bangsar.bbox, { lat: bangsar.lat, lon: bangsar.lon });
    expect(pointCells).toHaveLength(1);
    expect(pointCells[0]).toMatchObject({ lat: bangsar.lat, lon: bangsar.lon, zoom: BASE_ZOOM, splitDepth: 0 });
    expect(canSplitCell(pointCells[0]!)).toBe(false);

    const tinyBox = { south: 3.13, north: 3.14, west: 101.66, east: 101.67 };
    const tinyCells = buildGrid(tinyBox, { lat: 3.135, lon: 101.665 });
    expect(tinyCells).toHaveLength(1);
    expect(tinyCells[0]).toMatchObject({ lat: 3.135, lon: 101.665, zoom: BASE_ZOOM, splitDepth: 0 });
  });

  it("covers a city bbox with multiple cells ordered closest to the center first", () => {
    const kl = hit(KUALA_LUMPUR);
    const cells = buildGrid(kl.bbox, { lat: kl.lat, lon: kl.lon });
    expect(cells.length).toBeGreaterThan(4);
    expect(cells.length).toBeLessThanOrEqual(MAX_BASE_CELLS);
    for (const cell of cells) {
      expect(cell.lat).toBeGreaterThanOrEqual(kl.bbox.south);
      expect(cell.lat).toBeLessThanOrEqual(kl.bbox.north);
      expect(cell.lon).toBeGreaterThanOrEqual(kl.bbox.west);
      expect(cell.lon).toBeLessThanOrEqual(kl.bbox.east);
      expect(cell.zoom).toBe(BASE_ZOOM);
    }
    const dist = (c: (typeof cells)[number]) => Math.hypot(c.lat - kl.lat, c.lon - kl.lon);
    expect(dist(cells[0]!)).toBeLessThanOrEqual(dist(cells.at(-1)!));
  });

  it("caps base cells for very large city boxes like Singapore", () => {
    const sg = hit(SG_CITY);
    const cells = buildGrid(sg.bbox, { lat: sg.lat, lon: sg.lon });
    expect(cells.length).toBeLessThanOrEqual(MAX_BASE_CELLS);
    expect(cells.length).toBeGreaterThan(4);
  });

  it("produces 4 cells for a ~9x9 km town like Johor Bahru", () => {
    const jb = hit(JB_TOWN);
    const cells = buildGrid(jb.bbox, { lat: jb.lat, lon: jb.lon });
    expect(cells).toHaveLength(4);
    expect(cells.every((c) => canSplitCell(c))).toBe(true);
  });
});

describe("splitCell", () => {
  it("splits a cell into four quadrants at zoom + 1 up to MAX_SPLIT_DEPTH", () => {
    const kl = hit(KUALA_LUMPUR);
    const [root] = buildGrid(kl.bbox, { lat: kl.lat, lon: kl.lon });
    expect(canSplitCell(root!)).toBe(true);

    const children = splitCell(root!);
    expect(children).toHaveLength(4);
    for (const child of children) {
      expect(child.zoom).toBe(root!.zoom + 1);
      expect(child.splitDepth).toBe(1);
      expect(child.latSpan).toBeCloseTo(root!.latSpan / 2, 6);
      expect(child.lonSpan).toBeCloseTo(root!.lonSpan / 2, 6);
    }

    let deep = root!;
    for (let i = 0; i < MAX_SPLIT_DEPTH; i++) {
      deep = splitCell(deep)[0]!;
    }
    expect(deep.splitDepth).toBe(MAX_SPLIT_DEPTH);
    expect(canSplitCell(deep)).toBe(false);
    expect(splitCell(deep)).toEqual([]);
  });
});
