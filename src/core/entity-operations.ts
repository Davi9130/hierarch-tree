import { resolveConfig } from "./config.js";
import { Draft } from "./draft.js";
import { coreError } from "./errors.js";
import { resolveIdentity } from "./identity.js";
import { getOwn, hasOwn } from "./internal.js";
import { failure, finish } from "./operation.js";
import { removeSubtrees } from "./structure.js";
import type {
  EntityKey,
  EntityStructureConfig,
  NodeId,
  OperationResult,
  StructureEvent,
  StructureState,
} from "./types.js";

interface OperationContext {
  readonly context?: unknown;
}

function occurrencesOf<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  key: EntityKey,
): NodeId[] {
  return Object.values(state.nodes)
    .filter((node) => node.entityKey === key)
    .map((node) => node.id);
}

function notFound(key: EntityKey): { ok: false; errors: readonly ReturnType<typeof coreError>[] } {
  return failure(coreError("ENTITY_NOT_FOUND", `Entity "${key}" is not registered.`, { entityKey: key }));
}

export type UpdateEntityInput<TEntity> = OperationContext & {
  readonly key: EntityKey;
  readonly data: TEntity;
};

/**
 * Replaces the data of a registered entity. The new data must resolve to the
 * same identity (use `rekeyEntity` to change it). Every occurrence is
 * revalidated, since changed data can invalidate existing links.
 */
export function updateEntity<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  input: UpdateEntityInput<TEntity>,
  config: EntityStructureConfig<TEntity, TRelationship>,
): OperationResult<TEntity, TRelationship> {
  const record = getOwn(state.entities, input.key);
  if (record === undefined) return notFound(input.key);
  const identity = resolveIdentity(input.data, config);
  if (!identity.ok) return failure(...identity.errors.map((error) => ({ ...error, entityKey: input.key })));
  if (identity.value !== input.key) {
    return failure(
      coreError(
        "IDENTITY_CHANGE_REQUIRES_REKEY",
        `The new data resolves to identity "${identity.value}"; use rekeyEntity to change "${input.key}".`,
        { entityKey: input.key, details: { resolvedKey: identity.value } },
      ),
    );
  }
  const draft = new Draft(state);
  draft.setEntity({ key: input.key, data: input.data });
  return finish(
    draft,
    { nodeIds: occurrencesOf(state, input.key), entityKeys: [input.key] },
    [{ type: "ENTITY_UPDATED", key: input.key, previous: record.data, next: input.data }],
    config,
    "updateEntity",
    input.context,
    {},
  );
}

export type RekeyEntityInput<TEntity> = OperationContext & {
  /** Current identity. */
  readonly key: EntityKey;
  /** New data, resolving to the new identity. */
  readonly data: TEntity;
};

/**
 * Explicit identity change: moves the central record to its new key and
 * updates every occurrence. Fails on collision with an existing identity.
 */
export function rekeyEntity<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  input: RekeyEntityInput<TEntity>,
  config: EntityStructureConfig<TEntity, TRelationship>,
): OperationResult<TEntity, TRelationship, { key: EntityKey }> {
  const record = getOwn(state.entities, input.key);
  if (record === undefined) return notFound(input.key);
  const identity = resolveIdentity(input.data, config);
  if (!identity.ok) return failure(...identity.errors.map((error) => ({ ...error, entityKey: input.key })));
  const key = identity.value;
  if (key === input.key) {
    const updated = updateEntity(state, input, config);
    return updated.ok ? { ok: true, value: { ...updated.value, key } } : updated;
  }
  if (hasOwn(state.entities, key)) {
    return failure(
      coreError("IDENTITY_COLLISION", `An entity with identity "${key}" is already registered.`, {
        entityKey: key,
        details: { previousKey: input.key },
      }),
    );
  }
  const draft = new Draft(state);
  const nodeIds = occurrencesOf(state, input.key);
  draft.deleteEntity(input.key);
  draft.setEntity({ key, data: input.data });
  for (const id of nodeIds) {
    const node = draft.getNode(id);
    if (node !== undefined) draft.setNode({ ...node, entityKey: key });
  }
  return finish(
    draft,
    { nodeIds, entityKeys: [key] },
    [{ type: "ENTITY_REKEYED", previousKey: input.key, key, previous: record.data, next: input.data, nodeIds }],
    config,
    "rekeyEntity",
    input.context,
    { key },
  );
}

export type RemoveEntityInput = OperationContext & {
  readonly key: EntityKey;
};

/**
 * Removes an entity from the registry. While it has occurrences this fails
 * with `ENTITY_IN_USE`, unless the `"force"` removal policy is configured, in
 * which case every occurrence is removed with its descendants.
 */
export function removeEntity<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  input: RemoveEntityInput,
  config: EntityStructureConfig<TEntity, TRelationship>,
): OperationResult<TEntity, TRelationship> {
  const record = getOwn(state.entities, input.key);
  if (record === undefined) return notFound(input.key);
  const nodeIds = occurrencesOf(state, input.key);
  if (nodeIds.length > 0 && resolveConfig(config).entityRemoval !== "force") {
    return failure(
      coreError("ENTITY_IN_USE", `Entity "${input.key}" still has ${nodeIds.length} occurrence(s).`, {
        entityKey: input.key,
        details: { nodeIds },
      }),
    );
  }
  const draft = new Draft(state);
  const events: StructureEvent<TEntity, TRelationship>[] = [];
  removeSubtrees(draft, nodeIds, events);
  draft.deleteEntity(input.key);
  events.push({ type: "ENTITY_REMOVED", key: input.key, entity: record.data });
  const parents = nodeIds
    .map((id) => getOwn(state.nodes, id)?.parentId ?? null)
    .filter((id): id is NodeId => id !== null && draft.getNode(id) !== undefined);
  return finish(draft, { nodeIds: parents }, events, config, "removeEntity", input.context, {});
}
