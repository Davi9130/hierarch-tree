import { resolveConfig } from "./config.js";
import {
  rekeyEntity,
  removeEntity,
  updateEntity,
  type RekeyEntityInput,
  type RemoveEntityInput,
  type UpdateEntityInput,
} from "./entity-operations.js";
import { findByIdentity, findEntity, getAllEntities, hasEntity, registerEntity } from "./registry.js";
import {
  canRelate,
  getAllowedChildren,
  getAllowedParents,
  validateRelationship,
  type CompatibilityOptions,
} from "./rules.js";
import {
  findAllByIdentity,
  findByNodeId,
  findByPath,
  getAncestors,
  getChildren,
  getDepth,
  getDescendants,
  getOccurrences,
  getParent,
  getPath,
  getRoot,
  searchEntities,
  toTree,
} from "./search.js";
import { createEmptyState } from "./state.js";
import {
  addNode,
  moveNode,
  removeNode,
  updateRelationship,
  type AddNodeInput,
  type MoveNodeInput,
  type RemoveNodeInput,
  type UpdateRelationshipInput,
} from "./structure.js";
import type {
  EntityKey,
  EntityRecord,
  EntityStructureConfig,
  NodeId,
  OperationResult,
  StructureEvent,
  StructureNode,
  StructureState,
  TreeNode,
  ValidationError,
  ValidationResult,
} from "./types.js";
import { validateStructure } from "./validation.js";

/** Thrown by `createEntityStructure` when `initialState` fails validation. */
export class InvalidStateError extends Error {
  override readonly name = "InvalidStateError";
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Initial state is invalid: ${errors.map((error) => error.code).join(", ")}`);
  }
}

export type StructureListener<TEntity, TRelationship> = (
  state: StructureState<TEntity, TRelationship>,
  events: readonly StructureEvent<TEntity, TRelationship>[],
) => void;

export interface CreateEntityStructureOptions<TEntity, TRelationship> {
  /** Validated with `validateStructure`; throws `InvalidStateError` when invalid. */
  readonly initialState?: StructureState<TEntity, TRelationship>;
}

/**
 * Stateful wrapper around the pure operations. Each instance owns its state;
 * an operation that fails leaves it untouched. Results are the same
 * `OperationResult` values the pure functions return.
 */
export interface EntityStructure<TEntity, TRelationship> {
  readonly config: EntityStructureConfig<TEntity, TRelationship>;
  getState(): StructureState<TEntity, TRelationship>;
  /** Called after every successful mutation that changed the state. */
  subscribe(listener: StructureListener<TEntity, TRelationship>): () => void;

  registerEntity(entity: TEntity): OperationResult<TEntity, TRelationship, { key: EntityKey }>;
  updateEntity(input: UpdateEntityInput<TEntity>): OperationResult<TEntity, TRelationship>;
  rekeyEntity(input: RekeyEntityInput<TEntity>): OperationResult<TEntity, TRelationship, { key: EntityKey }>;
  removeEntity(input: EntityKey | RemoveEntityInput): OperationResult<TEntity, TRelationship>;
  addNode(
    input: AddNodeInput<TEntity, TRelationship>,
  ): OperationResult<TEntity, TRelationship, { nodeId: NodeId; entityKey: EntityKey }>;
  removeNode(input: NodeId | RemoveNodeInput): OperationResult<TEntity, TRelationship>;
  moveNode(input: MoveNodeInput): OperationResult<TEntity, TRelationship>;
  updateRelationship(input: UpdateRelationshipInput<TRelationship>): OperationResult<TEntity, TRelationship>;

  findEntity(key: EntityKey): EntityRecord<TEntity> | undefined;
  hasEntity(key: EntityKey): boolean;
  getAllEntities(): EntityRecord<TEntity>[];
  findByIdentity(value: unknown): EntityRecord<TEntity> | undefined;
  findAllByIdentity(value: unknown): StructureNode<TRelationship>[];
  getOccurrences(key: EntityKey): StructureNode<TRelationship>[];
  findByNodeId(nodeId: NodeId): StructureNode<TRelationship> | undefined;
  findByPath(path: readonly EntityKey[]): StructureNode<TRelationship> | undefined;
  searchEntities(predicate: (entity: TEntity, key: EntityKey) => boolean): EntityRecord<TEntity>[];
  getParent(nodeId: NodeId): StructureNode<TRelationship> | undefined;
  getChildren(nodeId: NodeId | null): StructureNode<TRelationship>[];
  getAncestors(nodeId: NodeId): StructureNode<TRelationship>[];
  getDescendants(nodeId: NodeId): StructureNode<TRelationship>[];
  getRoot(nodeId: NodeId): StructureNode<TRelationship> | undefined;
  getDepth(nodeId: NodeId): number | undefined;
  getPath(nodeId: NodeId): NodeId[];
  toTree(rootId?: NodeId): TreeNode<TEntity, TRelationship>[];

  validateStructure(options?: { readonly context?: unknown }): ValidationResult;
  validateRelationship(parent: TEntity, child: TEntity, options?: CompatibilityOptions<TRelationship>): ValidationResult;
  canRelate(parent: TEntity, child: TEntity, options?: CompatibilityOptions<TRelationship>): boolean;
  getAllowedChildren(parentKey: EntityKey, options?: CompatibilityOptions<TRelationship>): EntityRecord<TEntity>[];
  getAllowedParents(childKey: EntityKey, options?: CompatibilityOptions<TRelationship>): EntityRecord<TEntity>[];
}

export function createEntityStructure<TEntity, TRelationship = unknown>(
  config: EntityStructureConfig<TEntity, TRelationship>,
  options: CreateEntityStructureOptions<TEntity, TRelationship> = {},
): EntityStructure<TEntity, TRelationship> {
  resolveConfig(config); // fail fast on invalid configuration
  let state = options.initialState ?? createEmptyState<TEntity, TRelationship>();
  if (options.initialState !== undefined) {
    const validation = validateStructure(state, config);
    if (!validation.valid) throw new InvalidStateError(validation.errors);
  }
  const listeners = new Set<StructureListener<TEntity, TRelationship>>();

  function apply<R extends OperationResult<TEntity, TRelationship, object>>(result: R): R {
    if (result.ok && result.value.state !== state) {
      state = result.value.state;
      for (const listener of [...listeners]) listener(state, result.value.events);
    }
    return result;
  }

  return {
    config,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    registerEntity: (entity) => apply(registerEntity(state, entity, config)),
    updateEntity: (input) => apply(updateEntity(state, input, config)),
    rekeyEntity: (input) => apply(rekeyEntity(state, input, config)),
    removeEntity: (input) => apply(removeEntity(state, typeof input === "string" ? { key: input } : input, config)),
    addNode: (input) => apply(addNode(state, input, config)),
    removeNode: (input) => apply(removeNode(state, typeof input === "string" ? { nodeId: input } : input, config)),
    moveNode: (input) => apply(moveNode(state, input, config)),
    updateRelationship: (input) => apply(updateRelationship(state, input, config)),

    findEntity: (key) => findEntity(state, key),
    hasEntity: (key) => hasEntity(state, key),
    getAllEntities: () => getAllEntities(state),
    findByIdentity: (value) => findByIdentity(state, value, config),
    findAllByIdentity: (value) => findAllByIdentity(state, value, config),
    getOccurrences: (key) => getOccurrences(state, key),
    findByNodeId: (nodeId) => findByNodeId(state, nodeId),
    findByPath: (path) => findByPath(state, path),
    searchEntities: (predicate) => searchEntities(state, predicate),
    getParent: (nodeId) => getParent(state, nodeId),
    getChildren: (nodeId) => getChildren(state, nodeId),
    getAncestors: (nodeId) => getAncestors(state, nodeId),
    getDescendants: (nodeId) => getDescendants(state, nodeId),
    getRoot: (nodeId) => getRoot(state, nodeId),
    getDepth: (nodeId) => getDepth(state, nodeId),
    getPath: (nodeId) => getPath(state, nodeId),
    toTree: (rootId) => toTree(state, rootId),

    validateStructure: (validationOptions) => validateStructure(state, config, validationOptions),
    validateRelationship: (parent, child, compatibility) => validateRelationship(parent, child, config, compatibility),
    canRelate: (parent, child, compatibility) => canRelate(parent, child, config, compatibility),
    getAllowedChildren: (parentKey, compatibility) => getAllowedChildren(state, parentKey, config, compatibility),
    getAllowedParents: (childKey, compatibility) => getAllowedParents(state, childKey, config, compatibility),
  };
}
