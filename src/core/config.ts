import { EntityStructureConfigError } from "./errors.js";
import type {
  EntityMatcher,
  EntityStructureConfig,
  NodeId,
  RelationshipContext,
  RelationshipRule,
  RulesMode,
  StructureValidator,
  Verdict,
} from "./types.js";

export interface ResolvedRule<TEntity, TRelationship> {
  readonly id: string;
  readonly index: number;
  readonly rule: RelationshipRule<TEntity, TRelationship>;
}

/** Configuration with defaults applied and declarative rules checked. */
export interface ResolvedConfig<TEntity, TRelationship> {
  readonly getRawIdentity: (entity: TEntity) => unknown;
  readonly normalize: ((value: string) => string) | undefined;
  readonly rules: readonly ResolvedRule<TEntity, TRelationship>[];
  readonly mode: RulesMode;
  readonly validateRelationship:
    | ((context: RelationshipContext<TEntity, TRelationship>) => Verdict)
    | undefined;
  readonly validators: readonly StructureValidator<TEntity, TRelationship>[];
  readonly siblingDuplicates: "deny" | "allow";
  readonly entityRemoval: "block" | "when-unreferenced" | "force";
  readonly identityCycles: "deny" | "allow";
  readonly maxDepth: number;
  readonly createId: () => NodeId;
}

export const DEFAULTS = {
  mode: "restrictive",
  siblingDuplicates: "deny",
  entityRemoval: "block",
  identityCycles: "deny",
} as const;

const cache = new WeakMap<object, unknown>();

/**
 * Resolves (and memoizes per config object) the configuration. Invalid
 * configuration is a programmer error and throws `EntityStructureConfigError`.
 */
export function resolveConfig<TEntity, TRelationship>(
  config: EntityStructureConfig<TEntity, TRelationship>,
): ResolvedConfig<TEntity, TRelationship> {
  const cached = cache.get(config);
  if (cached !== undefined) {
    // The cache is keyed by the very config object it was built from.
    return cached as ResolvedConfig<TEntity, TRelationship>;
  }
  const resolved = buildConfig(config);
  cache.set(config, resolved);
  return resolved;
}

function buildConfig<TEntity, TRelationship>(
  config: EntityStructureConfig<TEntity, TRelationship>,
): ResolvedConfig<TEntity, TRelationship> {
  const { identity } = config;
  if (identity === undefined || identity === null || typeof identity !== "object") {
    throw new EntityStructureConfigError("`identity` configuration is required.");
  }
  let getRawIdentity: (entity: TEntity) => unknown;
  if (typeof identity.getKey === "function") {
    if (identity.key !== undefined) {
      throw new EntityStructureConfigError("Use either `identity.key` or `identity.getKey`, not both.");
    }
    getRawIdentity = identity.getKey;
  } else if (typeof identity.key === "string" && identity.key !== "") {
    const property = identity.key;
    getRawIdentity = (entity) =>
      entity !== null && typeof entity === "object"
        ? (entity as Record<string, unknown>)[property]
        : undefined;
  } else {
    throw new EntityStructureConfigError(
      "`identity` must define a non-empty `key` property name or a `getKey` function.",
    );
  }
  if (identity.normalize !== undefined && typeof identity.normalize !== "function") {
    throw new EntityStructureConfigError("`identity.normalize` must be a function.");
  }

  const relationships = config.relationships ?? {};
  const mode = relationships.mode ?? DEFAULTS.mode;
  if (mode !== "permissive" && mode !== "restrictive") {
    throw new EntityStructureConfigError(`Unknown relationships.mode "${String(mode)}".`);
  }
  const rules = (relationships.rules ?? []).map((rule, index) =>
    resolveRule(rule, index),
  );
  const ids = new Set<string>();
  for (const { id } of rules) {
    if (ids.has(id)) throw new EntityStructureConfigError(`Duplicate rule id "${id}".`);
    ids.add(id);
  }

  const policies = config.policies ?? {};
  const maxDepth = policies.maxDepth ?? Number.POSITIVE_INFINITY;
  if (maxDepth !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
    throw new EntityStructureConfigError("`policies.maxDepth` must be a non-negative integer.");
  }

  return {
    getRawIdentity,
    normalize: identity.normalize,
    rules,
    mode,
    validateRelationship: relationships.validate,
    validators: config.validators ?? [],
    siblingDuplicates: policies.siblingDuplicates ?? DEFAULTS.siblingDuplicates,
    entityRemoval: policies.entityRemoval ?? DEFAULTS.entityRemoval,
    identityCycles: policies.identityCycles ?? DEFAULTS.identityCycles,
    maxDepth,
    createId: config.createId ?? defaultCreateId,
  };
}

function resolveRule<TEntity, TRelationship>(
  rule: RelationshipRule<TEntity, TRelationship>,
  index: number,
): ResolvedRule<TEntity, TRelationship> {
  const id = rule.id ?? `rule[${index}]`;
  if (typeof rule.allowed !== "boolean") {
    throw new EntityStructureConfigError(`Rule "${id}" must define \`allowed: boolean\`.`);
  }
  checkMatcher(rule.parent, id, "parent");
  checkMatcher(rule.child, id, "child");
  if (rule.when !== undefined && typeof rule.when !== "function") {
    throw new EntityStructureConfigError(`Rule "${id}": \`when\` must be a function.`);
  }
  return { id, index, rule };
}

function isPrimitive(value: unknown): boolean {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

function checkMatcher<TEntity>(
  matcher: EntityMatcher<TEntity> | undefined,
  id: string,
  side: "parent" | "child",
): void {
  if (matcher === undefined || typeof matcher === "function") return;
  if (matcher === null || typeof matcher !== "object" || Array.isArray(matcher)) {
    throw new EntityStructureConfigError(
      `Rule "${id}": \`${side}\` must be an object matcher or a predicate function.`,
    );
  }
  for (const [property, expected] of Object.entries(matcher)) {
    const values: readonly unknown[] = Array.isArray(expected) ? expected : [expected];
    if (!values.every(isPrimitive)) {
      throw new EntityStructureConfigError(
        `Rule "${id}": \`${side}.${property}\` must be a primitive or an array of primitives. ` +
          "Use a predicate function for complex comparisons.",
      );
    }
  }
}

let fallbackCounter = 0;

function defaultCreateId(): NodeId {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID();
  fallbackCounter += 1;
  return `node-${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
