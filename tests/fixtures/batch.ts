// Builds synthetic Google Maps result batches for tests. Values are written at
// the same index paths the parser reads, so no real business data is needed.

import {
  ENTRIES_INDEX,
  FIELD_PATHS,
  IMAGE_GALLERIES,
  LIST_PATHS,
  STRUCTURED_PATHS,
  type FieldName,
  type ListFieldName,
  type StructuredFieldName,
} from "../../src/core/sources/browser/fields.js";

/**
 * Scalar fields take a value; list fields take the raw list (items of any
 * type); structured fields take the raw value written at their path, and
 * `galleries` the raw item lists, in `IMAGE_GALLERIES` order.
 */
type SyntheticPlace = Partial<Record<FieldName, string | number>> &
  Partial<Record<ListFieldName, unknown[]>> &
  Partial<Record<StructuredFieldName, unknown>> & { galleries?: unknown[][] };

const PATHS: Record<string, number[]> = { ...FIELD_PATHS, ...LIST_PATHS, ...STRUCTURED_PATHS };

function setPath(root: unknown[], path: readonly number[], value: unknown): void {
  let node = root;
  path.forEach((index, depth) => {
    if (depth === path.length - 1) {
      node[index] = value;
      return;
    }
    if (!Array.isArray(node[index])) node[index] = [];
    node = node[index] as unknown[];
  });
}

/** Returns a `)]}'`-prefixed batch body holding one entry per place. */
export function makeBatch(places: SyntheticPlace[]): string {
  const entries = places.map(({ galleries = [], ...place }) => {
    const entity: unknown[] = [];
    galleries.forEach((items, i) => {
      const gallery = IMAGE_GALLERIES[i];
      if (gallery) setPath(entity, gallery.path, items);
    });
    // Lists are written first so a scalar inside one (category at [13, 0]) wins.
    const fields = Object.entries(place).sort(([a], [b]) => Number(b in LIST_PATHS) - Number(a in LIST_PATHS));
    for (const [field, value] of fields) {
      const path = PATHS[field];
      if (path) setPath(entity, path, Array.isArray(value) ? [...value] : value);
    }
    return [null, entity];
  });
  const data: unknown[] = [];
  data[ENTRIES_INDEX] = entries;
  return `)]}'\n${JSON.stringify(data)}`;
}
