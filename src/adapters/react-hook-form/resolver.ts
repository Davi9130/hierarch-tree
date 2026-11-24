import type { FieldError, FieldErrors, Resolver } from "react-hook-form";
import { validateStructure, type EntityStructureConfig, type ValidationError } from "../../index.js";
import type { StructureFormValues } from "./use-entity-structure-form.js";

export interface StructureResolverOptions {
  /** Forwarded to relationship predicates and validators as `context`. */
  readonly context?: unknown;
}

type ErrorTree = Record<string, Record<string, FieldError> | FieldError>;

function place(tree: ErrorTree, error: ValidationError): void {
  const bucket = error.nodeId !== undefined ? "nodes" : error.entityKey !== undefined ? "entities" : undefined;
  const id = error.nodeId ?? error.entityKey;
  let target: Record<string, FieldError | undefined>;
  let key: string;
  if (bucket === undefined || id === undefined) {
    target = tree as Record<string, FieldError | undefined>;
    key = "root";
  } else {
    target = (tree[bucket] ??= {}) as Record<string, FieldError | undefined>;
    key = id;
  }
  const existing = target[key];
  if (existing === undefined) {
    target[key] = { type: error.code, message: error.message, types: { [error.code]: error.message } };
  } else {
    existing.types = { ...existing.types, [error.code]: error.message };
  }
}

/**
 * A React Hook Form resolver that runs the full core pipeline
 * (`validateStructure`) over the form values, so `handleSubmit` only calls
 * `onValid` for a valid structure. Errors land at `errors.nodes[nodeId]`,
 * `errors.entities[entityKey]` or `errors.root`, with the core error code as
 * `type` (all codes of that place in `types`).
 */
export function createStructureResolver<TEntity, TRelationship>(
  config: EntityStructureConfig<TEntity, TRelationship>,
  options: StructureResolverOptions = {},
): Resolver<StructureFormValues<TEntity, TRelationship>> {
  return (values) => {
    const result = validateStructure(values, config, { context: options.context });
    if (result.valid) return { values, errors: {} };
    const tree: ErrorTree = {};
    for (const error of result.errors) place(tree, error);
    return { values: {}, errors: tree as FieldErrors<StructureFormValues<TEntity, TRelationship>> };
  };
}
