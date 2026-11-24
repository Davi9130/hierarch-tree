import { resolveConfig } from "./config.js";
import { coreError } from "./errors.js";
import type {
  EntityKey,
  EntityStructureConfig,
  Result,
  ValidationError,
} from "./types.js";

export type IdentityResult = Result<EntityKey, readonly ValidationError[]>;

/**
 * Normalizes a raw identity value (`string | number`) into an `EntityKey`.
 * Missing, non-primitive, non-finite and empty values are rejected.
 */
export function normalizeIdentity<TEntity, TRelationship>(
  value: unknown,
  config: EntityStructureConfig<TEntity, TRelationship>,
): IdentityResult {
  const { normalize } = resolveConfig(config);
  if (value === undefined || value === null) {
    return fail(coreError("IDENTITY_MISSING", "The entity has no identity value."));
  }
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    return fail(
      coreError("IDENTITY_INVALID", "The identity value must be a string or a finite number.", {
        details: { received: typeof value },
      }),
    );
  }
  const raw = String(value);
  const key: unknown = normalize === undefined ? raw : normalize(raw);
  if (typeof key !== "string") {
    return fail(
      coreError("IDENTITY_INVALID", "`identity.normalize` must return a string.", {
        details: { raw },
      }),
    );
  }
  if (key.trim() === "") {
    return fail(
      coreError("IDENTITY_EMPTY", "The identity is empty after normalization.", {
        details: { raw },
      }),
    );
  }
  return { ok: true, value: key };
}

/** Resolves the `EntityKey` of an entity according to the identity configuration. */
export function resolveIdentity<TEntity, TRelationship>(
  entity: TEntity,
  config: EntityStructureConfig<TEntity, TRelationship>,
): IdentityResult {
  return normalizeIdentity(resolveConfig(config).getRawIdentity(entity), config);
}

function fail(error: ValidationError): IdentityResult {
  return { ok: false, errors: [error] };
}
