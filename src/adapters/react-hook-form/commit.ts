import type { EntityKey, NodeId, StructureState } from "../../index.js";
import { childIdsPath, entityDataPath, entityPath, nodePath } from "./paths.js";

/**
 * One write to the form. The adapter only ever uses `setValue` (create or
 * update a path) and `unregister` (delete a removed node/entity and its
 * registered inputs); it never uses `useFieldArray` operations.
 */
export type FormWrite =
  | { readonly type: "set"; readonly name: string; readonly value: unknown }
  | { readonly type: "unregister"; readonly name: string };

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Minimal list of writes that turns the form value `previous` into `next`.
 * Only the affected paths are written: a moved node gets its `parentId` and
 * the two child lists are rewritten; its relationship and the entity data
 * (already in the form, typed by the user) are left alone.
 *
 * Creations and updates come first and deletions last, so a container
 * (`nodes`, `entities`) is never emptied in the middle of a commit.
 * `containers` tells whether `nodes` / `entities` currently exist as objects in
 * the form values (RHF drops an object once its last key is unregistered);
 * when one does not, it is written as a whole, so React Hook Form never turns
 * it into an array because the first key looks numeric.
 */
export function diffStructure<TEntity, TRelationship>(
  previous: StructureState<TEntity, TRelationship>,
  next: StructureState<TEntity, TRelationship>,
  containers: { readonly nodes: boolean; readonly entities: boolean },
): FormWrite[] {
  if (previous === next) return [];
  const writes: FormWrite[] = [];
  const deletions: FormWrite[] = [];

  if (previous.entities !== next.entities) {
    if (!containers.entities) {
      if (Object.keys(next.entities).length > 0) writes.push({ type: "set", name: "entities", value: next.entities });
    } else {
      for (const [key, record] of Object.entries(next.entities)) {
        const before = hasOwn(previous.entities, key) ? previous.entities[key] : undefined;
        if (before === undefined) writes.push({ type: "set", name: entityPath(key), value: record });
        else if (before !== record) writes.push({ type: "set", name: entityDataPath(key), value: record.data });
      }
      for (const key of Object.keys(previous.entities) as EntityKey[]) {
        if (!hasOwn(next.entities, key)) deletions.push({ type: "unregister", name: entityPath(key) });
      }
    }
  }

  if (previous.nodes !== next.nodes) {
    if (!containers.nodes) {
      if (Object.keys(next.nodes).length > 0) writes.push({ type: "set", name: "nodes", value: next.nodes });
    } else {
      for (const [id, node] of Object.entries(next.nodes)) {
        const before = hasOwn(previous.nodes, id) ? previous.nodes[id] : undefined;
        if (before === undefined) {
          writes.push({ type: "set", name: nodePath(id), value: node });
          continue;
        }
        if (before === node) continue;
        const base = nodePath(id);
        if (before.parentId !== node.parentId) writes.push({ type: "set", name: `${base}.parentId`, value: node.parentId });
        if (before.entityKey !== node.entityKey) writes.push({ type: "set", name: `${base}.entityKey`, value: node.entityKey });
        if (!sameList(before.childIds, node.childIds)) {
          writes.push({ type: "set", name: childIdsPath(id), value: [...node.childIds] });
        }
        // RHF compares with deepEqual before writing, so an unchanged relationship is a no-op.
        if (before.relationship !== node.relationship) {
          writes.push({ type: "set", name: `${base}.relationship`, value: node.relationship });
        }
      }
      for (const id of Object.keys(previous.nodes) as NodeId[]) {
        if (!hasOwn(next.nodes, id)) deletions.push({ type: "unregister", name: nodePath(id) });
      }
    }
  }

  if (!sameList(previous.rootIds, next.rootIds)) writes.push({ type: "set", name: "rootIds", value: [...next.rootIds] });
  return [...writes, ...deletions];
}

/** Ids and keys present in `next` but not in `previous`. */
export function addedSegments<TEntity, TRelationship>(
  previous: StructureState<TEntity, TRelationship>,
  next: StructureState<TEntity, TRelationship>,
): { nodeIds: NodeId[]; entityKeys: EntityKey[] } {
  return {
    nodeIds: next.nodes === previous.nodes ? [] : Object.keys(next.nodes).filter((id) => !hasOwn(previous.nodes, id)),
    entityKeys:
      next.entities === previous.entities
        ? []
        : Object.keys(next.entities).filter((key) => !hasOwn(previous.entities, key)),
  };
}
