import { normalizeIdentity } from "./identity.js";
import { getOwn } from "./internal.js";
import { collectSubtree, nodeSource, pathTo } from "./tree.js";
import type {
  EntityKey,
  EntityRecord,
  EntityStructureConfig,
  NodeId,
  StructureNode,
  StructureState,
  TreeNode,
} from "./types.js";

/** Occurrence lookup by node id. */
export function findByNodeId<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  nodeId: NodeId,
): StructureNode<TRelationship> | undefined {
  return getOwn(state.nodes, nodeId);
}

/** Every node in pre-order, roots first. Iterative. */
function preorder<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
): StructureNode<TRelationship>[] {
  const getNode = nodeSource(state);
  const result: StructureNode<TRelationship>[] = [];
  for (const rootId of state.rootIds) {
    for (const id of collectSubtree(getNode, rootId)) {
      const node = getNode(id);
      if (node !== undefined) result.push(node);
    }
  }
  return result;
}

/** All occurrences of a registered key, in pre-order. */
export function getOccurrences<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  key: EntityKey,
): StructureNode<TRelationship>[] {
  return preorder(state).filter((node) => node.entityKey === key);
}

/**
 * All occurrences (nodes) of an identity, normalizing the raw value. Use
 * `findByIdentity` for the central record instead.
 */
export function findAllByIdentity<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  value: unknown,
  config: EntityStructureConfig<TEntity, TRelationship>,
): StructureNode<TRelationship>[] {
  const key = normalizeIdentity(value, config);
  return key.ok ? getOccurrences(state, key.value) : [];
}

/**
 * Follows a path of entity keys from the roots, e.g. `["company-a", "person-x"]`,
 * returning the first matching node.
 */
export function findByPath<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  path: readonly EntityKey[],
): StructureNode<TRelationship> | undefined {
  const getNode = nodeSource(state);
  let candidates: readonly NodeId[] = state.rootIds;
  let found: StructureNode<TRelationship> | undefined;
  for (const key of path) {
    found = undefined;
    for (const id of candidates) {
      const node = getNode(id);
      if (node?.entityKey === key) {
        found = node;
        break;
      }
    }
    if (found === undefined) return undefined;
    candidates = found.childIds;
  }
  return found;
}

/** Central records matching a predicate. */
export function searchEntities<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  predicate: (entity: TEntity, key: EntityKey) => boolean,
): EntityRecord<TEntity>[] {
  return Object.values(state.entities).filter((record) => predicate(record.data, record.key));
}

export function getParent<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  nodeId: NodeId,
): StructureNode<TRelationship> | undefined {
  const parentId = getOwn(state.nodes, nodeId)?.parentId;
  return parentId == null ? undefined : getOwn(state.nodes, parentId);
}

export function getChildren<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  nodeId: NodeId | null,
): StructureNode<TRelationship>[] {
  const ids = nodeId === null ? state.rootIds : (getOwn(state.nodes, nodeId)?.childIds ?? []);
  const result: StructureNode<TRelationship>[] = [];
  for (const id of ids) {
    const node = getOwn(state.nodes, id);
    if (node !== undefined) result.push(node);
  }
  return result;
}

/** Ancestors from the nearest parent up to the root. */
export function getAncestors<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  nodeId: NodeId,
): StructureNode<TRelationship>[] {
  return getPathNodes(state, nodeId).slice(0, -1).reverse();
}

/** Descendants in pre-order (excluding the node itself). */
export function getDescendants<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  nodeId: NodeId,
): StructureNode<TRelationship>[] {
  const getNode = nodeSource(state);
  return collectSubtree(getNode, nodeId)
    .slice(1)
    .map((id) => getNode(id))
    .filter((node): node is StructureNode<TRelationship> => node !== undefined);
}

export function getRoot<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  nodeId: NodeId,
): StructureNode<TRelationship> | undefined {
  return getPathNodes(state, nodeId)[0];
}

/** Depth of a node (roots are 0), or `undefined` for unknown nodes. */
export function getDepth<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  nodeId: NodeId,
): number | undefined {
  const path = getPath(state, nodeId);
  return path.length === 0 ? undefined : path.length - 1;
}

/** Node ids from the root down to `nodeId` (empty for unknown nodes). */
export function getPath<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  nodeId: NodeId,
): NodeId[] {
  return pathTo(nodeSource(state), nodeId);
}

function getPathNodes<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  nodeId: NodeId,
): StructureNode<TRelationship>[] {
  return getPath(state, nodeId)
    .map((id) => getOwn(state.nodes, id))
    .filter((node): node is StructureNode<TRelationship> => node !== undefined);
}

/** Derived nested view of the structure (or of one subtree). Iterative. */
export function toTree<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  rootId?: NodeId,
): TreeNode<TEntity, TRelationship>[] {
  type Mutable = {
    id: NodeId;
    entityKey: EntityKey;
    entity: TEntity;
    relationship: TRelationship;
    children: Mutable[];
  };
  const getNode = nodeSource(state);
  const make = (node: StructureNode<TRelationship>): Mutable | undefined => {
    const record = getOwn(state.entities, node.entityKey);
    return record === undefined
      ? undefined
      : { id: node.id, entityKey: node.entityKey, entity: record.data, relationship: node.relationship, children: [] };
  };
  const roots: Mutable[] = [];
  const stack: { id: NodeId; into: Mutable[] }[] = [];
  const starts = rootId === undefined ? state.rootIds : [rootId];
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const id = starts[i];
    if (id !== undefined) stack.push({ id, into: roots });
  }
  const seen = new Set<NodeId>();
  // Children are pushed in reverse, so popping preserves order; `into` lists
  // receive items in pre-order, which keeps sibling order intact.
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined || seen.has(frame.id)) continue;
    seen.add(frame.id);
    const node = getNode(frame.id);
    const item = node === undefined ? undefined : make(node);
    if (node === undefined || item === undefined) continue;
    frame.into.push(item);
    for (let i = node.childIds.length - 1; i >= 0; i -= 1) {
      const childId = node.childIds[i];
      if (childId !== undefined) stack.push({ id: childId, into: item.children });
    }
  }
  return roots;
}
