import { getOwn } from "./internal.js";
import type { NodeId, StructureNode, StructureState } from "./types.js";

type NodeSource<TRelationship> = (id: NodeId) => StructureNode<TRelationship> | undefined;

export function nodeSource<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
): NodeSource<TRelationship> {
  return (id) => getOwn(state.nodes, id);
}

/** Node ids from the root down to `nodeId` (inclusive). Iterative. */
export function pathTo<TRelationship>(getNode: NodeSource<TRelationship>, nodeId: NodeId): NodeId[] {
  const path: NodeId[] = [];
  const seen = new Set<NodeId>();
  let current = getNode(nodeId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current.id);
    current = current.parentId === null ? undefined : getNode(current.parentId);
  }
  return path.reverse();
}

/** `nodeId` and all its descendants, in pre-order. Iterative. */
export function collectSubtree<TRelationship>(
  getNode: NodeSource<TRelationship>,
  nodeId: NodeId,
): NodeId[] {
  const result: NodeId[] = [];
  const seen = new Set<NodeId>();
  const stack: NodeId[] = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    const node = getNode(id);
    if (node === undefined) continue;
    seen.add(id);
    result.push(id);
    for (let i = node.childIds.length - 1; i >= 0; i -= 1) {
      const childId = node.childIds[i];
      if (childId !== undefined) stack.push(childId);
    }
  }
  return result;
}

/** True when `ancestorId` is `nodeId` itself or one of its ancestors. */
export function isSelfOrAncestor<TRelationship>(
  getNode: NodeSource<TRelationship>,
  ancestorId: NodeId,
  nodeId: NodeId,
): boolean {
  const seen = new Set<NodeId>();
  let current = getNode(nodeId);
  while (current !== undefined && !seen.has(current.id)) {
    if (current.id === ancestorId) return true;
    seen.add(current.id);
    current = current.parentId === null ? undefined : getNode(current.parentId);
  }
  return false;
}
