import { coreError } from "./errors.js";
import { resolveIdentity, normalizeIdentity } from "./identity.js";
import { Draft } from "./draft.js";
import { getOwn, hasOwn } from "./internal.js";
import { finish } from "./operation.js";
import type {
  EntityKey,
  EntityRecord,
  EntityStructureConfig,
  OperationResult,
  StructureState,
} from "./types.js";

/** Returns the central record for `key`, if registered. */
export function findEntity<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  key: EntityKey,
): EntityRecord<TEntity> | undefined {
  return getOwn(state.entities, key);
}

export function hasEntity<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  key: EntityKey,
): boolean {
  return hasOwn(state.entities, key);
}

export function getAllEntities<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
): EntityRecord<TEntity>[] {
  return Object.values(state.entities);
}

/**
 * Looks up the central record by a raw identity value (normalized with the
 * configured `normalize`). Returns the registry record, never occurrences:
 * use `findAllByIdentity` for those.
 */
export function findByIdentity<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  value: unknown,
  config: EntityStructureConfig<TEntity, TRelationship>,
): EntityRecord<TEntity> | undefined {
  const key = normalizeIdentity(value, config);
  return key.ok ? getOwn(state.entities, key.value) : undefined;
}

/**
 * Registers a new entity in the central registry. Fails with
 * `IDENTITY_COLLISION` when the (normalized) identity already exists.
 */
export function registerEntity<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  entity: NoInfer<TEntity>,
  config: EntityStructureConfig<TEntity, TRelationship>,
): OperationResult<TEntity, TRelationship, { key: EntityKey }> {
  const identity = resolveIdentity(entity, config);
  if (!identity.ok) return identity;
  const key = identity.value;
  if (hasOwn(state.entities, key)) {
    return {
      ok: false,
      errors: [
        coreError("IDENTITY_COLLISION", `An entity with identity "${key}" is already registered.`, {
          entityKey: key,
        }),
      ],
    };
  }
  const draft = new Draft(state);
  const stored = draft.setEntity({ key, data: entity });
  return finish(
    draft,
    { nodeIds: [], entityKeys: [key] },
    [{ type: "ENTITY_REGISTERED", key, entity: stored.data }],
    config,
    "registerEntity",
    undefined,
    { key },
  );
}
