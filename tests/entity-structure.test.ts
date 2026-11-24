import { describe, expect, it } from "vitest";
import {
  createEntityStructure,
  EntityStructureConfigError,
  InvalidStateError,
  type EntityStructureConfig,
  type StructureEvent,
} from "../src/index.js";
import { companyA, corporateConfig, personX, type Party, type Shareholding } from "../examples/corporate-structure.js";
import { sequentialIds } from "./helpers.js";

describe("createEntityStructure", () => {
  it("commits successful operations and keeps state on failure", () => {
    const structure = createEntityStructure(corporateConfig({ createId: sequentialIds() }));
    const added = structure.addNode({ entity: companyA, relationship: { percentage: 100 } });
    expect(added.ok).toBe(true);
    const child = structure.addNode({ entity: personX, parentId: "n1", relationship: { percentage: 60 } });
    expect(child.ok).toBe(true);
    const before = structure.getState();
    const failed = structure.addNode({ entity: companyA, parentId: "n2", relationship: { percentage: 1 } });
    expect(failed.ok).toBe(false);
    expect(structure.getState()).toBe(before);
    expect(structure.findAllByIdentity("333.333.333-33").map((node) => node.id)).toEqual(["n2"]);
    expect(structure.toTree()[0]?.children[0]?.entity.name).toBe("Person X");
    expect(structure.validateStructure().valid).toBe(true);
    expect(structure.canRelate(personX, companyA)).toBe(false);
  });

  it("accepts shorthand ids for removeNode/removeEntity", () => {
    const structure = createEntityStructure(corporateConfig({ createId: sequentialIds() }));
    structure.addNode({ entity: companyA, relationship: { percentage: 100 } });
    expect(structure.removeEntity("11111111000111").ok).toBe(false);
    expect(structure.removeNode("n1").ok).toBe(true);
    expect(structure.removeEntity("11111111000111").ok).toBe(true);
    expect(structure.getAllEntities()).toEqual([]);
  });

  it("notifies subscribers only when the state changes", () => {
    const structure = createEntityStructure(corporateConfig({ createId: sequentialIds() }));
    const seen: StructureEvent<Party, Shareholding>["type"][][] = [];
    const unsubscribe = structure.subscribe((_state, events) => seen.push(events.map((event) => event.type)));
    structure.addNode({ entity: companyA, relationship: { percentage: 100 } });
    structure.addNode({ entity: companyA, relationship: { percentage: 100 } }); // sibling duplicate → fails
    structure.moveNode({ nodeId: "n1", newParentId: null }); // no-op
    unsubscribe();
    structure.registerEntity(personX);
    expect(seen).toEqual([["ENTITY_REGISTERED", "NODE_ADDED"]]);
  });

  it("validates initialState and configuration up front", () => {
    const config = corporateConfig();
    const valid = createEntityStructure(config);
    valid.registerEntity(companyA);
    expect(createEntityStructure(config, { initialState: valid.getState() }).hasEntity("11111111000111")).toBe(true);
    const broken = { ...valid.getState(), rootIds: ["ghost"] };
    expect(() => createEntityStructure(config, { initialState: broken })).toThrow(InvalidStateError);
    const badConfig = { identity: { key: "" } } as unknown as EntityStructureConfig<Party, Shareholding>;
    expect(() => createEntityStructure(badConfig)).toThrow(EntityStructureConfigError);
  });
});

describe("scenario E — independent instances", () => {
  it("two instances never share state, even with the same config", () => {
    const config = corporateConfig();
    const first = createEntityStructure(config);
    const second = createEntityStructure(config);
    first.addNode({ entity: companyA, relationship: { percentage: 100 } });
    expect(first.getAllEntities()).toHaveLength(1);
    expect(second.getAllEntities()).toHaveLength(0);
    expect(second.getState().rootIds).toEqual([]);
    expect(first.getState()).not.toBe(second.getState());
    second.addNode({ entity: personX, relationship: { percentage: 100 } });
    expect(first.findEntity("33333333333")).toBeUndefined();
    expect(second.findEntity("11111111000111")).toBeUndefined();
  });
});
