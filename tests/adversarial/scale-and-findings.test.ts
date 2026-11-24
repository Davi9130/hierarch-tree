/**
 * TES-29 — large/deep structures (no stack overflow) and probes for the
 * findings reported on the issue.
 */
import { describe, expect, it } from "vitest";
import {
  addNode,
  createEmptyState,
  createEntityStructure,
  getAllEntities,
  getAncestors,
  getDepth,
  getDescendants,
  getPath,
  getRoot,
  moveNode,
  removeNode,
  toTree,
  updateEntity,
  validateStructure,
} from "../../src/index.js";
import { codes, expectFailure, sequentialIds, unwrap } from "../helpers.js";
import { chainState, config, group, leaf, rel, sample, wideState, type Ent, type S } from "./fixtures.js";

const DEPTH = 10_000;

describe("scale: 10k-deep chain built in normalized form", () => {
  const cfg = config();
  const s = chainState(DEPTH);
  const last = `c${DEPTH - 1}`;

  it("validateStructure, search and toTree do not overflow the stack", () => {
    expect(validateStructure(s, cfg).valid).toBe(true);
    expect(getDepth(s, last)).toBe(DEPTH - 1);
    expect(getPath(s, last)).toHaveLength(DEPTH);
    expect(getAncestors(s, last)).toHaveLength(DEPTH - 1);
    expect(getRoot(s, last)?.id).toBe("c0");
    expect(getDescendants(s, "c0")).toHaveLength(DEPTH - 1);
    let depth = 0;
    let level = toTree(s)[0];
    while (level !== undefined && level.children.length > 0) {
      depth += 1;
      level = level.children[0];
    }
    expect(depth).toBe(DEPTH - 1);
  });

  it("mutations at the bottom of the chain work (cycle check, identity cycles, maxDepth)", () => {
    const added = unwrap(addNode(s, { entity: group("tail"), parentId: last, relationship: rel(1) }, cfg));
    expect(getDepth(added.state, added.nodeId)).toBe(DEPTH);
    expect(codes(expectFailure(moveNode(s, { nodeId: "c0", newParentId: last }, cfg)))).toEqual(["CYCLE_DETECTED"]);
    expect(codes(expectFailure(addNode(s, { entityKey: "e0", parentId: last, relationship: rel(1) }, cfg)))).toEqual([
      "IDENTITY_CYCLE",
    ]);
    const limited = config({ policies: { maxDepth: DEPTH - 1 } });
    expect(codes(expectFailure(addNode(s, { entity: group("tail"), parentId: last, relationship: rel(1) }, limited)))).toEqual([
      "MAX_DEPTH_EXCEEDED",
    ]);
  });

  it("moving / removing a 10k subtree works", () => {
    const moved = unwrap(moveNode(s, { nodeId: "c1", newParentId: null }, cfg)).state;
    expect(moved.rootIds).toEqual(["c0", "c1"]);
    expect(validateStructure(moved, cfg).valid).toBe(true);
    const removed = unwrap(removeNode(s, { nodeId: "c1" }, cfg)).state;
    expect(Object.keys(removed.nodes)).toEqual(["c0"]);
  });

  it("removeNode cascade with when-unreferenced clears 10k entities", () => {
    const policy = config({ policies: { entityRemoval: "when-unreferenced" } });
    const removed = unwrap(removeNode(s, { nodeId: "c0" }, policy)).state;
    expect(Object.keys(removed.entities)).toHaveLength(0);
  });
});

describe("scale: 10k siblings under one parent", () => {
  it("validates, adds, moves and removes on a 10k-wide level", () => {
    const cfg = config();
    const s = wideState(DEPTH);
    expect(validateStructure(s, cfg).valid).toBe(true);
    const added = unwrap(addNode(s, { entity: leaf("extra"), parentId: "w-root", relationship: rel(0) }, cfg));
    expect(added.state.nodes["w-root"]?.childIds).toHaveLength(DEPTH + 1);
    // sibling duplicate detected among 10k children
    expect(codes(expectFailure(addNode(s, { entityKey: "k-w9999", parentId: "w-root", relationship: rel(0) }, cfg)))).toEqual([
      "SIBLING_DUPLICATE",
    ]);
    const moved = unwrap(moveNode(s, { nodeId: "w9999", newParentId: "w-root", index: 0 }, cfg)).state;
    expect(moved.nodes["w-root"]?.childIds[0]).toBe("w9999");
    const removed = unwrap(removeNode(s, { nodeId: "w-root" }, cfg)).state;
    expect(removed.rootIds).toEqual([]);
  });

  it("builds 1k nodes through the public wrapper (operations only)", () => {
    const structure = createEntityStructure(config({ createId: sequentialIds() }));
    const root = unwrap(structure.addNode({ entity: group("root"), relationship: rel(0) })).nodeId;
    for (let i = 0; i < 1_000; i += 1) {
      unwrap(structure.addNode({ entity: leaf(`k${i}`), parentId: root, relationship: rel(0) }));
    }
    expect(structure.getChildren(root)).toHaveLength(1_000);
    expect(structure.validateStructure().valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Findings. Tests marked `it.fails` document current behaviour that the report
// flags as a defect; they start failing (and must be flipped to `it`) once fixed.
// ---------------------------------------------------------------------------

describe("findings", () => {
  it("F1: a registered entity or relationship cannot be mutated in place (frozen state)", () => {
    const cfg = config();
    const s = sample(cfg);
    const data = s.entities["L1"]?.data;
    if (data === undefined) throw new Error("fixture");
    // The state is frozen: an in-place mutation throws instead of bypassing the rules.
    expect(() => {
      (data as { kind: string }).kind = "group"; // leaf(X) → group(L1) would be denied by the rules
    }).toThrow(TypeError);
    expect(() => {
      (s.nodes["n2"]?.relationship as { share: number }).share = 99;
    }).toThrow(TypeError);
    expect(() => {
      (s.nodes["n1"]?.childIds as string[]).push("n6");
    }).toThrow(TypeError);
    expect(Object.isFrozen(s) && Object.isFrozen(s.entities) && Object.isFrozen(s.nodes)).toBe(true);
    expect(validateStructure(s, cfg).valid).toBe(true);
  });

  it("F1: mutating the object the consumer passed in does not reach the state (shallow copy)", () => {
    const cfg = config();
    const entity = leaf("K");
    const relationship = rel(10);
    const structure = createEntityStructure(cfg);
    unwrap(structure.addNode({ entity, relationship }));
    const before = structure.getState();
    entity.code = "K2"; // the consumer keeps a mutable object
    relationship.share = 99;
    expect(structure.getState()).toBe(before);
    expect(structure.findEntity("K")?.data.code).toBe("K");
    expect(Object.values(structure.getState().nodes)[0]?.relationship.share).toBe(10);
    expect(structure.validateStructure().valid).toBe(true);
  });

  it.fails("F2: declarative matchers ignore inherited/getter properties that identity resolution does read", () => {
    class Member {
      constructor(private readonly raw: { code: string; kind: "group" | "leaf" }) {}
      get code(): string {
        return this.raw.code;
      }
      get kind(): "group" | "leaf" {
        return this.raw.kind;
      }
    }
    const cfg = config() as unknown as Parameters<typeof addNode<Member, { share: number }>>[2];
    let s = createEmptyState<Member, { share: number }>();
    s = unwrap(addNode(s, { entity: new Member({ code: "G", kind: "group" }), relationship: rel(0) }, cfg)).state;
    expect(s.entities["G"]).toBeDefined(); // identity read through the getter works
    // `group-any` should match parent.kind === "group", but `matches` uses hasOwn → no rule → restrictive deny.
    const added = addNode(s, { entity: new Member({ code: "L", kind: "leaf" }), parentId: "n1", relationship: rel(0) }, cfg);
    expect(added.ok).toBe(true);
  });

  it("F3 (evidence): getAllEntities is not in insertion order for integer-like keys", () => {
    const cfg = config();
    let s: S = createEmptyState();
    for (const code of ["b", "10", "a", "2"]) s = unwrap(addNode(s, { entity: group(code), relationship: rel(0) }, cfg)).state;
    expect(getAllEntities(s).map((record) => record.key)).toEqual(["2", "10", "b", "a"]);
  });

  it.fails("F4: a throwing subscriber makes a successful mutation look like a failure to the caller", () => {
    const structure = createEntityStructure(config());
    structure.subscribe(() => {
      throw new Error("listener bug");
    });
    let result: ReturnType<typeof structure.addNode> | undefined;
    try {
      result = structure.addNode({ entity: group("A"), relationship: rel(0) });
    } catch {
      // the caller gets an exception, but the state WAS committed
    }
    expect(structure.getState().rootIds).toHaveLength(1);
    expect(result?.ok).toBe(true); // fails: the caller never receives the result
  });

  it("F5 (evidence): config changes after first use are silently ignored (WeakMap cache)", () => {
    const rules: { id: string; parent: { kind: "group" }; allowed: boolean }[] = [];
    const cfg = config({ relationships: { mode: "restrictive", rules } });
    let s: S = createEmptyState();
    s = unwrap(addNode(s, { entity: group("P"), relationship: rel(0) }, cfg)).state;
    expect(addNode(s, { entity: leaf("C"), parentId: "n1", relationship: rel(0) }, cfg).ok).toBe(false);
    rules.push({ id: "late", parent: { kind: "group" }, allowed: true });
    expect(addNode(s, { entity: leaf("C"), parentId: "n1", relationship: rel(0) }, cfg).ok).toBe(false); // still denied
  });

  it("F6 (evidence): whitespace around a key is part of the identity unless normalize trims it", () => {
    const cfg = config();
    let s: S = createEmptyState();
    s = unwrap(addNode(s, { entity: group("ABC"), relationship: rel(0) }, cfg)).state;
    const padded = unwrap(addNode(s, { entity: group(" ABC "), relationship: rel(0) }, cfg));
    expect(Object.keys(padded.state.entities)).toEqual(["ABC", " ABC "]);
  });

  it("decision 2: addNode with an existing identity keeps the registered data and warns ENTITY_DATA_IGNORED", () => {
    const cfg = config();
    const s = sample(cfg);
    const result = unwrap(addNode(s, { entity: leaf("X", "NEW LABEL"), parentId: "n6", relationship: rel(0) }, cfg));
    expect(result.state.entities["X"]?.data.label).toBeUndefined();
    expect(codes(result.warnings)).toEqual(["ENTITY_DATA_IGNORED"]);
    expect(result.warnings[0]?.entityKey).toBe("X");
    // Equal data (a fresh but identical object) is not reported.
    const same = unwrap(addNode(s, { entity: leaf("X"), parentId: "n6", relationship: rel(0) }, cfg));
    expect(same.warnings).toEqual([]);
  });

  it("decision 3 (evidence): root links are never checked by rules or the relationship predicate", () => {
    let validated = 0;
    const cfg = config({
      relationships: {
        mode: "restrictive",
        rules: [{ id: "nothing-allowed", allowed: false }],
        validate: () => {
          validated += 1;
          return { valid: false };
        },
      },
    });
    const added = unwrap(addNode(createEmptyState<Ent, { share: number }>(), { entity: leaf("R"), relationship: rel(-50) }, cfg));
    expect(added.state.rootIds).toHaveLength(1);
    expect(validated).toBe(0);
    // updateEntity of a root-only entity is not checked either
    expect(updateEntity(added.state, { key: "R", data: group("R") }, cfg).ok).toBe(true);
  });
});
