// Splits a geocoded city's bounding box into sequential search cells so a
// whole-city run can get past Google Maps' ~100–120 place cap per search.

import type { GeoHit } from "./geocode.js";

const KM_PER_DEGREE = 111.32;
/** A tiny or point bounding box cannot be subdivided meaningfully. */
const MIN_SPLIT_DEG = 0.01;

export const BASE_ZOOM = 15;
export const DEFAULT_CELL_KM = 5;
export const MAX_BASE_CELLS = 25;
export const MAX_TOTAL_CELLS = 40;
export const MAX_SPLIT_DEPTH = 2;
/** Split a cell into four quadrants only when it approaches Google's single-search cap. */
export const CELL_SPLIT_THRESHOLD = 100;

export type GridCell = {
  lat: number;
  lon: number;
  latSpan: number;
  lonSpan: number;
  zoom: number;
  splitDepth: number;
};

export type BuildGridOptions = {
  cellKm?: number;
  maxCells?: number;
  zoom?: number;
};

/**
 * Covers `bbox` with a grid of cells ordered closest to `center` first. A box
 * that fits inside a single cell (or is a point) returns one cell centered on
 * `center` at `zoom`.
 */
export function buildGrid(
  bbox: GeoHit["bbox"],
  center: { lat: number; lon: number },
  opts: BuildGridOptions = {},
): GridCell[] {
  const cellKm = opts.cellKm ?? DEFAULT_CELL_KM;
  const maxCells = opts.maxCells ?? MAX_BASE_CELLS;
  const zoom = opts.zoom ?? BASE_ZOOM;

  const latSpan = Math.max(0, bbox.north - bbox.south);
  const lonSpan = Math.max(0, bbox.east - bbox.west);
  const midLat = (bbox.south + bbox.north) / 2;
  const cosLat = Math.max(0.01, Math.cos(midLat * (Math.PI / 180)));
  const heightKm = latSpan * KM_PER_DEGREE;
  const widthKm = lonSpan * KM_PER_DEGREE * cosLat;

  if (heightKm <= cellKm && widthKm <= cellKm) {
    return [{ lat: center.lat, lon: center.lon, latSpan, lonSpan, zoom, splitDepth: 0 }];
  }

  let stepKm = cellKm;
  let rows = Math.max(1, Math.ceil(heightKm / stepKm));
  let cols = Math.max(1, Math.ceil(widthKm / stepKm));
  if (rows * cols > maxCells) {
    stepKm = cellKm * Math.sqrt((rows * cols) / maxCells);
    rows = Math.max(1, Math.ceil(heightKm / stepKm));
    cols = Math.max(1, Math.ceil(widthKm / stepKm));
    while (rows * cols > maxCells) {
      stepKm *= 1.1;
      rows = Math.max(1, Math.ceil(heightKm / stepKm));
      cols = Math.max(1, Math.ceil(widthKm / stepKm));
    }
  }

  const cellLat = latSpan / rows;
  const cellLon = lonSpan / cols;
  const cells: GridCell[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = bbox.south + (r + 0.5) * cellLat;
    for (let c = 0; c < cols; c++) {
      const lon = bbox.west + (c + 0.5) * cellLon;
      cells.push({ lat, lon, latSpan: cellLat, lonSpan: cellLon, zoom, splitDepth: 0 });
    }
  }

  const dist = (c: GridCell) => Math.hypot(c.lat - center.lat, (c.lon - center.lon) * cosLat);
  cells.sort((a, b) => dist(a) - dist(b));
  return cells;
}

export function canSplitCell(cell: GridCell): boolean {
  return cell.splitDepth < MAX_SPLIT_DEPTH && cell.latSpan >= MIN_SPLIT_DEG && cell.lonSpan >= MIN_SPLIT_DEG;
}

/** Divides a saturated cell into four quadrant sub-cells at one tighter zoom level. */
export function splitCell(cell: GridCell): GridCell[] {
  if (!canSplitCell(cell)) return [];
  const halfLat = cell.latSpan / 2;
  const halfLon = cell.lonSpan / 2;
  const qLat = cell.latSpan / 4;
  const qLon = cell.lonSpan / 4;
  const next = { latSpan: halfLat, lonSpan: halfLon, zoom: cell.zoom + 1, splitDepth: cell.splitDepth + 1 };
  return [
    { lat: cell.lat - qLat, lon: cell.lon - qLon, ...next },
    { lat: cell.lat - qLat, lon: cell.lon + qLon, ...next },
    { lat: cell.lat + qLat, lon: cell.lon - qLon, ...next },
    { lat: cell.lat + qLat, lon: cell.lon + qLon, ...next },
  ];
}
