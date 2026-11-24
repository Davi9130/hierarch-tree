import { resolveConfig } from "./config.js";
import { Draft } from "./draft.js";
import { coreError } from "./errors.js";
import { resolveIdentity } from "./identity.js";
import { getOwn, hasOwn, insertAt, without } from "./internal.js";
import { failure, finish, resolveIndex } from "./operation.js";
import { collectSubtree, isSelfOrAncestor, nodeSource } from "./tree.js";
import type {
  EntityKey,
  EntityStructureConfig,
  NodeId,
  OperationResult,
  StructureEvent,
  StructureNode,
  StructureState,
} from "./types.js";

interface OperationContext {
  /** Auxiliary data forwarded to relationship predicates and validators. */
  readonly context?: unknown;
}

export type AddNodeInput<TEntity, TRelationship> = OperationContext & {
  /** Parent occurrence; `null`/omitted adds a root node. */
  readonly parentId?: NodeId | null;
  readonly relationship: TRelationship;
  /** Position among the siblings; omitted = append. */
  readonly index?: number;
} & (
    | {
        /** Registered automatically when its identity is new; reused otherwise. */
        readonly entity: TEntity;
        readonly entityKey?: never;
      }
    | {
        /** Must already be registered. */
        readonly entityKey: EntityKey;
        readonly entity?: never;
      }
  );

/**
 * Adds an occurrence of an entity. When `entity` is given and its identity
 * already exists, the central record is reused unchanged (use `updateEntity`
 * to change its data).
 */
export function addNode<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  input: AddNodeInput<TEntity, TRelationship>,
  config: EntityStructureConfig<TEntity, TRelationship>,
): OperationResult<TEntity, TRelationship, { nodeId: NodeId; entityKey: EntityKey }> {
  const resolved = resolveConfig(config);
  const draft = new Draft(state);
  const events: StructureEvent<TEntity, TRelationship>[] = [];
  const parentId = input.parentId ?? null;
  if (parentId !== null && !hasOwn(state.nodes, parentId)) {
    return failure(coreError("PARENT_NOT_FOUND", `Parent node "${parentId}" does not exist.`, { nodeId: parentId }));
  }

  let entityKey: EntityKey;
  const registered: EntityKey[] = [];
  if (input.entityKey !== undefined) {
    entityKey = input.entityKey;
    if (!hasOwn(state.entities, entityKey)) {
      return failure(coreError("ENTITY_NOT_FOUND", `Entity "${entityKey}" is not registered.`, { entityKey }));
    }
  } else {
    const identity = resolveIdentity(input.entity, config);
    if (!identity.ok) return identity;
    entityKey = identity.value;
    if (!hasOwn(state.entities, entityKey)) {
      draft.setEntity({ key: entityKey, data: input.entity });
      registered.push(entityKey);
      events.push({ type: "ENTITY_REGISTERED", key: entityKey, entity: input.entity });
    }
  }

  const siblings = draft.childIds(parentId);
  const index = resolveIndex(input.index, siblings.length);
  if (!index.ok) return failure(index.error);

  const nodeId = resolved.createId();
  if (typeof nodeId !== "string" || nodeId === "") {
    return failure(coreError("INVALID_NODE_ID", "`createId` must return a non-empty string."));
  }
  if (hasOwn(state.nodes, nodeId)) {
    return failure(coreError("NODE_ID_COLLISION", `Node id "${nodeId}" already exists.`, { nodeId }));
  }

  draft.setNode({ id: nodeId, entityKey, parentId, childIds: [], relationship: input.relationship });
  draft.setChildIds(parentId, insertAt(siblings, index.value, nodeId));
  events.push({ type: "NODE_ADDED", nodeId, entityKey, parentId, index: index.value });

  return finish(
    draft,
    { nodeIds: [nodeId], entityKeys: registered },
    events,
    config,
    "addNode",
    input.context,
    { nodeId, entityKey },
  );
}

export type RemoveNodeInput = OperationContext & {
  readonly nodeId: NodeId;
  /**
   * `"cascade"` (default) removes the descendants too. `"reparent"` moves the
   * direct children to `reparentTo` (default: the removed node's parent).
   */
  readonly children?: "cascade" | "reparent";
  readonly reparentTo?: NodeId | null;
};

/**
 * Removes an occurrence. The central entity is kept, except under the
 * `"when-unreferenced"` removal policy when this was its last occurrence.
 */
export function removeNode<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  input: RemoveNodeInput,
  config: EntityStructureConfig<TEntity, TRelationship>,
): OperationResult<TEntity, TRelationship> {
  const node = getOwn(state.nodes, input.nodeId);
  if (node === undefined) {
    return failure(coreError("NODE_NOT_FOUND", `Node "${input.nodeId}" does not exist.`, { nodeId: input.nodeId }));
  }
  const draft = new Draft(state);
  const events: StructureEvent<TEntity, TRelationship>[] = [];
  const dirty: NodeId[] = [];

  if ((input.children ?? "cascade") === "cascade") {
    removeSubtrees(draft, [node.id], events);
    if (node.parentId !== null) dirty.push(node.parentId);
  } else {
    const target = input.reparentTo === undefined ? node.parentId : input.reparentTo;
    if (target !== null) {
      if (!hasOwn(state.nodes, target)) {
        return failure(coreError("PARENT_NOT_FOUND", `Target node "${target}" does not exist.`, { nodeId: target }));
      }
      if (isSelfOrAncestor(nodeSource(state), node.id, target)) {
        return failure(
          coreError("CYCLE_DETECTED", `Cannot reparent children of "${node.id}" into its own subtree.`, {
            nodeId: node.id,
            details: { reparentTo: target },
          }),
        );
      }
    }
    const parentList = draft.childIds(node.parentId);
    const position = parentList.indexOf(node.id);
    draft.setChildIds(node.parentId, without(parentList, node.id));
    const targetList = draft.childIds(target);
    const insertAtIndex = target === node.parentId ? position : targetList.length;
    const nextTarget = targetList.slice();
    nextTarget.splice(insertAtIndex, 0, ...node.childIds);
    draft.setChildIds(target, nextTarget);
    node.childIds.forEach((childId, offset) => {
      const child = draft.getNode(childId);
      if (child === undefined) return;
      draft.setNode({ ...child, parentId: target });
      events.push({
        type: "NODE_MOVED",
        nodeId: childId,
        from: { parentId: node.id, index: offset },
        to: { parentId: target, index: insertAtIndex + offset },
      });
      dirty.push(...collectSubtree(draft.getNode, childId));
    });
    draft.deleteNode(node.id);
    events.push({ type: "NODE_REMOVED", nodeId: node.id, entityKey: node.entityKey, parentId: node.parentId, node });
    if (target !== null) dirty.push(target);
    if (node.parentId !== null) dirty.push(node.parentId);
  }

  if (resolveConfig(config).entityRemoval === "when-unreferenced") {
    collectUnreferenced(draft, events);
  }
  return finish(draft, { nodeIds: dirty }, events, config, "removeNode", input.context, {});
}

export type MoveNodeInput = OperationContext & {
  readonly nodeId: NodeId;
  /** `null` moves the node to the roots. */
  readonly newParentId: NodeId | null;
  /** Position in the destination list after the move; omitted = append. */
  readonly index?: number;
};

/** Moves an occurrence (with its descendants) to a new parent or position. */
export function moveNode<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  input: MoveNodeInput,
  config: EntityStructureConfig<TEntity, TRelationship>,
): OperationResult<TEntity, TRelationship> {
  const node = getOwn(state.nodes, input.nodeId);
  if (node === undefined) {
    return failure(coreError("NODE_NOT_FOUND", `Node "${input.nodeId}" does not exist.`, { nodeId: input.nodeId }));
  }
  const target = input.newParentId;
  if (target !== null) {
    if (!hasOwn(state.nodes, target)) {
      return failure(coreError("PARENT_NOT_FOUND", `Target node "${target}" does not exist.`, { nodeId: target }));
    }
    if (isSelfOrAncestor(nodeSource(state), node.id, target)) {
      return failure(
        coreError("CYCLE_DETECTED", `Cannot move "${node.id}" into itself or its own descendants.`, {
          nodeId: node.id,
          details: { newParentId: target },
        }),
      );
    }
  }
  const draft = new Draft(state);
  const sourceList = draft.childIds(node.parentId);
  const fromIndex = sourceList.indexOf(node.id);
  draft.setChildIds(node.parentId, without(sourceList, node.id));
  const targetList = draft.childIds(target);
  const index = resolveIndex(input.index, targetList.length);
  if (!index.ok) return failure(index.error);
  if (target === node.parentId && index.value === fromIndex) {
    return { ok: true, value: { state, events: [], warnings: [] } };
  }
  draft.setChildIds(target, insertAt(targetList, index.value, node.id));
  const moved = draft.getNode(node.id);
  if (moved !== undefined) draft.setNode({ ...moved, parentId: target });

  const dirty = collectSubtree(draft.getNode, node.id);
  if (node.parentId !== null) dirty.push(node.parentId);
  if (target !== null) dirty.push(target);
  return finish(
    draft,
    { nodeIds: dirty },
    [
      {
        type: "NODE_MOVED",
        nodeId: node.id,
        from: { parentId: node.parentId, index: fromIndex },
        to: { parentId: target, index: index.value },
      },
    ],
    config,
    "moveNode",
    input.context,
    {},
  );
}

export type UpdateRelationshipInput<TRelationship> = OperationContext & {
  readonly nodeId: NodeId;
  readonly relationship: TRelationship;
};

/** Replaces the relationship metadata of one occurrence. */
export function updateRelationship<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  input: UpdateRelationshipInput<TRelationship>,
  config: EntityStructureConfig<TEntity, TRelationship>,
): OperationResult<TEntity, TRelationship> {
  const node = getOwn(state.nodes, input.nodeId);
  if (node === undefined) {
    return failure(coreError("NODE_NOT_FOUND", `Node "${input.nodeId}" does not exist.`, { nodeId: input.nodeId }));
  }
  const draft = new Draft(state);
  draft.setNode({ ...node, relationship: input.relationship });
  return finish(
    draft,
    { nodeIds: [node.id] },
    [{ type: "RELATIONSHIP_UPDATED", nodeId: node.id, previous: node.relationship, next: input.relationship }],
    config,
    "updateRelationship",
    input.context,
    {},
  );
}

// ---------------------------------------------------------------------------
// Internal helpers shared with entity operations
// ---------------------------------------------------------------------------

/** Removes each subtree (root first, pre-order) and detaches it from its parent. */
export function removeSubtrees<TEntity, TRelationship>(
  draft: Draft<TEntity, TRelationship>,
  rootIds: readonly NodeId[],
  events: StructureEvent<TEntity, TRelationship>[],
): void {
  for (const rootId of rootIds) {
    const root = draft.getNode(rootId);
    if (root === undefined) continue; // already removed with an earlier subtree
    draft.setChildIds(root.parentId, without(draft.childIds(root.parentId), rootId));
    for (const id of collectSubtree(draft.getNode, rootId)) {
      const node: StructureNode<TRelationship> | undefined = draft.getNode(id);
      if (node === undefined) continue;
      draft.deleteNode(id);
      events.push({ type: "NODE_REMOVED", nodeId: id, entityKey: node.entityKey, parentId: node.parentId, node });
    }
  }
}

/** Removes entities left without occurrences by the removals recorded in `events`. */
function collectUnreferenced<TEntity, TRelationship>(
  draft: Draft<TEntity, TRelationship>,
  events: StructureEvent<TEntity, TRelationship>[],
): void {
  const candidates = new Set<EntityKey>();
  for (const event of events) if (event.type === "NODE_REMOVED") candidates.add(event.entityKey);
  if (candidates.size === 0) return;
  const state = draft.build();
  for (const node of Object.values(state.nodes)) candidates.delete(node.entityKey);
  for (const key of candidates) {
    const record = draft.getEntity(key);
    if (record === undefined) continue;
    draft.deleteEntity(key);
    events.push({ type: "ENTITY_REMOVED", key, entity: record.data });
  }
}
