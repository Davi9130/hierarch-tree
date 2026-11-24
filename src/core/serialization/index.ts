import { resolveConfig } from "../config.js";
import { coreError, type CoreErrorCode } from "../errors.js";
import { resolveIdentity } from "../identity.js";
import { hasOwn, patchRecord } from "../internal.js";
import { collectSubtree, nodeSource, pathTo } from "../tree.js";
import type {
  EntityKey,
  EntityRecord,
  EntityStructureConfig,
  NodeId,
  Result,
  StructureNode,
  StructureState,
  ValidationError,
  ValidationWarning,
} from "../types.js";
import { validateStructure } from "../validation.js";

/** Snapshot format version written by `exportStructure`. */
export const SNAPSHOT_VERSION = 1;

export interface SnapshotEntityV1<TEntity> {
  readonly key: EntityKey;
  readonly data: TEntity;
}

export interface SnapshotNodeV1<TRelationship> {
  readonly id: NodeId;
  readonly entityKey: EntityKey;
  readonly parentId: NodeId | null;
  /** Children in order. */
  readonly childIds: readonly NodeId[];
  readonly relationship: TRelationship;
}

/**
 * Plain, JSON-serializable snapshot (no `Map`, no functions). It is as
 * serializable as the consumer's `TEntity` / `TRelationship` values are.
 */
export interface StructureSnapshotV1<TEntity, TRelationship> {
  readonly version: 1;
  readonly entities: readonly SnapshotEntityV1<TEntity>[];
  /** Flat list, in pre-order from the roots. */
  readonly nodes: readonly SnapshotNodeV1<TRelationship>[];
  readonly rootIds: readonly NodeId[];
}

/**
 * Converts a snapshot of version `N` into a snapshot of a later version
 * (eventually `SNAPSHOT_VERSION`). Receives the raw, unchecked data.
 */
export type SnapshotMigration = (snapshot: { readonly version: number } & Record<string, unknown>) => unknown;

export interface ImportStructureOptions {
  /** `{ [fromVersion]: migration }`, applied in chain until `SNAPSHOT_VERSION`. */
  readonly migrations?: { readonly [fromVersion: number]: SnapshotMigration };
  /** Passed to relationship rules and consumer validators. */
  readonly context?: unknown;
}

export interface ImportStructureSuccess<TEntity, TRelationship> {
  readonly state: StructureState<TEntity, TRelationship>;
  readonly warnings: readonly ValidationWarning[];
  /** Original version when migrations ran; `undefined` otherwise. */
  readonly migratedFrom: number | undefined;
}

export type ImportStructureResult<TEntity, TRelationship> = Result<
  ImportStructureSuccess<TEntity, TRelationship>,
  readonly ValidationError[]
>;

/** Serializes a state into a `StructureSnapshotV1`. Does not validate. */
export function exportStructure<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
): StructureSnapshotV1<TEntity, TRelationship> {
  const getNode = nodeSource(state);
  const order: NodeId[] = [];
  const seen = new Set<NodeId>();
  for (const rootId of state.rootIds) {
    for (const id of collectSubtree(getNode, rootId)) {
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  // Nodes not reachable from a root (only in an invalid state) are kept, not dropped.
  for (const id of Object.keys(state.nodes)) if (!seen.has(id)) order.push(id);

  const nodes: SnapshotNodeV1<TRelationship>[] = [];
  for (const id of order) {
    const node = getNode(id);
    if (node === undefined) continue;
    nodes.push({
      id: node.id,
      entityKey: node.entityKey,
      parentId: node.parentId,
      childIds: node.childIds.slice(),
      relationship: node.relationship,
    });
  }
  return {
    version: SNAPSHOT_VERSION,
    entities: Object.values(state.entities).map((record) => ({ key: record.key, data: record.data })),
    nodes,
    rootIds: state.rootIds.slice(),
  };
}

/**
 * Rebuilds a state from snapshot data (e.g. `JSON.parse` output).
 *
 * Order: version (and migrations) → format → snapshot-level duplicates and
 * identity collisions → the core pipeline through `validateStructure`
 * (references, cycles, identity, relationship rules, consumer validators).
 * Every error found up to the first blocking stage is returned, with `nodeId`
 * / `entityKey`, `path` (node ids from the root) when the node is placed in the
 * tree and `details.pointer` (JSON Pointer into the snapshot) for snapshot
 * errors.
 */
export function importStructure<TEntity, TRelationship>(
  data: unknown,
  config: EntityStructureConfig<TEntity, TRelationship>,
  options: ImportStructureOptions = {},
): ImportStructureResult<TEntity, TRelationship> {
  resolveConfig(config); // invalid configuration is a programmer error and throws

  const migrated = migrate(data, options.migrations ?? {});
  if (!migrated.ok) return migrated;

  const formatErrors: ValidationError[] = [];
  if (!isSnapshotV1(migrated.value.snapshot, formatErrors)) return { ok: false, errors: formatErrors };
  // The format is checked; `data` and `relationship` are the consumer's types,
  // which only consumer validators can check (e.g. with a schema).
  const snapshot = migrated.value.snapshot as StructureSnapshotV1<TEntity, TRelationship>;

  const errors: ValidationError[] = [];
  const entities = new Map<EntityKey, EntityRecord<TEntity>>();
  const resolvedOwner = new Map<EntityKey, EntityKey>(); // resolved identity → stated key
  snapshot.entities.forEach((entity, index) => {
    const pointer = `/entities/${index}`;
    if (entities.has(entity.key)) {
      errors.push(
        coreError("IDENTITY_COLLISION", `Entity key "${entity.key}" appears more than once.`, {
          entityKey: entity.key,
          details: { pointer },
        }),
      );
      return;
    }
    entities.set(entity.key, { key: entity.key, data: entity.data });
    // Identity errors and key mismatches are reported by the pipeline below.
    const resolved = resolveIdentity(entity.data, config);
    if (!resolved.ok) return;
    const owner = resolvedOwner.get(resolved.value);
    if (owner === undefined) {
      resolvedOwner.set(resolved.value, entity.key);
    } else {
      errors.push(
        coreError(
          "IDENTITY_COLLISION",
          `Entities "${owner}" and "${entity.key}" resolve to the same identity "${resolved.value}".`,
          { entityKey: entity.key, details: { pointer, resolvedKey: resolved.value, existingKey: owner } },
        ),
      );
    }
  });

  const nodes = new Map<NodeId, StructureNode<TRelationship>>();
  snapshot.nodes.forEach((node, index) => {
    if (nodes.has(node.id)) {
      errors.push(
        coreError("NODE_ID_COLLISION", `Node id "${node.id}" appears more than once.`, {
          nodeId: node.id,
          details: { pointer: `/nodes/${index}` },
        }),
      );
      return;
    }
    nodes.set(node.id, {
      id: node.id,
      entityKey: node.entityKey,
      parentId: node.parentId,
      childIds: node.childIds.slice(),
      relationship: node.relationship,
    });
  });

  const state: StructureState<TEntity, TRelationship> = {
    entities: patchRecord<EntityRecord<TEntity>>({}, entities),
    nodes: patchRecord<StructureNode<TRelationship>>({}, nodes),
    rootIds: snapshot.rootIds.slice(),
  };
  const validation = validateStructure(state, config, { context: options.context });
  const getNode = nodeSource(state);
  for (const error of validation.errors) {
    const placed = error.path === undefined && error.nodeId !== undefined && getNode(error.nodeId) !== undefined;
    errors.push(placed && error.nodeId !== undefined ? { ...error, path: pathTo(getNode, error.nodeId) } : error);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { state, warnings: validation.warnings, migratedFrom: migrated.value.from },
  };
}

// ---------------------------------------------------------------------------
// Version and migrations
// ---------------------------------------------------------------------------

type Migrated = Result<{ snapshot: unknown; from: number | undefined }, readonly ValidationError[]>;

function migrate(data: unknown, migrations: { readonly [fromVersion: number]: SnapshotMigration }): Migrated {
  let current = readVersion(data);
  if (!current.ok) return current;
  const from = current.value.version;
  const visited = new Set<number>();
  while (current.value.version !== SNAPSHOT_VERSION) {
    const { version, snapshot } = current.value;
    const migration = hasOwn(migrations, String(version)) ? migrations[version] : undefined;
    if (typeof migration !== "function") {
      return fail("SNAPSHOT_UNSUPPORTED_VERSION", `Snapshot version ${version} is not supported.`, {
        version,
        supported: SNAPSHOT_VERSION,
      });
    }
    visited.add(version);
    let output: unknown;
    try {
      output = migration(snapshot);
    } catch (cause) {
      return fail("SNAPSHOT_MIGRATION_FAILED", `Migration from version ${version} threw.`, {
        fromVersion: version,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const next = readVersion(output);
    if (!next.ok || visited.has(next.value.version)) {
      return fail("SNAPSHOT_MIGRATION_FAILED", `Migration from version ${version} did not produce a newer snapshot.`, {
        fromVersion: version,
        ...(next.ok ? { toVersion: next.value.version } : {}),
      });
    }
    current = next;
  }
  return { ok: true, value: { snapshot: current.value.snapshot, from: from === SNAPSHOT_VERSION ? undefined : from } };
}

function readVersion(
  data: unknown,
): Result<{ version: number; snapshot: { readonly version: number } & Record<string, unknown> }, readonly ValidationError[]> {
  if (!isPlainObject(data)) {
    return fail("SNAPSHOT_INVALID_FORMAT", "The snapshot must be an object.", { pointer: "" });
  }
  const version = data["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return fail("SNAPSHOT_UNSUPPORTED_VERSION", "The snapshot has no integer `version`.", {
      pointer: "/version",
      received: version === null ? "null" : typeof version,
    });
  }
  return { ok: true, value: { version, snapshot: { ...data, version } } };
}

function fail(code: CoreErrorCode, message: string, details: Record<string, unknown>): {
  ok: false;
  errors: readonly ValidationError[];
} {
  return { ok: false, errors: [coreError(code, message, { details })] };
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSnapshotV1(
  value: unknown,
  errors: ValidationError[],
): value is StructureSnapshotV1<unknown, unknown> {
  const start = errors.length;
  const invalid = (pointer: string, message: string, fields: { nodeId?: NodeId; entityKey?: EntityKey } = {}): void => {
    errors.push(coreError("SNAPSHOT_INVALID_FORMAT", message, { ...fields, details: { pointer } }));
  };
  const isId = (id: unknown): id is string => typeof id === "string" && id !== "";
  if (!isPlainObject(value)) {
    invalid("", "The snapshot must be an object.");
    return false;
  }

  const { entities, nodes, rootIds } = value;
  if (!Array.isArray(entities)) {
    invalid("/entities", "`entities` must be an array.");
  } else {
    entities.forEach((entity: unknown, index) => {
      const pointer = `/entities/${index}`;
      if (!isPlainObject(entity)) return invalid(pointer, "Each entity must be an object.");
      if (!isId(entity["key"])) invalid(`${pointer}/key`, "`key` must be a non-empty string.");
      if (!hasOwn(entity, "data") || entity["data"] === undefined) {
        invalid(`${pointer}/data`, "`data` is required.", isId(entity["key"]) ? { entityKey: entity["key"] } : {});
      }
    });
  }

  if (!Array.isArray(nodes)) {
    invalid("/nodes", "`nodes` must be an array.");
  } else {
    nodes.forEach((node: unknown, index) => {
      const pointer = `/nodes/${index}`;
      if (!isPlainObject(node)) return invalid(pointer, "Each node must be an object.");
      const fields = isId(node["id"]) ? { nodeId: node["id"] } : {};
      if (!isId(node["id"])) invalid(`${pointer}/id`, "`id` must be a non-empty string.");
      if (!isId(node["entityKey"])) invalid(`${pointer}/entityKey`, "`entityKey` must be a non-empty string.", fields);
      const parentId = node["parentId"];
      if (parentId !== null && !isId(parentId)) {
        invalid(`${pointer}/parentId`, "`parentId` must be a non-empty string or null.", fields);
      }
      const childIds = node["childIds"];
      if (!Array.isArray(childIds)) {
        invalid(`${pointer}/childIds`, "`childIds` must be an array.", fields);
      } else {
        childIds.forEach((childId: unknown, childIndex) => {
          if (!isId(childId)) invalid(`${pointer}/childIds/${childIndex}`, "Child ids must be non-empty strings.", fields);
        });
      }
    });
  }

  if (!Array.isArray(rootIds)) {
    invalid("/rootIds", "`rootIds` must be an array.");
  } else {
    rootIds.forEach((rootId: unknown, index) => {
      if (!isId(rootId)) invalid(`/rootIds/${index}`, "Root ids must be non-empty strings.");
    });
  }
  return errors.length === start;
}
