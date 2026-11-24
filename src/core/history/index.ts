import { EntityStructureConfigError } from "../errors.js";
import { getOwn } from "../internal.js";
import type {
  EntityKey,
  NodeId,
  StructureEvent,
  StructureEventType,
  StructureNode,
  StructureState,
} from "../types.js";

/**
 * Optional change history built from the events the pure operations already
 * return. It is an in-memory convenience log for undo-like UIs, debugging and
 * "recent changes" views — NOT an official audit trail: it is opt-in, bounded,
 * mutable by its owner, has no persistence, integrity or authorship guarantees,
 * and only sees the events it is given.
 */

export interface HistoryPosition {
  readonly parentId: NodeId | null;
  /** Absent when the event does not carry it (e.g. `NODE_REMOVED`). */
  readonly index?: number;
}

/** What `before` / `after` can hold, depending on the event type. */
export type HistoryValue<TEntity, TRelationship> = TEntity | TRelationship | StructureNode<TRelationship>;

export interface HistoryEntry<TEntity, TRelationship> {
  readonly id: string;
  readonly type: StructureEventType;
  /** Milliseconds since the epoch (from `now`). Entries of one batch share it. */
  readonly timestamp: number;
  readonly entityKey: EntityKey | undefined;
  /** `ENTITY_REKEYED` only. */
  readonly previousEntityKey?: EntityKey;
  readonly nodeId: NodeId | undefined;
  readonly from?: HistoryPosition;
  readonly to?: HistoryPosition;
  /** Previous entity / relationship / removed node. */
  readonly before?: HistoryValue<TEntity, TRelationship>;
  /** New entity / relationship. */
  readonly after?: HistoryValue<TEntity, TRelationship>;
  /** Consumer-supplied context (user, reason, request id...). */
  readonly context: unknown;
  /** The original core event. */
  readonly event: StructureEvent<TEntity, TRelationship>;
}

export interface HistoryOptions {
  /** Maximum number of entries kept; the oldest are dropped. Default 1000. */
  readonly limit?: number;
  /** Clock. Default `Date.now`. */
  readonly now?: () => number;
  /** Entry id generator. Default `h1`, `h2`, ... per history. */
  readonly createId?: () => string;
}

export interface RecordMeta<TEntity, TRelationship> {
  readonly context?: unknown;
  /**
   * State after the operation. Used to fill `entityKey` for events that only
   * carry a node id (`NODE_MOVED`, `RELATIONSHIP_UPDATED`).
   */
  readonly state?: StructureState<TEntity, TRelationship>;
}

export interface History<TEntity, TRelationship> {
  readonly limit: number;
  /** Appends one entry per event and returns the new entries. */
  record(
    events: readonly StructureEvent<TEntity, TRelationship>[],
    meta?: RecordMeta<TEntity, TRelationship>,
  ): readonly HistoryEntry<TEntity, TRelationship>[];
  /** Oldest first. A new array on every call. */
  entries(): readonly HistoryEntry<TEntity, TRelationship>[];
  clear(): void;
}

export const DEFAULT_HISTORY_LIMIT = 1000;

/** Creates an empty, bounded history. Nothing is recorded unless you call `record` (or `trackHistory`). */
export function createHistory<TEntity, TRelationship = unknown>(
  options: HistoryOptions = {},
): History<TEntity, TRelationship> {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(limit) || limit < 1)) {
    throw new EntityStructureConfigError("History `limit` must be a positive integer or Infinity.");
  }
  const now = options.now ?? Date.now;
  let counter = 0;
  const createId =
    options.createId ??
    (() => {
      counter += 1;
      return `h${counter}`;
    });
  let log: HistoryEntry<TEntity, TRelationship>[] = [];

  return {
    limit,
    record(events, meta = {}) {
      const created = toHistoryEntries(events, { ...meta, timestamp: now(), createId });
      log.push(...created);
      if (log.length > limit) log = log.slice(log.length - limit);
      return created;
    },
    entries: () => log.slice(),
    clear() {
      log = [];
    },
  };
}

/** Pure mapping from core events to history entries. */
export function toHistoryEntries<TEntity, TRelationship>(
  events: readonly StructureEvent<TEntity, TRelationship>[],
  options: RecordMeta<TEntity, TRelationship> & { readonly timestamp: number; readonly createId: () => string },
): HistoryEntry<TEntity, TRelationship>[] {
  const { timestamp, createId, state } = options;
  const context = options.context;
  const keyOf = (nodeId: NodeId): EntityKey | undefined =>
    state === undefined ? undefined : getOwn(state.nodes, nodeId)?.entityKey;

  return events.map((event) => {
    const base = { id: createId(), type: event.type, timestamp, context, event };
    switch (event.type) {
      case "ENTITY_REGISTERED":
        return { ...base, entityKey: event.key, nodeId: undefined, after: event.entity };
      case "ENTITY_UPDATED":
        return { ...base, entityKey: event.key, nodeId: undefined, before: event.previous, after: event.next };
      case "ENTITY_REKEYED":
        return {
          ...base,
          entityKey: event.key,
          previousEntityKey: event.previousKey,
          nodeId: undefined,
          before: event.previous,
          after: event.next,
        };
      case "ENTITY_REMOVED":
        return { ...base, entityKey: event.key, nodeId: undefined, before: event.entity };
      case "NODE_ADDED":
        return {
          ...base,
          entityKey: event.entityKey,
          nodeId: event.nodeId,
          to: { parentId: event.parentId, index: event.index },
        };
      case "NODE_REMOVED":
        return {
          ...base,
          entityKey: event.entityKey,
          nodeId: event.nodeId,
          from: { parentId: event.parentId },
          before: event.node,
        };
      case "NODE_MOVED":
        return { ...base, entityKey: keyOf(event.nodeId), nodeId: event.nodeId, from: event.from, to: event.to };
      case "RELATIONSHIP_UPDATED":
        return {
          ...base,
          entityKey: keyOf(event.nodeId),
          nodeId: event.nodeId,
          before: event.previous,
          after: event.next,
        };
    }
  });
}

/** The part of `createEntityStructure` that `trackHistory` needs. */
export interface Subscribable<TEntity, TRelationship> {
  subscribe(
    listener: (
      state: StructureState<TEntity, TRelationship>,
      events: readonly StructureEvent<TEntity, TRelationship>[],
    ) => void,
  ): () => void;
}

/**
 * Records every change of a `createEntityStructure` instance. `getContext` is
 * called once per change (e.g. to attach the current user). Returns the
 * unsubscribe function.
 */
export function trackHistory<TEntity, TRelationship>(
  structure: Subscribable<TEntity, TRelationship>,
  history: History<TEntity, TRelationship>,
  options: { readonly getContext?: () => unknown } = {},
): () => void {
  return structure.subscribe((state, events) => {
    history.record(events, { state, context: options.getContext?.() });
  });
}
