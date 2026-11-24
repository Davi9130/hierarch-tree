import { describe, expect, it } from "vitest";
import { createEmptyState, type EntityStructureConfig, type StructureState } from "../src/index.js";
import { addNode, moveNode, removeNode, updateRelationship } from "../src/core/structure.js";
import { rekeyEntity, removeEntity, updateEntity } from "../src/core/entity-operations.js";
import { registerEntity } from "../src/core/registry.js";
import { codes, expectFailure, sequentialIds, unwrap } from "./helpers.js";

interface Item {
  id: string;
  name: string;
}
interface Link {
  weight: number;
}
type State = StructureState<Item, Link>;

function makeConfig(overrides: Partial<EntityStructureConfig<Item, Link>> = {}): EntityStructureConfig<Item, Link> {
  return {
    identity: { key: "id" },
    relationships: { mode: "permissive" },
    createId: sequentialIds(),
    ...overrides,
  };
}

const item = (id: string): Item => ({ id, name: id.toUpperCase() });

/** a(n1) → b(n2) → c(n3); d(n4) root. */
function build(config: EntityStructureConfig<Item, Link>): State {
  let state = createEmptyState<Item, Link>();
  state = unwrap(addNode(state, { entity: item("a"), relationship: { weight: 0 } }, config)).state;
  state = unwrap(addNode(state, { entity: item("b"), parentId: "n1", relationship: { weight: 1 } }, config)).state;
  state = unwrap(addNode(state, { entity: item("c"), parentId: "n2", relationship: { weight: 2 } }, config)).state;
  state = unwrap(addNode(state, { entity: item("d"), relationship: { weight: 0 } }, config)).state;
  return state;
}

describe("addNode", () => {
  it("registers new entities and creates occurrences with their own ids", () => {
    const config = makeConfig();
    const result = unwrap(addNode(createEmptyState<Item, Link>(), { entity: item("a"), relationship: { weight: 1 } }, config));
    expect(result.nodeId).toBe("n1");
    expect(result.state.rootIds).toEqual(["n1"]);
    expect(result.state.entities["a"]?.data).toEqual(item("a"));
    expect(result.events.map((event) => event.type)).toEqual(["ENTITY_REGISTERED", "NODE_ADDED"]);
  });

  it("inserts at a given index and rejects invalid indexes", () => {
    const config = makeConfig();
    let state = build(config);
    state = unwrap(addNode(state, { entity: item("e"), relationship: { weight: 0 }, index: 0 }, config)).state;
    expect(state.rootIds).toEqual(["n5", "n1", "n4"]);
    const errors = expectFailure(addNode(state, { entity: item("f"), relationship: { weight: 0 }, index: -1 }, config));
    expect(codes(errors)).toEqual(["INVALID_INDEX"]);
  });

  it("fails on unknown parent or unknown entity key", () => {
    const config = makeConfig();
    const state = build(config);
    expect(codes(expectFailure(addNode(state, { entity: item("x"), parentId: "nope", relationship: { weight: 0 } }, config)))).toEqual([
      "PARENT_NOT_FOUND",
    ]);
    expect(codes(expectFailure(addNode(state, { entityKey: "zzz", relationship: { weight: 0 } }, config)))).toEqual([
      "ENTITY_NOT_FOUND",
    ]);
  });

  it("rejects node id collisions from createId", () => {
    const config = makeConfig({ createId: () => "same" });
    const state = unwrap(addNode(createEmptyState<Item, Link>(), { entity: item("a"), relationship: { weight: 0 } }, config)).state;
    expect(codes(expectFailure(addNode(state, { entity: item("b"), relationship: { weight: 0 } }, config)))).toEqual([
      "NODE_ID_COLLISION",
    ]);
  });

  it("enforces maxDepth", () => {
    const config = makeConfig({ policies: { maxDepth: 1 } });
    let state = createEmptyState<Item, Link>();
    state = unwrap(addNode(state, { entity: item("a"), relationship: { weight: 0 } }, config)).state;
    state = unwrap(addNode(state, { entity: item("b"), parentId: "n1", relationship: { weight: 0 } }, config)).state;
    const errors = expectFailure(addNode(state, { entity: item("c"), parentId: "n2", relationship: { weight: 0 } }, config));
    expect(codes(errors)).toEqual(["MAX_DEPTH_EXCEEDED"]);
    expect(errors[0]?.path).toEqual(["n1", "n2", "n3"]);
  });
});

describe("scenario A — same entity in two positions", () => {
  it("keeps one central record and independent relationships per occurrence", () => {
    const config = makeConfig();
    let state = build(config);
    const first = unwrap(addNode(state, { entity: item("x"), parentId: "n1", relationship: { weight: 10 } }, config));
    state = first.state;
    const second = unwrap(addNode(state, { entity: { id: "x", name: "ignored" }, parentId: "n4", relationship: { weight: 20 } }, config));
    state = second.state;

    expect(Object.keys(state.entities).filter((key) => key === "x")).toHaveLength(1);
    expect(state.entities["x"]?.data.name).toBe("X");
    expect(second.events.map((event) => event.type)).toEqual(["NODE_ADDED"]);
    expect(state.nodes[first.nodeId]?.relationship).toEqual({ weight: 10 });
    expect(state.nodes[second.nodeId]?.relationship).toEqual({ weight: 20 });

    state = unwrap(updateRelationship(state, { nodeId: first.nodeId, relationship: { weight: 11 } }, config)).state;
    expect(state.nodes[first.nodeId]?.relationship).toEqual({ weight: 11 });
    expect(state.nodes[second.nodeId]?.relationship).toEqual({ weight: 20 });

    state = unwrap(updateEntity(state, { key: "x", data: { id: "x", name: "Renamed" } }, config)).state;
    expect(state.entities["x"]?.data.name).toBe("Renamed");
    expect(state.nodes[first.nodeId]?.entityKey).toBe("x");
    expect(state.nodes[second.nodeId]?.entityKey).toBe("x");
  });
});

describe("scenario B — sibling duplicates", () => {
  it("rejects the same identity twice under one parent (default policy)", () => {
    const config = makeConfig();
    let state = build(config);
    state = unwrap(addNode(state, { entity: item("x"), parentId: "n1", relationship: { weight: 1 } }, config)).state;
    const errors = expectFailure(addNode(state, { entityKey: "x", parentId: "n1", relationship: { weight: 2 } }, config));
    expect(codes(errors)).toEqual(["SIBLING_DUPLICATE"]);
  });

  it("applies to roots and to moves into a parent that already has the identity", () => {
    const config = makeConfig();
    let state = build(config);
    expect(codes(expectFailure(addNode(state, { entityKey: "a", relationship: { weight: 0 } }, config)))).toEqual([
      "SIBLING_DUPLICATE",
    ]);
    const other = unwrap(addNode(state, { entityKey: "b", parentId: "n4", relationship: { weight: 0 } }, config));
    state = other.state;
    expect(codes(expectFailure(moveNode(state, { nodeId: other.nodeId, newParentId: "n1" }, config)))).toEqual([
      "SIBLING_DUPLICATE",
    ]);
  });

  it("can be allowed by policy", () => {
    const config = makeConfig({ policies: { siblingDuplicates: "allow" } });
    let state = build(config);
    state = unwrap(addNode(state, { entityKey: "b", parentId: "n1", relationship: { weight: 2 } }, config)).state;
    expect(state.nodes["n1"]?.childIds).toHaveLength(2);
  });
});

describe("scenario D — moving", () => {
  it("preserves entity and descendants", () => {
    const config = makeConfig();
    const before = build(config);
    const result = unwrap(moveNode(before, { nodeId: "n2", newParentId: "n4" }, config));
    const state = result.state;
    expect(state.nodes["n2"]?.parentId).toBe("n4");
    expect(state.nodes["n2"]?.entityKey).toBe("b");
    expect(state.nodes["n2"]?.childIds).toEqual(["n3"]);
    expect(state.nodes["n3"]?.parentId).toBe("n2");
    expect(state.nodes["n1"]?.childIds).toEqual([]);
    expect(state.nodes["n4"]?.childIds).toEqual(["n2"]);
    expect(state.entities).toBe(before.entities);
    expect(result.events).toEqual([
      { type: "NODE_MOVED", nodeId: "n2", from: { parentId: "n1", index: 0 }, to: { parentId: "n4", index: 0 } },
    ]);
  });

  it("blocks moving into itself or a descendant (occurrence cycles)", () => {
    const config = makeConfig();
    const state = build(config);
    expect(codes(expectFailure(moveNode(state, { nodeId: "n1", newParentId: "n3" }, config)))).toEqual(["CYCLE_DETECTED"]);
    expect(codes(expectFailure(moveNode(state, { nodeId: "n1", newParentId: "n1" }, config)))).toEqual(["CYCLE_DETECTED"]);
  });

  it("moves to the roots and reorders within the same parent", () => {
    const config = makeConfig();
    let state = build(config);
    state = unwrap(moveNode(state, { nodeId: "n2", newParentId: null, index: 0 }, config)).state;
    expect(state.rootIds).toEqual(["n2", "n1", "n4"]);
    expect(state.nodes["n2"]?.parentId).toBeNull();
    state = unwrap(moveNode(state, { nodeId: "n2", newParentId: null }, config)).state;
    expect(state.rootIds).toEqual(["n1", "n4", "n2"]);
  });

  it("is a no-op when the position does not change", () => {
    const config = makeConfig();
    const state = build(config);
    const result = unwrap(moveNode(state, { nodeId: "n2", newParentId: "n1", index: 0 }, config));
    expect(result.state).toBe(state);
    expect(result.events).toEqual([]);
  });

  it("revalidates depth for the whole moved subtree", () => {
    const config = makeConfig({ policies: { maxDepth: 2 } });
    const state = build(config);
    // b(depth 1) → c(depth 2); moving b under c's sibling chain would push c to depth 3.
    const errors = expectFailure(moveNode(state, { nodeId: "n1", newParentId: "n4" }, config));
    expect(codes(errors)).toEqual(["MAX_DEPTH_EXCEEDED"]);
    expect(errors[0]?.nodeId).toBe("n3");
  });
});

describe("identity cycles", () => {
  it("blocks X → Y → X through different occurrences by default", () => {
    const config = makeConfig();
    const state = build(config); // a → b → c
    expect(codes(expectFailure(addNode(state, { entityKey: "a", parentId: "n3", relationship: { weight: 0 } }, config)))).toEqual([
      "IDENTITY_CYCLE",
    ]);
    // a → b in one branch, b → a in another branch is also a cycle.
    const b2 = unwrap(addNode(state, { entityKey: "b", parentId: "n4", relationship: { weight: 0 } }, config));
    const errors = expectFailure(addNode(b2.state, { entityKey: "a", parentId: b2.nodeId, relationship: { weight: 0 } }, config));
    expect(codes(errors)).toEqual(["IDENTITY_CYCLE"]);
    expect(errors[0]?.details?.["cycle"]).toEqual(["a", "b", "a"]);
    // Reported on the new (rejected) occurrence of "a" under the second "b".
    expect(errors[0]?.path?.slice(0, 2)).toEqual(["n4", b2.nodeId]);
    expect(b2.state.nodes[errors[0]?.nodeId ?? ""]).toBeUndefined();
  });

  it("blocks an entity under itself", () => {
    const config = makeConfig();
    const state = build(config);
    expect(codes(expectFailure(addNode(state, { entityKey: "a", parentId: "n1", relationship: { weight: 0 } }, config)))).toEqual([
      "IDENTITY_CYCLE",
    ]);
  });

  it("can be allowed by policy", () => {
    const config = makeConfig({ policies: { identityCycles: "allow" } });
    const state = build(config);
    expect(addNode(state, { entityKey: "a", parentId: "n3", relationship: { weight: 0 } }, config).ok).toBe(true);
  });
});

describe("removeNode", () => {
  it("cascades by default and keeps the central entities", () => {
    const config = makeConfig();
    const state = build(config);
    const result = unwrap(removeNode(state, { nodeId: "n1" }, config));
    expect(result.state.rootIds).toEqual(["n4"]);
    expect(Object.keys(result.state.nodes)).toEqual(["n4"]);
    expect(Object.keys(result.state.entities).sort()).toEqual(["a", "b", "c", "d"]);
    expect(result.events.map((event) => event.type)).toEqual(["NODE_REMOVED", "NODE_REMOVED", "NODE_REMOVED"]);
  });

  it("reparents children into the removed node's position", () => {
    const config = makeConfig();
    let state = build(config);
    state = unwrap(addNode(state, { entity: item("e"), parentId: "n1", relationship: { weight: 0 } }, config)).state; // n5
    state = unwrap(removeNode(state, { nodeId: "n1", children: "reparent" }, config)).state;
    expect(state.rootIds).toEqual(["n2", "n5", "n4"]);
    expect(state.nodes["n2"]?.parentId).toBeNull();
    expect(state.nodes["n3"]?.parentId).toBe("n2");
  });

  it("reparents children to an explicit target and blocks targets inside the subtree", () => {
    const config = makeConfig();
    const state = build(config);
    const moved = unwrap(removeNode(state, { nodeId: "n2", children: "reparent", reparentTo: "n4" }, config)).state;
    expect(moved.nodes["n4"]?.childIds).toEqual(["n3"]);
    expect(codes(expectFailure(removeNode(state, { nodeId: "n1", children: "reparent", reparentTo: "n3" }, config)))).toEqual([
      "CYCLE_DETECTED",
    ]);
  });

  it("garbage-collects unreferenced entities under the when-unreferenced policy", () => {
    const config = makeConfig({ policies: { entityRemoval: "when-unreferenced" } });
    let state = build(config);
    state = unwrap(addNode(state, { entityKey: "c", parentId: "n4", relationship: { weight: 0 } }, config)).state;
    const result = unwrap(removeNode(state, { nodeId: "n1" }, config));
    expect(Object.keys(result.state.entities).sort()).toEqual(["c", "d"]);
    expect(result.events.filter((event) => event.type === "ENTITY_REMOVED").map((event) => event.type)).toHaveLength(2);
  });

  it("fails for unknown nodes", () => {
    const config = makeConfig();
    expect(codes(expectFailure(removeNode(build(config), { nodeId: "zz" }, config)))).toEqual(["NODE_NOT_FOUND"]);
  });
});

describe("entity operations", () => {
  it("updateEntity refuses identity changes", () => {
    const config = makeConfig();
    const state = build(config);
    expect(codes(expectFailure(updateEntity(state, { key: "a", data: item("z") }, config)))).toEqual([
      "IDENTITY_CHANGE_REQUIRES_REKEY",
    ]);
  });

  it("rekeyEntity updates every occurrence and detects collisions", () => {
    const config = makeConfig();
    let state = build(config);
    state = unwrap(addNode(state, { entityKey: "c", parentId: "n4", relationship: { weight: 0 } }, config)).state; // n5
    const result = unwrap(rekeyEntity(state, { key: "c", data: item("z") }, config));
    expect(result.state.entities["c"]).toBeUndefined();
    expect(result.state.entities["z"]?.data).toEqual(item("z"));
    expect(result.state.nodes["n3"]?.entityKey).toBe("z");
    expect(result.state.nodes["n5"]?.entityKey).toBe("z");
    expect(codes(expectFailure(rekeyEntity(state, { key: "c", data: item("a") }, config)))).toEqual(["IDENTITY_COLLISION"]);
  });

  it("rekeyEntity validates the new identity and unknown keys", () => {
    const config = makeConfig();
    const state = build(config);
    expect(codes(expectFailure(rekeyEntity(state, { key: "c", data: item("") }, config)))).toEqual(["IDENTITY_EMPTY"]);
    expect(codes(expectFailure(rekeyEntity(state, { key: "nope", data: item("q") }, config)))).toEqual(["ENTITY_NOT_FOUND"]);
  });

  it("removeEntity blocks while referenced, unless forced", () => {
    const blocking = makeConfig();
    const state = build(blocking);
    const errors = expectFailure(removeEntity(state, { key: "b" }, blocking));
    expect(codes(errors)).toEqual(["ENTITY_IN_USE"]);
    expect(errors[0]?.details?.["nodeIds"]).toEqual(["n2"]);

    const unreferenced = unwrap(registerEntity(state, item("free"), blocking)).state;
    expect(unwrap(removeEntity(unreferenced, { key: "free" }, blocking)).state.entities["free"]).toBeUndefined();

    const force = makeConfig({ policies: { entityRemoval: "force" } });
    const forced = unwrap(removeEntity(build(force), { key: "b" }, force)).state;
    expect(forced.entities["b"]).toBeUndefined();
    expect(Object.keys(forced.nodes).sort()).toEqual(["n1", "n4"]);
    expect(forced.nodes["n1"]?.childIds).toEqual([]);
    expect(forced.entities["c"]).toBeDefined();
  });
});

describe("atomicity", () => {
  it("a failing operation leaves the previous state identical by reference", () => {
    const config = makeConfig({ policies: { maxDepth: 2 } });
    const state = build(config);
    const snapshot = JSON.stringify(state);
    const failures = [
      addNode(state, { entity: item("deep"), parentId: "n3", relationship: { weight: 0 } }, config),
      moveNode(state, { nodeId: "n1", newParentId: "n3" }, config),
      moveNode(state, { nodeId: "n1", newParentId: "n4" }, config),
      removeNode(state, { nodeId: "missing" }, config),
      updateEntity(state, { key: "a", data: item("other") }, config),
      rekeyEntity(state, { key: "a", data: item("b") }, config),
      removeEntity(state, { key: "a" }, config),
    ];
    for (const result of failures) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
        for (const error of result.errors) {
          expect(typeof error.code).toBe("string");
          expect(typeof error.message).toBe("string");
          expect(error.category).toBeDefined();
        }
      }
    }
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("successful operations keep references of untouched parts", () => {
    const config = makeConfig();
    const state = build(config);
    const next = unwrap(updateRelationship(state, { nodeId: "n3", relationship: { weight: 9 } }, config)).state;
    expect(next).not.toBe(state);
    expect(next.entities).toBe(state.entities);
    expect(next.rootIds).toBe(state.rootIds);
    expect(next.nodes["n1"]).toBe(state.nodes["n1"]);
    expect(state.nodes["n3"]?.relationship).toEqual({ weight: 2 });
  });
});
