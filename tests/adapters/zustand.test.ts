import { describe, expect, it, vi } from "vitest";
import {
  createEntityStructureStore,
  selectActions,
  selectAllByIdentity,
  selectChildren,
  selectEntity,
  selectNode,
  selectRootIds,
  selectStructure,
  type EntityStructureStore,
} from "../../src/adapters/zustand/index.js";
import {
  EntityStructureConfigError,
  exportStructure,
  InvalidStateError,
  type EntityStructureConfig,
} from "../../src/index.js";
import {
  companyA,
  companyB,
  corporateConfig,
  personX,
  personY,
  type Party,
  type Shareholding,
} from "../../examples/corporate-structure.js";
import { codes, sequentialIds, unwrap } from "../helpers.js";

function makeStore(prefix = "n"): EntityStructureStore<Party, Shareholding> {
  return createEntityStructureStore({ config: corporateConfig({ createId: sequentialIds(prefix) }) });
}

/** A (n1) → X (n2), B (n3) → X (n4), A → Y (n5). */
function populate(store: EntityStructureStore<Party, Shareholding>): void {
  const { actions } = store.getState();
  unwrap(actions.addNode({ entity: companyA, relationship: { percentage: 100 } }));
  unwrap(actions.addNode({ entity: personX, parentId: "n1", relationship: { percentage: 60 } }));
  unwrap(actions.addNode({ entity: companyB, relationship: { percentage: 100 } }));
  unwrap(actions.addNode({ entity: personX, parentId: "n3", relationship: { percentage: 10 } }));
  unwrap(actions.addNode({ entity: personY, parentId: "n1", relationship: { percentage: 40 } }));
}

describe("createEntityStructureStore", () => {
  it("keeps only the core state and commits successful operations", () => {
    const store = makeStore();
    populate(store);
    const state = store.getState();
    expect(Object.keys(state).sort()).toEqual(["actions", "config", "lastEvents", "structure"]);
    expect(state.structure.rootIds).toEqual(["n1", "n3"]);
    expect(state.structure.nodes.n1?.childIds).toEqual(["n2", "n5"]);
    expect(Object.keys(state.structure.entities)).toHaveLength(4);
    expect(state.lastEvents.map((event) => event.type)).toEqual(["ENTITY_REGISTERED", "NODE_ADDED"]);
  });

  it("returns the same result values as the pure core", () => {
    const store = makeStore();
    const result = store.getState().actions.addNode({ entity: companyA, relationship: { percentage: 100 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodeId).toBe("n1");
      expect(result.value.state).toBe(store.getState().structure);
    }
  });

  it("accepts shorthand ids for removeNode / removeEntity", () => {
    const store = createEntityStructureStore({
      config: corporateConfig({ createId: sequentialIds(), policies: { entityRemoval: "block" } }),
    });
    populate(store);
    const { actions } = store.getState();
    unwrap(actions.removeNode("n4"));
    unwrap(actions.removeNode("n3"));
    expect(store.getState().structure.rootIds).toEqual(["n1"]);
    unwrap(actions.removeEntity("22222222000122"));
    expect(store.getState().structure.entities["22222222000122"]).toBeUndefined();
  });

  it("covers every core operation", () => {
    const store = makeStore();
    populate(store);
    const { actions } = store.getState();
    unwrap(actions.updateRelationship({ nodeId: "n2", relationship: { percentage: 50 } }));
    unwrap(actions.updateEntity({ key: "33333333333", data: { ...personX, name: "Person X (renamed)" } }));
    unwrap(actions.moveNode({ nodeId: "n5", newParentId: "n3" }));
    unwrap(actions.registerEntity({ taxPayer: "555.555.555-55", type: "PF", name: "Person Z" }));
    unwrap(actions.rekeyEntity({ key: "55555555555", data: { taxPayer: "666.666.666-66", type: "PF", name: "Z" } }));
    const { structure } = store.getState();
    expect(structure.nodes.n2?.relationship.percentage).toBe(50);
    expect(structure.entities["33333333333"]?.data.name).toBe("Person X (renamed)");
    expect(structure.nodes.n3?.childIds).toEqual(["n4", "n5"]);
    expect(structure.entities["66666666666"]).toBeDefined();
  });
});

describe("failed operations do not touch the store", () => {
  it("keeps the same state reference and does not notify", () => {
    const store = makeStore();
    populate(store);
    const before = store.getState();
    const listener = vi.fn();
    store.subscribe(listener);
    const { actions } = before;

    const attempts = [
      // PF cannot hold PJ (rule)
      actions.addNode({
        entity: { taxPayer: "77.777.777/0001-77", type: "PJ", name: "Company C" },
        parentId: "n2",
        relationship: { percentage: 1 },
      }),
      // shares above 100% (consumer validator)
      actions.updateRelationship({ nodeId: "n2", relationship: { percentage: 90 } }),
      // cycle
      actions.moveNode({ nodeId: "n1", newParentId: "n2" }),
      // duplicate sibling
      actions.addNode({ entity: personX, parentId: "n1", relationship: { percentage: 0 } }),
      // changing the identity requires rekeyEntity
      actions.updateEntity({ key: "33333333333", data: { ...personX, taxPayer: "999.999.999-99" } }),
      // still referenced
      actions.removeEntity("33333333333"),
      actions.removeNode("missing"),
    ];

    for (const result of attempts) expect(result.ok).toBe(false);
    expect(codes(attempts.flatMap((result) => (result.ok ? [] : result.errors)))).toContain("INVALID_SHAREHOLDER");
    expect(store.getState()).toBe(before);
    expect(store.getState().structure).toBe(before.structure);
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects an invalid replaceStructure / importSnapshot without changes", () => {
    const store = makeStore();
    populate(store);
    const before = store.getState();
    const broken = {
      ...before.structure,
      nodes: { ...before.structure.nodes, n2: { ...before.structure.nodes.n2!, entityKey: "unknown" } },
    };
    expect(before.actions.replaceStructure(broken).valid).toBe(false);
    expect(before.actions.importSnapshot({ version: 99 }).ok).toBe(false);
    expect(store.getState()).toBe(before);
  });

  it("does not notify when a successful operation produces the same state", () => {
    const store = makeStore();
    populate(store);
    const listener = vi.fn();
    store.subscribe(listener);
    const { structure, actions } = store.getState();
    expect(actions.replaceStructure(structure).valid).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("scenario E — independent stores", () => {
  it("two stores with the same config never share state", () => {
    const config: EntityStructureConfig<Party, Shareholding> = corporateConfig({ createId: sequentialIds() });
    const first = createEntityStructureStore({ config });
    const second = createEntityStructureStore({ config });
    expect(first).not.toBe(second);
    expect(first.getState().structure).not.toBe(second.getState().structure);

    unwrap(first.getState().actions.addNode({ entity: companyA, relationship: { percentage: 100 } }));
    expect(Object.keys(first.getState().structure.nodes)).toHaveLength(1);
    expect(second.getState().structure.rootIds).toEqual([]);
    expect(second.getState().structure.entities).toEqual({});

    unwrap(second.getState().actions.addNode({ entity: companyB, relationship: { percentage: 100 } }));
    expect(Object.values(first.getState().structure.entities).map((record) => record.data.name)).toEqual([
      "Company A",
    ]);
    expect(Object.values(second.getState().structure.entities).map((record) => record.data.name)).toEqual([
      "Company B",
    ]);
  });

  it("subscriptions and selector caches are per store", () => {
    const first = makeStore();
    const second = makeStore();
    populate(first);
    populate(second);
    const listener = vi.fn();
    second.subscribe(listener);
    unwrap(first.getState().actions.updateRelationship({ nodeId: "n2", relationship: { percentage: 50 } }));
    expect(listener).not.toHaveBeenCalled();

    const children = selectChildren<Party, Shareholding>("n1");
    const fromFirst = children(first.getState());
    const fromSecond = children(second.getState());
    expect(fromFirst).not.toBe(fromSecond);
    expect(fromFirst[0]?.relationship.percentage).toBe(50);
    expect(fromSecond[0]?.relationship.percentage).toBe(60);
  });
});

describe("initialData", () => {
  it("accepts a core state or a snapshot and validates it", () => {
    const source = makeStore();
    populate(source);
    const { structure } = source.getState();

    const fromState = createEntityStructureStore({ config: corporateConfig(), initialData: structure });
    expect(fromState.getState().structure).toBe(structure);

    const fromSnapshot = createEntityStructureStore({
      config: corporateConfig(),
      initialData: JSON.parse(JSON.stringify(exportStructure(structure))),
    });
    expect(fromSnapshot.getState().structure).toEqual(structure);
  });

  it("throws InvalidStateError for invalid data and fails fast on a bad config", () => {
    const source = makeStore();
    populate(source);
    const { structure } = source.getState();
    const broken = { ...structure, rootIds: [...structure.rootIds, "ghost"] };
    expect(() => createEntityStructureStore({ config: corporateConfig(), initialData: broken })).toThrow(
      InvalidStateError,
    );
    const badSnapshot = { ...exportStructure(structure), rootIds: ["ghost"] };
    expect(() => createEntityStructureStore({ config: corporateConfig(), initialData: badSnapshot })).toThrow(
      InvalidStateError,
    );
    const badConfig = { identity: {} } as unknown as EntityStructureConfig<Party, Shareholding>;
    expect(() => createEntityStructureStore({ config: badConfig })).toThrow(EntityStructureConfigError);
  });
});

describe("selectors preserve references", () => {
  it("unaffected nodes, entities and children lists keep their references", () => {
    const store = makeStore();
    populate(store);
    const before = store.getState();
    const nodeA = selectNode<Party, Shareholding>("n1")(before);
    const nodeB = selectNode<Party, Shareholding>("n3")(before);
    const childrenOfB = selectChildren<Party, Shareholding>("n3")(before);
    const childrenOfA = selectChildren<Party, Shareholding>("n1")(before);
    const entityB = selectEntity<Party, Shareholding>("22222222000122")(before);
    const roots = selectRootIds(before);

    // Touches only n5 (a child of A).
    unwrap(before.actions.updateRelationship({ nodeId: "n5", relationship: { percentage: 30 } }));
    const after = store.getState();

    expect(after.structure).not.toBe(before.structure);
    expect(selectNode<Party, Shareholding>("n1")(after)).toBe(nodeA);
    expect(selectNode<Party, Shareholding>("n3")(after)).toBe(nodeB);
    expect(selectChildren<Party, Shareholding>("n3")(after)).toBe(childrenOfB);
    expect(selectEntity<Party, Shareholding>("22222222000122")(after)).toBe(entityB);
    expect(selectRootIds(after)).toBe(roots);
    // The affected list is a new array; its unaffected item is the same node.
    const nextChildrenOfA = selectChildren<Party, Shareholding>("n1")(after);
    expect(nextChildrenOfA).not.toBe(childrenOfA);
    expect(nextChildrenOfA[0]).toBe(childrenOfA[0]);
    expect(nextChildrenOfA[1]?.relationship.percentage).toBe(30);
  });

  it("list selectors are stable across calls and fresh selector instances", () => {
    const store = makeStore();
    populate(store);
    const state = store.getState();
    expect(selectChildren<Party, Shareholding>(null)(state)).toBe(selectChildren<Party, Shareholding>(null)(state));
    expect(selectChildren<Party, Shareholding>(null)(state).map((node) => node.id)).toEqual(["n1", "n3"]);
    const occurrences = selectAllByIdentity<Party, Shareholding>("333.333.333-33")(state);
    expect(occurrences.map((node) => node.id)).toEqual(["n2", "n4"]);
    // Same identity in another raw format normalizes to the same cached list.
    expect(selectAllByIdentity<Party, Shareholding>("33333333333")(state)).toBe(occurrences);
  });

  it("findAllByIdentity keeps its reference when other parts of the tree change", () => {
    const store = makeStore();
    populate(store);
    const occurrences = selectAllByIdentity<Party, Shareholding>("333.333.333-33")(store.getState());
    unwrap(store.getState().actions.updateRelationship({ nodeId: "n5", relationship: { percentage: 30 } }));
    expect(selectAllByIdentity<Party, Shareholding>("333.333.333-33")(store.getState())).toBe(occurrences);

    unwrap(store.getState().actions.updateRelationship({ nodeId: "n4", relationship: { percentage: 20 } }));
    const next = selectAllByIdentity<Party, Shareholding>("333.333.333-33")(store.getState());
    expect(next).not.toBe(occurrences);
    expect(next[0]).toBe(occurrences[0]);
  });

  it("returns a stable empty list for unknown nodes and invalid identities", () => {
    const store = makeStore();
    const state = store.getState();
    expect(selectChildren<Party, Shareholding>("missing")(state)).toBe(selectChildren<Party, Shareholding>("x")(state));
    expect(selectAllByIdentity<Party, Shareholding>("")(state)).toEqual([]);
    expect(selectChildren<Party, Shareholding>(null)(state)).toEqual([]);
    expect(selectStructure(state)).toBe(state.structure);
    expect(selectActions(state)).toBe(state.actions);
  });
});

describe("examples/zustand-store.ts", () => {
  it("runs as documented in docs/zustand.md", async () => {
    const { buildExample, shareholdingStore } = await import("../../examples/zustand-store.js");
    expect(buildExample()).toEqual(["60", "1", "1", "PERCENTAGE_EXCEEDED"]);
    expect(shareholdingStore.getState().structure.rootIds).toHaveLength(1);
  });
});
