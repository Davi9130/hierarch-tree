import type { ErrorCode, ErrorCategory } from "./errors.js";

/** Normalized identity of an entity in the central registry. */
export type EntityKey = string;

/** Identifier of one occurrence (node) of an entity inside the structure. */
export type NodeId = string;

/** Raw identity value accepted from consumer data before normalization. */
export type IdentityValue = string | number;

/** The single central record of an entity. */
export interface EntityRecord<TEntity> {
  readonly key: EntityKey;
  readonly data: TEntity;
}

/**
 * One occurrence of an entity inside the structure. The relationship belongs to
 * the occurrence (the link with its parent), never to the entity.
 */
export interface StructureNode<TRelationship> {
  readonly id: NodeId;
  readonly entityKey: EntityKey;
  readonly parentId: NodeId | null;
  readonly childIds: readonly NodeId[];
  readonly relationship: TRelationship;
}

/** Canonical, normalized and immutable state. */
export interface StructureState<TEntity, TRelationship> {
  readonly entities: Readonly<Record<EntityKey, EntityRecord<TEntity>>>;
  readonly nodes: Readonly<Record<NodeId, StructureNode<TRelationship>>>;
  readonly rootIds: readonly NodeId[];
}

/** Nested, derived view of the structure (see `toTree`). Never stored. */
export interface TreeNode<TEntity, TRelationship> {
  readonly id: NodeId;
  readonly entityKey: EntityKey;
  readonly entity: TEntity;
  readonly relationship: TRelationship;
  readonly children: readonly TreeNode<TEntity, TRelationship>[];
}

/** A node together with its central entity data, handed to validators. */
export interface NodeView<TEntity, TRelationship> extends StructureNode<TRelationship> {
  readonly entity: TEntity;
}

// ---------------------------------------------------------------------------
// Result and validation
// ---------------------------------------------------------------------------

export type Result<TValue, TError> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly errors: TError };

export interface ValidationIssue {
  readonly code: ErrorCode;
  readonly message: string;
  readonly category: ErrorCategory;
  readonly nodeId?: NodeId;
  readonly entityKey?: EntityKey;
  /** Node ids from the root down to `nodeId`, when applicable. */
  readonly path?: readonly NodeId[];
  /** Id of the relationship rule that produced the issue, when applicable. */
  readonly ruleId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ValidationError = ValidationIssue;
export type ValidationWarning = ValidationIssue;

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
}

/** Verdict returned by consumer-provided validators and relationship predicates. */
export type Verdict =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code?: string;
      readonly message?: string;
      /** `"warning"` reports the issue without blocking the operation. */
      readonly severity?: "error" | "warning";
      readonly details?: Readonly<Record<string, unknown>>;
    };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type StructureEvent<TEntity, TRelationship> =
  | { readonly type: "ENTITY_REGISTERED"; readonly key: EntityKey; readonly entity: TEntity }
  | {
      readonly type: "ENTITY_UPDATED";
      readonly key: EntityKey;
      readonly previous: TEntity;
      readonly next: TEntity;
    }
  | {
      readonly type: "ENTITY_REKEYED";
      readonly previousKey: EntityKey;
      readonly key: EntityKey;
      readonly previous: TEntity;
      readonly next: TEntity;
      readonly nodeIds: readonly NodeId[];
    }
  | { readonly type: "ENTITY_REMOVED"; readonly key: EntityKey; readonly entity: TEntity }
  | {
      readonly type: "NODE_ADDED";
      readonly nodeId: NodeId;
      readonly entityKey: EntityKey;
      readonly parentId: NodeId | null;
      readonly index: number;
    }
  | {
      readonly type: "NODE_REMOVED";
      readonly nodeId: NodeId;
      readonly entityKey: EntityKey;
      readonly parentId: NodeId | null;
      readonly node: StructureNode<TRelationship>;
    }
  | {
      readonly type: "NODE_MOVED";
      readonly nodeId: NodeId;
      readonly from: { readonly parentId: NodeId | null; readonly index: number };
      readonly to: { readonly parentId: NodeId | null; readonly index: number };
    }
  | {
      readonly type: "RELATIONSHIP_UPDATED";
      readonly nodeId: NodeId;
      readonly previous: TRelationship;
      readonly next: TRelationship;
    };

export type StructureEventType = StructureEvent<unknown, unknown>["type"];

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type OperationName =
  | "registerEntity"
  | "updateEntity"
  | "rekeyEntity"
  | "removeEntity"
  | "addNode"
  | "removeNode"
  | "moveNode"
  | "updateRelationship";

export interface OperationSuccess<TEntity, TRelationship> {
  readonly state: StructureState<TEntity, TRelationship>;
  readonly events: readonly StructureEvent<TEntity, TRelationship>[];
  readonly warnings: readonly ValidationWarning[];
}

export type OperationResult<TEntity, TRelationship, TExtra = object> = Result<
  OperationSuccess<TEntity, TRelationship> & TExtra,
  readonly ValidationError[]
>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Keys of `T` whose values can be used as an identity. */
export type IdentityProperty<TEntity> = {
  [K in keyof TEntity]-?: NonNullable<TEntity[K]> extends IdentityValue ? K : never;
}[keyof TEntity] &
  string;

export type IdentityConfig<TEntity> =
  | {
      readonly key: IdentityProperty<TEntity>;
      readonly getKey?: never;
      /** Applied to `String(rawValue)`; the result is the `EntityKey`. */
      readonly normalize?: (value: string) => string;
    }
  | {
      readonly key?: never;
      /** Return a composite or derived identity. */
      readonly getKey: (entity: TEntity) => IdentityValue | null | undefined;
      readonly normalize?: (value: string) => string;
    };

type Primitive = string | number | boolean | bigint | null | undefined;

/**
 * Declarative matcher: each listed property is compared with `===` (or "one of"
 * when an array is given). Only primitive properties can be matched
 * declaratively; anything else must use a predicate function.
 */
export type EntityPropertyMatcher<TEntity> = {
  readonly [K in keyof TEntity]?: TEntity[K] extends Primitive
    ? TEntity[K] | readonly TEntity[K][]
    : never;
};

export type EntityMatcher<TEntity> =
  | EntityPropertyMatcher<TEntity>
  | ((entity: TEntity) => boolean);

export interface RelationshipContext<TEntity, TRelationship> {
  readonly parent: EntityRecord<TEntity>;
  readonly child: EntityRecord<TEntity>;
  /** Undefined for compatibility queries (`canRelate`, `getAllowedChildren`...). */
  readonly parentNode: StructureNode<TRelationship> | undefined;
  readonly childNode: StructureNode<TRelationship> | undefined;
  /** Undefined for compatibility queries that have no concrete link. */
  readonly relationship: TRelationship | undefined;
  readonly operation: OperationName | "validateStructure" | "query";
  readonly state: StructureState<TEntity, TRelationship> | undefined;
  /** Auxiliary data supplied by the consumer on the operation input. */
  readonly context: unknown;
}

export interface RelationshipRule<TEntity, TRelationship> {
  /** Reported as `ruleId` on errors. Defaults to `rule[<index>]`. */
  readonly id?: string;
  /** Omitted = matches any parent. */
  readonly parent?: EntityMatcher<TEntity>;
  /** Omitted = matches any child. */
  readonly child?: EntityMatcher<TEntity>;
  /** Optional extra condition (e.g. on the relationship metadata). */
  readonly when?: (context: RelationshipContext<TEntity, TRelationship>) => boolean;
  readonly allowed: boolean;
  /** Custom error code / message for a deny rule. */
  readonly code?: string;
  readonly message?: string;
}

export type RulesMode = "permissive" | "restrictive";

export interface RelationshipsConfig<TEntity, TRelationship> {
  readonly rules?: readonly RelationshipRule<TEntity, TRelationship>[];
  /** Behaviour when no rule matches a link. Default: `"restrictive"`. */
  readonly mode?: RulesMode;
  /** Always executed, for every link, regardless of the declarative outcome. */
  readonly validate?: (context: RelationshipContext<TEntity, TRelationship>) => Verdict;
}

export interface ValidatorContext<TEntity, TRelationship> {
  readonly node: NodeView<TEntity, TRelationship>;
  readonly parent: NodeView<TEntity, TRelationship> | null;
  readonly children: readonly NodeView<TEntity, TRelationship>[];
  readonly state: StructureState<TEntity, TRelationship>;
  readonly operation: OperationName | "validateStructure";
  readonly context: unknown;
}

export type StructureValidator<TEntity, TRelationship> = (
  context: ValidatorContext<TEntity, TRelationship>,
) => Verdict | readonly Verdict[];

export interface PoliciesConfig {
  /** Same identity twice among the children of one parent. Default `"deny"`. */
  readonly siblingDuplicates?: "deny" | "allow";
  /**
   * `"block"` (default): an entity can only be removed when no node references it.
   * `"when-unreferenced"`: like block, and entities are also removed automatically
   * when their last occurrence is removed.
   * `"force"`: `removeEntity` also removes every occurrence (with descendants).
   */
  readonly entityRemoval?: "block" | "when-unreferenced" | "force";
  /** Cycles in the entity graph (X → Y → X through any occurrences). Default `"deny"`. */
  readonly identityCycles?: "deny" | "allow";
  /** Maximum node depth (roots have depth 0). Unlimited when omitted. */
  readonly maxDepth?: number;
}

export interface EntityStructureConfig<TEntity, TRelationship> {
  readonly identity: IdentityConfig<TEntity>;
  readonly relationships?: RelationshipsConfig<TEntity, TRelationship>;
  readonly validators?: readonly StructureValidator<TEntity, TRelationship>[];
  readonly policies?: PoliciesConfig;
  /** Node id generator. Default: `crypto.randomUUID()` when available. */
  readonly createId?: () => NodeId;
}
