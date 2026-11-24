import type { StructureState } from "./types.js";

/** Creates a new, empty state. Each call returns independent objects. */
export function createEmptyState<TEntity, TRelationship>(): StructureState<
  TEntity,
  TRelationship
> {
  return { entities: {}, nodes: {}, rootIds: [] };
}
