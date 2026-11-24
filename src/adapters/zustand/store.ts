import { createStore, type StoreApi } from "zustand/vanilla";
import { resolveConfig } from "../../core/config.js";
import {
  addNode,
  createEmptyState,
  importStructure,
  InvalidStateError,
  moveNode,
  registerEntity,
  rekeyEntity,
  removeEntity,
  removeNode,
  updateEntity,
  updateRelationship,
  validateStructure,
  type AddNodeInput,
  type EntityKey,
  type EntityStructureConfig,
  type ImportStructureOptions,
  type ImportStructureResult,
  type MoveNodeInput,
  type NodeId,
  type OperationResult,
  type RekeyEntityInput,
  type RemoveEntityInput,
  type RemoveNodeInput,
  type StructureEvent,
  type StructureSnapshotV1,
  type StructureState,
  type UpdateEntityInput,
  type UpdateRelationshipInput,
  type ValidationResult,
} from "../../index.js";

/**
 * Store actions. Each one calls the matching pure core operation and only
 * calls `set` when it succeeds and actually produced a new state; on failure it
 * returns the errors and the store is not touched (no notification either).
 */
export interface EntityStructureActions<TEntity, TRelationship> {
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
  /**
   * Replaces the whole structure with a state that passes `validateStructure`.
   * On failure nothing changes.
   */
  replaceStructure(state: StructureState<TEntity, TRelationship>): ValidationResult;
  /** Imports a snapshot through `importStructure`; on failure nothing changes. */
  importSnapshot(data: unknown, options?: ImportStructureOptions): ImportStructureResult<TEntity, TRelationship>;
}

/** Shape of the Zustand store. `structure` is the core state and nothing else. */
export interface EntityStructureStoreState<TEntity, TRelationship> {
  /** Canonical core state; replaced (never mutated) on successful operations. */
  readonly structure: StructureState<TEntity, TRelationship>;
  /** Events of the last successful mutation (empty initially). */
  readonly lastEvents: readonly StructureEvent<TEntity, TRelationship>[];
  /** The configuration this store was created with (read by the selectors). */
  readonly config: EntityStructureConfig<TEntity, TRelationship>;
  readonly actions: EntityStructureActions<TEntity, TRelationship>;
}

export type EntityStructureStore<TEntity, TRelationship> = StoreApi<
  EntityStructureStoreState<TEntity, TRelationship>
>;

export interface CreateEntityStructureStoreOptions<TEntity, TRelationship> {
  readonly config: EntityStructureConfig<TEntity, TRelationship>;
  /**
   * Either a core `StructureState` (checked with `validateStructure`) or a
   * snapshot from `exportStructure` (loaded with `importStructure`). Invalid
   * data throws `InvalidStateError`. Empty structure when omitted.
   */
  readonly initialData?: StructureState<TEntity, TRelationship> | StructureSnapshotV1<TEntity, TRelationship>;
  /** Passed to `importStructure` when `initialData` is a snapshot. */
  readonly importOptions?: ImportStructureOptions;
}

function isSnapshot(data: object): boolean {
  return "version" in data;
}

function initialStructure<TEntity, TRelationship>(
  options: CreateEntityStructureStoreOptions<TEntity, TRelationship>,
): StructureState<TEntity, TRelationship> {
  const { config, initialData } = options;
  resolveConfig(config); // fail fast on an invalid configuration, like `createEntityStructure`
  if (initialData === undefined) return createEmptyState<TEntity, TRelationship>();
  if (isSnapshot(initialData)) {
    const imported = importStructure(initialData, config, options.importOptions);
    if (!imported.ok) throw new InvalidStateError(imported.errors);
    return imported.value.state;
  }
  const state = initialData as StructureState<TEntity, TRelationship>;
  const validation = validateStructure(state, config);
  if (!validation.valid) throw new InvalidStateError(validation.errors);
  return state;
}

/**
 * Creates an independent vanilla Zustand store over the pure core. Every call
 * returns a new store with its own state: there is no shared singleton.
 *
 * Use it in React with `useStore(store, selector)` from `zustand`.
 */
export function createEntityStructureStore<TEntity, TRelationship = unknown>(
  options: CreateEntityStructureStoreOptions<TEntity, TRelationship>,
): EntityStructureStore<TEntity, TRelationship> {
  const { config } = options;
  const structure = initialStructure(options);

  return createStore<EntityStructureStoreState<TEntity, TRelationship>>()((set, get) => {
    function apply<R extends OperationResult<TEntity, TRelationship, object>>(result: R): R {
      if (result.ok && result.value.state !== get().structure) {
        set({ structure: result.value.state, lastEvents: result.value.events });
      }
      return result;
    }

    const actions: EntityStructureActions<TEntity, TRelationship> = {
      registerEntity: (entity) => apply(registerEntity(get().structure, entity, config)),
      updateEntity: (input) => apply(updateEntity(get().structure, input, config)),
      rekeyEntity: (input) => apply(rekeyEntity(get().structure, input, config)),
      removeEntity: (input) =>
        apply(removeEntity(get().structure, typeof input === "string" ? { key: input } : input, config)),
      addNode: (input) => apply(addNode(get().structure, input, config)),
      removeNode: (input) =>
        apply(removeNode(get().structure, typeof input === "string" ? { nodeId: input } : input, config)),
      moveNode: (input) => apply(moveNode(get().structure, input, config)),
      updateRelationship: (input) => apply(updateRelationship(get().structure, input, config)),

      replaceStructure(state) {
        const validation = validateStructure(state, config);
        if (validation.valid && state !== get().structure) set({ structure: state, lastEvents: [] });
        return validation;
      },
      importSnapshot(data, importOptions) {
        const imported = importStructure(data, config, importOptions);
        if (imported.ok) set({ structure: imported.value.state, lastEvents: [] });
        return imported;
      },
    };

    return { structure, lastEvents: [], config, actions };
  });
}
