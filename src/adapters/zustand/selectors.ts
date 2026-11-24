import {
  findByNodeId,
  findEntity,
  getChildren,
  getOccurrences,
  normalizeIdentity,
  type EntityKey,
  type EntityRecord,
  type NodeId,
  type StructureNode,
  type StructureState,
} from "../../index.js";
import type { EntityStructureActions, EntityStructureStoreState } from "./store.js";

/**
 * Selectors for `useStore(store, selector)` / `store.getState()`.
 *
 * Every selector returns the same reference while the data it reads has not
 * changed, so it is safe to pass the result of a selector factory inline
 * (`useStore(store, selectChildren(id))`) without `useShallow`: list results
 * are cached per store and reused whenever their items are the same nodes.
 */
export type StoreSelector<TEntity, TRelationship, TResult> = (
  state: EntityStructureStoreState<TEntity, TRelationship>,
) => TResult;

const EMPTY: readonly never[] = Object.freeze([]);

interface ListCache<T> {
  /** Inputs the result was computed from (identity-compared). */
  readonly inputs: readonly unknown[];
  readonly result: readonly T[];
}

// One cache per store, keyed by its `actions` object (stable for the store's
// lifetime), so independent stores never share cached results.
const caches = new WeakMap<object, Map<string, ListCache<unknown>>>();

function cacheFor(actions: EntityStructureActions<unknown, unknown>): Map<string, ListCache<unknown>> {
  let cache = caches.get(actions);
  if (cache === undefined) {
    cache = new Map();
    caches.set(actions, cache);
  }
  return cache;
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Returns the cached list when the inputs are the same references, or when the
 * recomputed list has the same items; otherwise stores and returns the new one.
 */
function memoList<T>(
  actions: EntityStructureActions<unknown, unknown>,
  key: string,
  inputs: readonly unknown[],
  compute: () => readonly T[],
): readonly T[] {
  const cache = cacheFor(actions);
  const cached = cache.get(key) as ListCache<T> | undefined;
  if (cached !== undefined && sameItems(cached.inputs, inputs)) return cached.result;
  const next = compute();
  const result = cached !== undefined && sameItems(cached.result, next) ? cached.result : next.length === 0 ? EMPTY : next;
  cache.set(key, { inputs, result });
  return result;
}

/** The whole core state. */
export function selectStructure<TEntity, TRelationship>(
  state: EntityStructureStoreState<TEntity, TRelationship>,
): StructureState<TEntity, TRelationship> {
  return state.structure;
}

/** The store's actions (a stable object). */
export function selectActions<TEntity, TRelationship>(
  state: EntityStructureStoreState<TEntity, TRelationship>,
): EntityStructureActions<TEntity, TRelationship> {
  return state.actions;
}

/** Root node ids, in order. */
export function selectRootIds<TEntity, TRelationship>(
  state: EntityStructureStoreState<TEntity, TRelationship>,
): readonly NodeId[] {
  return state.structure.rootIds;
}

/** One occurrence by node id. The core keeps untouched nodes by reference. */
export function selectNode<TEntity, TRelationship>(
  nodeId: NodeId,
): StoreSelector<TEntity, TRelationship, StructureNode<TRelationship> | undefined> {
  return (state) => findByNodeId(state.structure, nodeId);
}

/** The central record of an entity by its (normalized) key. */
export function selectEntity<TEntity, TRelationship>(
  key: EntityKey,
): StoreSelector<TEntity, TRelationship, EntityRecord<TEntity> | undefined> {
  return (state) => findEntity(state.structure, key);
}

/** Children of a node, or the roots when `nodeId` is `null`. */
export function selectChildren<TEntity, TRelationship>(
  nodeId: NodeId | null,
): StoreSelector<TEntity, TRelationship, readonly StructureNode<TRelationship>[]> {
  const cacheKey = nodeId === null ? "children:" : `children:#${nodeId}`;
  return (state) => {
    const { structure } = state;
    const ids = nodeId === null ? structure.rootIds : findByNodeId(structure, nodeId)?.childIds;
    if (ids === undefined) return EMPTY;
    const nodes = ids.map((id) => findByNodeId(structure, id));
    return memoList(
      state.actions as EntityStructureActions<unknown, unknown>,
      cacheKey,
      [ids, ...nodes],
      () => getChildren(structure, nodeId),
    );
  };
}

/**
 * Every occurrence of an identity (raw value, normalized with the store's
 * config), in pre-order. Empty for invalid or unknown identities.
 */
export function selectAllByIdentity<TEntity, TRelationship>(
  value: unknown,
): StoreSelector<TEntity, TRelationship, readonly StructureNode<TRelationship>[]> {
  return (state) => {
    const key = normalizeIdentity(value, state.config);
    if (!key.ok) return EMPTY;
    const { structure } = state;
    return memoList(
      state.actions as EntityStructureActions<unknown, unknown>,
      `identity:${key.value}`,
      [structure.nodes, structure.rootIds],
      () => getOccurrences(structure, key.value),
    );
  };
}
