import { resolveConfig, type ResolvedConfig } from "./config.js";
import { coreError } from "./errors.js";
import { resolveIdentity } from "./identity.js";
import { getOwn, hasOwn } from "./internal.js";
import { evaluateLink, verdictIssue } from "./rules.js";
import { collectSubtree, nodeSource, pathTo } from "./tree.js";
import type {
  EntityKey,
  EntityStructureConfig,
  NodeId,
  NodeView,
  OperationName,
  StructureNode,
  StructureState,
  ValidationError,
  ValidationResult,
  ValidationWarning,
  Verdict,
} from "./types.js";

/** What an operation touched; the pipeline validates exactly this scope. */
export interface ChangeScope {
  /** Nodes whose position, entity or relationship changed (or whose children changed). */
  readonly nodeIds: Iterable<NodeId>;
  /** Registry records that were created or changed. */
  readonly entityKeys?: Iterable<EntityKey>;
}

export interface PipelineOutcome {
  readonly errors: ValidationError[];
  readonly warnings: ValidationWarning[];
}

/**
 * The single validation pipeline every mutation goes through, run against the
 * candidate state: structure → identity → relationships → consumer validators.
 * Structure and identity errors stop the pipeline (later stages assume a sound
 * state); relationship and consumer stages always run together.
 */
export function validateChange<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  scope: ChangeScope,
  config: EntityStructureConfig<TEntity, TRelationship>,
  operation: OperationName | "validateStructure",
  context: unknown,
): PipelineOutcome {
  const resolved = resolveConfig(config);
  const getNode = nodeSource(state);
  const dirty: StructureNode<TRelationship>[] = [];
  for (const id of new Set(scope.nodeIds)) {
    const node = getNode(id);
    if (node !== undefined) dirty.push(node);
  }
  const outcome: PipelineOutcome = { errors: [], warnings: [] };

  // 1. Structure
  checkReferences(state, dirty, outcome);
  checkDepth(state, dirty, resolved, outcome);
  if (resolved.identityCycles === "deny" && dirty.length > 0) {
    checkIdentityCycles(state, dirty, outcome);
  }
  if (outcome.errors.length > 0) return outcome;

  // 2. Identity
  for (const key of new Set(scope.entityKeys ?? [])) {
    const record = getOwn(state.entities, key);
    if (record === undefined) continue;
    const resolvedKey = resolveIdentity(record.data, config);
    if (!resolvedKey.ok) {
      outcome.errors.push(...resolvedKey.errors.map((error) => ({ ...error, entityKey: key })));
    } else if (resolvedKey.value !== key || record.key !== key) {
      outcome.errors.push(
        coreError("IDENTITY_MISMATCH", `Entity "${key}" resolves to identity "${resolvedKey.value}".`, {
          entityKey: key,
          details: { resolvedKey: resolvedKey.value },
        }),
      );
    }
  }
  if (outcome.errors.length > 0) return outcome;

  // 3. Relationships
  if (resolved.siblingDuplicates === "deny") checkSiblingDuplicates(state, dirty, outcome);
  checkLinks(state, dirty, resolved, operation, context, outcome);

  // 4. Consumer validators
  if (resolved.validators.length > 0) runValidators(state, dirty, resolved, operation, context, outcome);

  return outcome;
}

/** Re-evaluates the rules for every link into and out of the touched nodes. */
function checkLinks<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  dirty: readonly StructureNode<TRelationship>[],
  resolved: ResolvedConfig<TEntity, TRelationship>,
  operation: OperationName | "validateStructure",
  context: unknown,
  outcome: PipelineOutcome,
): void {
  const getNode = nodeSource(state);
  const links = new Set<NodeId>(); // identified by the child node
  for (const node of dirty) {
    if (node.parentId !== null) links.add(node.id);
    for (const childId of node.childIds) links.add(childId);
  }
  for (const childId of links) {
    const childNode = getNode(childId);
    const parentNode = childNode?.parentId == null ? undefined : getNode(childNode.parentId);
    if (childNode === undefined || parentNode === undefined) continue;
    const parent = getOwn(state.entities, parentNode.entityKey);
    const child = getOwn(state.entities, childNode.entityKey);
    if (parent === undefined || child === undefined) continue;
    const result = evaluateLink(
      {
        parent,
        child,
        parentNode,
        childNode,
        relationship: childNode.relationship,
        operation,
        state,
        context,
      },
      resolved,
      { nodeId: childId },
    );
    if (result.errors.length > 0 || result.warnings.length > 0) {
      const path = errorPath(state, childId); // computed only when reporting
      outcome.errors.push(...result.errors.map((issue) => ({ ...issue, path })));
      outcome.warnings.push(...result.warnings.map((issue) => ({ ...issue, path })));
    }
  }
}

function view<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  node: StructureNode<TRelationship>,
): NodeView<TEntity, TRelationship> | undefined {
  const record = getOwn(state.entities, node.entityKey);
  return record === undefined ? undefined : { ...node, entity: record.data };
}

/** Runs consumer validators on each touched node and on its parent. */
function runValidators<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  dirty: readonly StructureNode<TRelationship>[],
  resolved: ResolvedConfig<TEntity, TRelationship>,
  operation: OperationName | "validateStructure",
  context: unknown,
  outcome: PipelineOutcome,
): void {
  const getNode = nodeSource(state);
  const targets = new Set<NodeId>();
  for (const node of dirty) {
    targets.add(node.id);
    if (node.parentId !== null) targets.add(node.parentId);
  }
  for (const id of targets) {
    const node = getNode(id);
    const nodeView = node === undefined ? undefined : view(state, node);
    if (node === undefined || nodeView === undefined) continue;
    const parentNode = node.parentId === null ? undefined : getNode(node.parentId);
    const parent = parentNode === undefined ? null : (view(state, parentNode) ?? null);
    const children: NodeView<TEntity, TRelationship>[] = [];
    for (const childId of node.childIds) {
      const childNode = getNode(childId);
      const childView = childNode === undefined ? undefined : view(state, childNode);
      if (childView !== undefined) children.push(childView);
    }
    const validatorContext = { node: nodeView, parent, children, state, operation, context };
    for (const validator of resolved.validators) {
      const returned = validator(validatorContext);
      const verdicts: readonly Verdict[] = isVerdictList(returned) ? returned : [returned];
      for (const verdict of verdicts) {
        const result = verdictIssue(
          verdict,
          { code: "VALIDATION_FAILED", message: `Validation failed for node "${id}".`, category: "domain" },
          { nodeId: id, entityKey: node.entityKey },
        );
        if (result !== undefined) {
          const issue = { ...result.issue, path: errorPath(state, id) };
          (result.severity === "warning" ? outcome.warnings : outcome.errors).push(issue);
        }
      }
    }
  }
}

function isVerdictList(value: Verdict | readonly Verdict[]): value is readonly Verdict[] {
  return Array.isArray(value);
}

/**
 * Full validation of a state: referential integrity first (dangling
 * references, inconsistent parent/child links, unreachable nodes, registry
 * keys), then the complete pipeline over every node and entity.
 */
export function validateStructure<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  config: EntityStructureConfig<TEntity, TRelationship>,
  options: { readonly context?: unknown } = {},
): ValidationResult {
  const integrity = checkIntegrity(state);
  if (integrity.length > 0) return { valid: false, errors: integrity, warnings: [] };
  const outcome = validateChange(
    state,
    { nodeIds: Object.keys(state.nodes), entityKeys: Object.keys(state.entities) },
    config,
    "validateStructure",
    options.context,
  );
  return { valid: outcome.errors.length === 0, ...outcome };
}

function checkIntegrity<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const getNode = nodeSource(state);
  const inconsistent = (message: string, nodeId?: NodeId): void => {
    errors.push(coreError("INCONSISTENT_LINK", message, nodeId === undefined ? {} : { nodeId }));
  };

  for (const [key, record] of Object.entries(state.entities)) {
    if (record.key !== key) {
      errors.push(
        coreError("IDENTITY_MISMATCH", `Registry entry "${key}" holds a record keyed "${record.key}".`, {
          entityKey: key,
        }),
      );
    }
  }

  const seenRoots = new Set<NodeId>();
  for (const rootId of state.rootIds) {
    const root = getNode(rootId);
    if (seenRoots.has(rootId)) inconsistent(`Root "${rootId}" is listed twice.`, rootId);
    seenRoots.add(rootId);
    if (root === undefined) {
      errors.push(coreError("DANGLING_REFERENCE", `Root "${rootId}" does not exist.`, { nodeId: rootId }));
    } else if (root.parentId !== null) {
      inconsistent(`Root "${rootId}" has parent "${root.parentId}".`, rootId);
    }
  }

  for (const [id, node] of Object.entries(state.nodes)) {
    if (node.id !== id) inconsistent(`Node stored as "${id}" has id "${node.id}".`, id);
    if (!hasOwn(state.entities, node.entityKey)) {
      errors.push(
        coreError("DANGLING_REFERENCE", `Node "${id}" references unknown entity "${node.entityKey}".`, {
          nodeId: id,
          entityKey: node.entityKey,
        }),
      );
    }
    if (node.parentId === null) {
      if (!seenRoots.has(id)) inconsistent(`Node "${id}" has no parent but is not a root.`, id);
    } else {
      const parent = getNode(node.parentId);
      if (parent === undefined) {
        errors.push(
          coreError("DANGLING_REFERENCE", `Node "${id}" references unknown parent "${node.parentId}".`, {
            nodeId: id,
          }),
        );
      } else if (!parent.childIds.includes(id)) {
        inconsistent(`Node "${id}" is missing from the children of "${node.parentId}".`, id);
      }
    }
    const seenChildren = new Set<NodeId>();
    for (const childId of node.childIds) {
      if (seenChildren.has(childId)) inconsistent(`Child "${childId}" is listed twice in "${id}".`, id);
      seenChildren.add(childId);
      const child = getNode(childId);
      if (child === undefined) {
        errors.push(coreError("DANGLING_REFERENCE", `Node "${id}" lists unknown child "${childId}".`, { nodeId: id }));
      } else if (child.parentId !== id) {
        inconsistent(`Child "${childId}" of "${id}" points to parent "${String(child.parentId)}".`, childId);
      }
    }
  }
  if (errors.length > 0) return errors;

  // Every node must be reachable from the roots exactly once (also catches parent cycles).
  const reached = new Set<NodeId>();
  for (const rootId of state.rootIds) {
    for (const id of collectSubtree(getNode, rootId)) reached.add(id);
  }
  for (const id of Object.keys(state.nodes)) {
    if (!reached.has(id)) inconsistent(`Node "${id}" is not reachable from any root.`, id);
  }
  return errors;
}

function errorPath<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  nodeId: NodeId,
): readonly NodeId[] {
  return pathTo(nodeSource(state), nodeId);
}

function checkReferences<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  dirty: readonly StructureNode<TRelationship>[],
  outcome: PipelineOutcome,
): void {
  for (const node of dirty) {
    if (getOwn(state.entities, node.entityKey) === undefined) {
      outcome.errors.push(
        coreError("DANGLING_REFERENCE", `Node "${node.id}" references unknown entity "${node.entityKey}".`, {
          nodeId: node.id,
          entityKey: node.entityKey,
        }),
      );
    }
  }
}

function checkDepth<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  dirty: readonly StructureNode<TRelationship>[],
  resolved: ResolvedConfig<TEntity, TRelationship>,
  outcome: PipelineOutcome,
): void {
  if (resolved.maxDepth === Number.POSITIVE_INFINITY) return;
  const getNode = nodeSource(state);
  const memo = new Map<NodeId, number>();
  const depthOf = (start: StructureNode<TRelationship>): number => {
    const chain: NodeId[] = [];
    let current: StructureNode<TRelationship> | undefined = start;
    let base = -1;
    while (current !== undefined) {
      const known = memo.get(current.id);
      if (known !== undefined) {
        base = known;
        break;
      }
      chain.push(current.id);
      current = current.parentId === null ? undefined : getNode(current.parentId);
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      base += 1;
      const id = chain[i];
      if (id !== undefined) memo.set(id, base);
    }
    return memo.get(start.id) ?? 0;
  };
  for (const node of dirty) {
    const depth = depthOf(node);
    if (depth > resolved.maxDepth) {
      outcome.errors.push(
        coreError("MAX_DEPTH_EXCEEDED", `Node "${node.id}" is at depth ${depth}; max is ${resolved.maxDepth}.`, {
          nodeId: node.id,
          entityKey: node.entityKey,
          path: errorPath(state, node.id),
          details: { depth, maxDepth: resolved.maxDepth },
        }),
      );
    }
  }
}

/**
 * Detects a cycle in the entity graph (parent identity → child identity across
 * every occurrence), e.g. X → Y → X through different occurrences. Iterative DFS.
 */
function checkIdentityCycles<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  dirty: readonly StructureNode<TRelationship>[],
  outcome: PipelineOutcome,
): void {
  const getNode = nodeSource(state);
  const dirtyIds = new Set(dirty.map((node) => node.id));
  const adjacency = new Map<EntityKey, Set<EntityKey>>();
  const edgeNode = new Map<string, NodeId>();
  const edgeId = (from: EntityKey, to: EntityKey): string => `${from}\u0000${to}`;

  for (const node of Object.values(state.nodes)) {
    if (node.parentId === null) continue;
    const parent = getNode(node.parentId);
    if (parent === undefined) continue;
    let targets = adjacency.get(parent.entityKey);
    if (targets === undefined) {
      targets = new Set();
      adjacency.set(parent.entityKey, targets);
    }
    targets.add(node.entityKey);
    const id = edgeId(parent.entityKey, node.entityKey);
    if (!edgeNode.has(id) || dirtyIds.has(node.id)) edgeNode.set(id, node.id);
  }

  const color = new Map<EntityKey, 1 | 2>(); // 1 = on stack, 2 = done
  for (const start of adjacency.keys()) {
    if (color.has(start)) continue;
    const stack: { key: EntityKey; iterator: Iterator<EntityKey> }[] = [];
    const push = (key: EntityKey): void => {
      color.set(key, 1);
      stack.push({ key, iterator: (adjacency.get(key) ?? new Set<EntityKey>()).values() });
    };
    push(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const next = frame.iterator.next();
      if (next.done === true) {
        color.set(frame.key, 2);
        stack.pop();
        continue;
      }
      const target = next.value;
      const mark = color.get(target);
      if (mark === undefined) {
        push(target);
      } else if (mark === 1) {
        const startIndex = stack.findIndex((item) => item.key === target);
        const cycle = stack.slice(startIndex).map((item) => item.key);
        const edges: string[] = cycle.map((key, i) => edgeId(key, cycle[i + 1] ?? target));
        const dirtyEdge = edges.findIndex((id) => dirtyIds.has(edgeNode.get(id) ?? ""));
        const reportIndex = dirtyEdge === -1 ? edges.length - 1 : dirtyEdge;
        const reportEdge = edges[reportIndex];
        const nodeId = reportEdge === undefined ? undefined : edgeNode.get(reportEdge);
        // Start the reported cycle at the child of the offending link: "a → b → a".
        const startAt = (reportIndex + 1) % cycle.length;
        const ordered = [...cycle.slice(startAt), ...cycle.slice(0, startAt)];
        const shown = [...ordered, ordered[0] ?? target];
        outcome.errors.push(
          coreError("IDENTITY_CYCLE", `Identity cycle: ${shown.join(" → ")}.`, {
            ...(nodeId === undefined ? {} : { nodeId, path: errorPath(state, nodeId) }),
            details: { cycle: shown },
          }),
        );
        return;
      }
    }
  }
}

function checkSiblingDuplicates<TEntity, TRelationship>(
  state: StructureState<TEntity, TRelationship>,
  dirty: readonly StructureNode<TRelationship>[],
  outcome: PipelineOutcome,
): void {
  const getNode = nodeSource(state);
  const groups = new Set<NodeId | null>();
  for (const node of dirty) {
    groups.add(node.parentId);
    groups.add(node.id);
  }
  const reported = new Set<NodeId>();
  for (const parentId of groups) {
    const siblings = parentId === null ? state.rootIds : (getNode(parentId)?.childIds ?? []);
    const seen = new Map<EntityKey, NodeId>();
    for (const childId of siblings) {
      const child = getNode(childId);
      if (child === undefined) continue;
      const first = seen.get(child.entityKey);
      if (first === undefined) {
        seen.set(child.entityKey, childId);
      } else if (!reported.has(childId)) {
        reported.add(childId);
        outcome.errors.push(
          coreError(
            "SIBLING_DUPLICATE",
            `Entity "${child.entityKey}" already appears under ${parentId === null ? "the root" : `node "${parentId}"`}.`,
            {
              nodeId: childId,
              entityKey: child.entityKey,
              path: errorPath(state, childId),
              details: { parentId, existingNodeId: first },
            },
          ),
        );
      }
    }
  }
}
