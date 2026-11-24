import { coreError } from "./errors.js";
import type { Draft } from "./draft.js";
import { validateChange, type ChangeScope } from "./validation.js";
import type {
  EntityStructureConfig,
  OperationName,
  OperationResult,
  StructureEvent,
  ValidationError,
} from "./types.js";

/** Builds the candidate state, runs the pipeline and returns the result. */
export function finish<TEntity, TRelationship, TExtra extends object>(
  draft: Draft<TEntity, TRelationship>,
  scope: ChangeScope,
  events: readonly StructureEvent<TEntity, TRelationship>[],
  config: EntityStructureConfig<TEntity, TRelationship>,
  operation: OperationName,
  context: unknown,
  extra: TExtra,
): OperationResult<TEntity, TRelationship, TExtra> {
  const state = draft.build();
  const { errors, warnings } = validateChange(state, scope, config, operation, context);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { ...extra, state, events, warnings } };
}

export function failure(...errors: ValidationError[]): { ok: false; errors: readonly ValidationError[] } {
  return { ok: false, errors };
}

/** Validates an insertion index; `undefined` means "append". */
export function resolveIndex(
  index: number | undefined,
  length: number,
): { ok: true; value: number } | { ok: false; error: ValidationError } {
  if (index === undefined) return { ok: true, value: length };
  if (!Number.isInteger(index) || index < 0) {
    return {
      ok: false,
      error: coreError("INVALID_INDEX", `Index must be a non-negative integer, got ${String(index)}.`, {
        details: { index },
      }),
    };
  }
  return { ok: true, value: Math.min(index, length) };
}
