import { getOwn, ownValue, patchRecord } from "./internal.js";
import type {
  EntityKey,
  EntityRecord,
  NodeId,
  StructureNode,
  StructureState,
} from "./types.js";

/**
 * Copy-on-write builder for a candidate state. The base state is never
 * mutated, and untouched parts of it keep their references in the result.
 */
export class Draft<TEntity, TRelationship> {
  private readonly nodeChanges = new Map<NodeId, StructureNode<TRelationship> | undefined>();
  private readonly entityChanges = new Map<EntityKey, EntityRecord<TEntity> | undefined>();
  private rootIds: readonly NodeId[] | undefined;

  constructor(readonly base: StructureState<TEntity, TRelationship>) {}

  readonly getNode = (id: NodeId): StructureNode<TRelationship> | undefined =>
    this.nodeChanges.has(id) ? this.nodeChanges.get(id) : getOwn(this.base.nodes, id);

  getEntity(key: EntityKey): EntityRecord<TEntity> | undefined {
    return this.entityChanges.has(key) ? this.entityChanges.get(key) : getOwn(this.base.entities, key);
  }

  /** Stores a frozen node; its relationship is taken over with `ownValue`. */
  setNode(node: StructureNode<TRelationship>): StructureNode<TRelationship> {
    const stored = freezeNode(node);
    this.nodeChanges.set(stored.id, stored);
    return stored;
  }

  deleteNode(id: NodeId): void {
    this.nodeChanges.set(id, undefined);
  }

  /** Stores a frozen record; its data is taken over with `ownValue`. */
  setEntity(record: EntityRecord<TEntity>): EntityRecord<TEntity> {
    const stored = freezeRecord(record);
    this.entityChanges.set(stored.key, stored);
    return stored;
  }

  deleteEntity(key: EntityKey): void {
    this.entityChanges.set(key, undefined);
  }

  /** Children of `parentId`, or the roots when `parentId` is null. */
  childIds(parentId: NodeId | null): readonly NodeId[] {
    if (parentId === null) return this.rootIds ?? this.base.rootIds;
    return this.getNode(parentId)?.childIds ?? [];
  }

  setChildIds(parentId: NodeId | null, childIds: readonly NodeId[]): void {
    if (parentId === null) {
      this.rootIds = Object.isFrozen(childIds) ? childIds : Object.freeze(childIds.slice());
      return;
    }
    const parent = this.getNode(parentId);
    if (parent !== undefined) this.setNode({ ...parent, childIds });
  }

  hasChanges(): boolean {
    return this.nodeChanges.size > 0 || this.entityChanges.size > 0 || this.rootIds !== undefined;
  }

  build(): StructureState<TEntity, TRelationship> {
    if (!this.hasChanges()) return this.base;
    return Object.freeze({
      entities:
        this.entityChanges.size > 0
          ? Object.freeze(patchRecord(this.base.entities, this.entityChanges))
          : this.base.entities,
      nodes:
        this.nodeChanges.size > 0 ? Object.freeze(patchRecord(this.base.nodes, this.nodeChanges)) : this.base.nodes,
      rootIds: this.rootIds ?? this.base.rootIds,
    });
  }
}

/** Frozen copy of a record whose data is owned by the state (see `ownValue`). */
export function freezeRecord<TEntity>(record: EntityRecord<TEntity>): EntityRecord<TEntity> {
  if (Object.isFrozen(record) && Object.isFrozen(record.data)) return record;
  return Object.freeze({ key: record.key, data: ownValue(record.data) });
}

/** Frozen copy of a node (child list and relationship included). */
export function freezeNode<TRelationship>(node: StructureNode<TRelationship>): StructureNode<TRelationship> {
  if (Object.isFrozen(node) && Object.isFrozen(node.childIds) && Object.isFrozen(node.relationship)) return node;
  return Object.freeze({
    id: node.id,
    entityKey: node.entityKey,
    parentId: node.parentId,
    childIds: Object.isFrozen(node.childIds) ? node.childIds : Object.freeze(node.childIds.slice()),
    relationship: ownValue(node.relationship),
  });
}

/**
 * Returns `state` with every record, node and value frozen (copying only what
 * is not frozen yet). States built by the operations come back unchanged, by
 * reference; states from outside (`initialState`, imports) are taken over.
 */
export function freezeState<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
): StructureState<TEntity, TRelationship> {
  const entityChanges = new Map<EntityKey, EntityRecord<TEntity>>();
  for (const [key, record] of Object.entries(state.entities)) {
    const frozen = freezeRecord(record);
    if (frozen !== record) entityChanges.set(key, frozen);
  }
  const nodeChanges = new Map<NodeId, StructureNode<TRelationship>>();
  for (const [id, node] of Object.entries(state.nodes)) {
    const frozen = freezeNode(node);
    if (frozen !== node) nodeChanges.set(id, frozen);
  }
  const entities = entityChanges.size > 0 ? patchRecord(state.entities, entityChanges) : state.entities;
  const nodes = nodeChanges.size > 0 ? patchRecord(state.nodes, nodeChanges) : state.nodes;
  const rootIds = Object.isFrozen(state.rootIds) ? state.rootIds : Object.freeze(state.rootIds.slice());
  if (entities === state.entities && nodes === state.nodes && rootIds === state.rootIds && Object.isFrozen(state)) {
    return state;
  }
  return Object.freeze({ entities: Object.freeze(entities), nodes: Object.freeze(nodes), rootIds });
}
