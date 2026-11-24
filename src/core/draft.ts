import { getOwn, patchRecord } from "./internal.js";
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

  setNode(node: StructureNode<TRelationship>): void {
    this.nodeChanges.set(node.id, node);
  }

  deleteNode(id: NodeId): void {
    this.nodeChanges.set(id, undefined);
  }

  setEntity(record: EntityRecord<TEntity>): void {
    this.entityChanges.set(record.key, record);
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
      this.rootIds = childIds;
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
    return {
      entities:
        this.entityChanges.size > 0
          ? patchRecord(this.base.entities, this.entityChanges)
          : this.base.entities,
      nodes: this.nodeChanges.size > 0 ? patchRecord(this.base.nodes, this.nodeChanges) : this.base.nodes,
      rootIds: this.rootIds ?? this.base.rootIds,
    };
  }
}
