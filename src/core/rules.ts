import { resolveConfig, type ResolvedConfig } from "./config.js";
import { CORE_ERROR_CODES, coreError, type ErrorCategory } from "./errors.js";
import { resolveIdentity } from "./identity.js";
import { getOwn } from "./internal.js";
import type {
  EntityKey,
  EntityMatcher,
  EntityRecord,
  EntityStructureConfig,
  NodeId,
  RelationshipContext,
  StructureState,
  ValidationError,
  ValidationResult,
  ValidationWarning,
  Verdict,
} from "./types.js";

export interface LinkOutcome {
  readonly errors: ValidationError[];
  readonly warnings: ValidationWarning[];
}

/**
 * Declarative matcher. Properties are read the same way `identity.key` reads
 * them (a normal property access), so getters and inherited properties of
 * class instances match too (F2). Expected values are primitives, so a
 * prototype member such as `constructor` can never match by accident.
 */
function matches<TEntity>(matcher: EntityMatcher<TEntity> | undefined, entity: TEntity): boolean {
  if (matcher === undefined) return true;
  if (typeof matcher === "function") return matcher(entity);
  if (entity === null || typeof entity !== "object") return false;
  for (const property of Object.keys(matcher)) {
    const expected: unknown = (matcher as Record<string, unknown>)[property];
    const actual: unknown = (entity as Record<string, unknown>)[property];
    const ok = Array.isArray(expected) ? expected.includes(actual) : expected === actual;
    if (!ok) return false;
  }
  return true;
}

/** Converts a consumer verdict into an issue (or nothing when valid). */
export function verdictIssue(
  verdict: Verdict,
  defaults: { code: string; message: string; category: ErrorCategory },
  fields: { nodeId?: NodeId; entityKey?: EntityKey; path?: readonly NodeId[] },
): { issue: ValidationError; severity: "error" | "warning" } | undefined {
  if (verdict.valid) return undefined;
  const code = verdict.code ?? defaults.code;
  const issue: ValidationError = {
    code,
    category: defaults.category,
    message: verdict.message ?? defaults.message,
    ...fields,
    ...(verdict.details === undefined ? {} : { details: verdict.details }),
  };
  return { issue, severity: verdict.severity ?? "error" };
}

/**
 * Evaluates one parent → child link. Precedence:
 * 1. any matching deny rule blocks (deny > allow);
 * 2. otherwise any matching allow rule permits;
 * 3. otherwise `mode` decides (`restrictive` blocks, `permissive` permits);
 * and the custom `validate` predicate always runs and can add errors or warnings.
 */
export function evaluateLink<TEntity, TRelationship>(
  context: RelationshipContext<TEntity, TRelationship>,
  resolved: ResolvedConfig<TEntity, TRelationship>,
  fields: { nodeId?: NodeId; path?: readonly NodeId[] } = {},
): LinkOutcome {
  const outcome: LinkOutcome = { errors: [], warnings: [] };
  const { parent, child } = context;
  const matching = resolved.rules.filter(
    ({ rule }) =>
      matches(rule.parent, parent.data) &&
      matches(rule.child, child.data) &&
      (rule.when === undefined || rule.when(context)),
  );
  const base = { ...fields, entityKey: child.key };
  const deny = matching.find(({ rule }) => !rule.allowed);
  if (deny !== undefined) {
    outcome.errors.push({
      code: deny.rule.code ?? "RELATIONSHIP_DENIED",
      category: "relationship",
      message: deny.rule.message ?? `Rule "${deny.id}" denies "${parent.key}" → "${child.key}".`,
      ruleId: deny.id,
      ...base,
      details: { parentKey: parent.key, childKey: child.key },
    });
  } else if (matching.length === 0 && resolved.mode === "restrictive") {
    outcome.errors.push(
      coreError("RELATIONSHIP_NOT_ALLOWED", `No rule allows "${parent.key}" → "${child.key}" (restrictive mode).`, {
        ...base,
        details: { parentKey: parent.key, childKey: child.key },
      }),
    );
  }
  if (resolved.validateRelationship !== undefined) {
    const result = verdictIssue(
      resolved.validateRelationship(context),
      {
        code: "RELATIONSHIP_INVALID",
        message: `Relationship "${parent.key}" → "${child.key}" is invalid.`,
        category: CORE_ERROR_CODES.RELATIONSHIP_INVALID,
      },
      base,
    );
    if (result !== undefined) {
      (result.severity === "warning" ? outcome.warnings : outcome.errors).push(result.issue);
    }
  }
  return outcome;
}

export interface CompatibilityOptions<TRelationship> {
  readonly relationship?: TRelationship;
  readonly context?: unknown;
}

/**
 * Checks whether two entities may be linked (rules + custom predicate only;
 * structural checks such as sibling duplicates or cycles need a concrete
 * operation). Accepts entity data, resolving identities with the config.
 */
export function validateRelationship<TEntity, TRelationship>(
  parent: TEntity,
  child: TEntity,
  config: EntityStructureConfig<TEntity, TRelationship>,
  options: CompatibilityOptions<TRelationship> = {},
): ValidationResult {
  const parentKey = resolveIdentity(parent, config);
  const childKey = resolveIdentity(child, config);
  const identityErrors = [
    ...(parentKey.ok ? [] : parentKey.errors),
    ...(childKey.ok ? [] : childKey.errors),
  ];
  if (!parentKey.ok || !childKey.ok) return { valid: false, errors: identityErrors, warnings: [] };
  const outcome = evaluateLink(
    queryContext({ key: parentKey.value, data: parent }, { key: childKey.value, data: child }, options, undefined),
    resolveConfig(config),
  );
  return { valid: outcome.errors.length === 0, ...outcome };
}

export function canRelate<TEntity, TRelationship>(
  parent: TEntity,
  child: TEntity,
  config: EntityStructureConfig<TEntity, TRelationship>,
  options: CompatibilityOptions<TRelationship> = {},
): boolean {
  return validateRelationship(parent, child, config, options).valid;
}

/** Registered entities that `parentKey` may have as children (by rules). */
export function getAllowedChildren<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  parentKey: EntityKey,
  config: EntityStructureConfig<TEntity, TRelationship>,
  options: CompatibilityOptions<TRelationship> = {},
): EntityRecord<TEntity>[] {
  const parent = getOwn(state.entities, parentKey);
  if (parent === undefined) return [];
  const resolved = resolveConfig(config);
  return Object.values(state.entities).filter(
    (child) => evaluateLink(queryContext(parent, child, options, state), resolved).errors.length === 0,
  );
}

/** Registered entities that may have `childKey` as a child (by rules). */
export function getAllowedParents<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  childKey: EntityKey,
  config: EntityStructureConfig<TEntity, TRelationship>,
  options: CompatibilityOptions<TRelationship> = {},
): EntityRecord<TEntity>[] {
  const child = getOwn(state.entities, childKey);
  if (child === undefined) return [];
  const resolved = resolveConfig(config);
  return Object.values(state.entities).filter(
    (parent) => evaluateLink(queryContext(parent, child, options, state), resolved).errors.length === 0,
  );
}

function queryContext<TEntity, TRelationship>(
  parent: EntityRecord<TEntity>,
  child: EntityRecord<TEntity>,
  options: CompatibilityOptions<TRelationship>,
  state: StructureState<TEntity, TRelationship> | undefined,
): RelationshipContext<TEntity, TRelationship> {
  return {
    parent,
    child,
    parentNode: undefined,
    childNode: undefined,
    relationship: options.relationship,
    operation: "query",
    state,
    context: options.context,
  };
}
