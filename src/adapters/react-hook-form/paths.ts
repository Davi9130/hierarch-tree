import type { EntityKey, NodeId, StructureState, ValidationError } from "../../index.js";

/**
 * Form field paths. The form value is the core `StructureState` itself, so
 * every path is keyed by `node.id` / `entity.key`, never by an array index:
 * a path stays the same when the node moves to another parent.
 */
export const nodePath = (nodeId: NodeId): `nodes.${string}` => `nodes.${nodeId}`;
export const childIdsPath = (parentId: NodeId | null): "rootIds" | `nodes.${string}.childIds` =>
  parentId === null ? "rootIds" : `nodes.${parentId}.childIds`;
export const relationshipPath = (nodeId: NodeId): `nodes.${string}.relationship` => `nodes.${nodeId}.relationship`;
export const entityPath = (key: EntityKey): `entities.${string}` => `entities.${key}`;
export const entityDataPath = (key: EntityKey): `entities.${string}.data` => `entities.${key}.data`;

/** Error code returned when a node id or entity key cannot be a form path segment. */
export const FIELD_PATH_UNSAFE = "FIELD_PATH_UNSAFE";

// React Hook Form splits paths on `.`, `[`, `]` and quotes, and ignores
// prototype keywords, so ids/keys containing them would address the wrong value.
const UNSAFE_SEGMENT = /[.[\]'"]/;
const PROTOTYPE_KEYWORDS = new Set(["__proto__", "constructor", "prototype"]);

export function isSafePathSegment(segment: string): boolean {
  return segment !== "" && !UNSAFE_SEGMENT.test(segment) && !PROTOTYPE_KEYWORDS.has(segment);
}

function unsafe(kind: "node id" | "entity key", value: string): ValidationError {
  return {
    code: FIELD_PATH_UNSAFE,
    category: "structure",
    message:
      `The ${kind} "${value}" cannot be used as a React Hook Form path segment ` +
      `(it must not be empty, contain . [ ] ' " or be __proto__/constructor/prototype). ` +
      `Normalize the identity or use another createId.`,
    ...(kind === "node id" ? { nodeId: value } : { entityKey: value }),
  };
}

/** Path-safety errors for the given ids/keys (all of the state when omitted). */
export function checkPathSegments<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  only?: { readonly nodeIds: Iterable<NodeId>; readonly entityKeys: Iterable<EntityKey> },
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of only?.entityKeys ?? Object.keys(state.entities)) {
    if (!isSafePathSegment(key)) errors.push(unsafe("entity key", key));
  }
  for (const id of only?.nodeIds ?? Object.keys(state.nodes)) {
    if (!isSafePathSegment(id)) errors.push(unsafe("node id", id));
  }
  return errors;
}
