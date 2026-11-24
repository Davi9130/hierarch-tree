import { useFormContext, useWatch, type Control, type FieldValues } from "react-hook-form";
import type { EntityKey, NodeId } from "../../index.js";
import type { StructureFormValues } from "./use-entity-structure-form.js";
import { entityDataPath, nodePath, relationshipPath } from "./paths.js";

/** One child occurrence, with the form paths that address its values. */
export interface StructureChild {
  /** Occurrence id (`node.id`): use it as the React `key`. */
  readonly nodeId: NodeId;
  /** Identity of the central record (`entity.key`). */
  readonly entityKey: EntityKey;
  readonly index: number;
  /** `nodes.<nodeId>` */
  readonly path: `nodes.${string}`;
  /** `nodes.<nodeId>.relationship`: this occurrence's own link data. */
  readonly relationshipPath: `nodes.${string}.relationship`;
  /** `entities.<entityKey>.data`: shared by every occurrence of the entity. */
  readonly entityPath: `entities.${string}.data`;
}

export interface UseStructureChildrenOptions<TEntity, TRelationship> {
  /** Defaults to the control of the surrounding `FormProvider`. */
  readonly control?: Control<StructureFormValues<TEntity, TRelationship>>;
}

/**
 * Children of `parentId` (the roots when `null`), read from
 * `nodes.<parentId>.childIds` / `rootIds` with `useWatch`. The component
 * re-renders when that list (or a child's `entityKey`) changes, and not when
 * values elsewhere change. Recursion is plain component recursion: render
 * the children of each child with the same hook.
 */
export function useStructureChildren<TEntity = unknown, TRelationship = unknown>(
  parentId: NodeId | null,
  options: UseStructureChildrenOptions<TEntity, TRelationship> = {},
): StructureChild[] {
  const context = useFormContext() as ReturnType<typeof useFormContext> | null;
  const control = (options.control ?? context?.control) as Control<FieldValues> | undefined;
  if (control === undefined) {
    throw new Error("useStructureChildren needs a `control` option or a surrounding <FormProvider>.");
  }
  const listName = parentId === null ? "rootIds" : `nodes.${parentId}.childIds`;
  const watchedIds: unknown = useWatch({ control, name: listName });
  const childIds: NodeId[] = Array.isArray(watchedIds) ? watchedIds.filter((id) => typeof id === "string") : [];
  const watchedKeys: unknown = useWatch({ control, name: childIds.map((id) => `nodes.${id}.entityKey`) });
  const entityKeys: unknown[] = Array.isArray(watchedKeys) ? watchedKeys : [];

  const children: StructureChild[] = [];
  childIds.forEach((nodeId, index) => {
    const entityKey = entityKeys[index];
    if (typeof entityKey !== "string") return; // node already unregistered in this render
    children.push({
      nodeId,
      entityKey,
      index,
      path: nodePath(nodeId),
      relationshipPath: relationshipPath(nodeId),
      entityPath: entityDataPath(entityKey),
    });
  });
  return children;
}
