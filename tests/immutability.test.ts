/**
 * TES-35 / F1 — everything that enters the state is owned by it: plain objects
 * are shallow-copied and frozen, class instances are frozen in place, and
 * values already in the state keep their reference.
 */
import { describe, expect, it } from "vitest";
import {
  addNode,
  createEmptyState,
  createEntityStructure,
  exportStructure,
  importStructure,
  registerEntity,
  updateEntity,
  updateRelationship,
  type EntityStructureConfig,
  type StructureState,
} from "../src/index.js";
import { sequentialIds, unwrap } from "./helpers.js";

interface Item {
  id: string;
  tags?: string[];
}
type Link = { weight: number } | string[];

const config = (): EntityStructureConfig<Item, Link> => ({
  identity: { key: "id" },
  relationships: { mode: "permissive" },
  createId: sequentialIds(),
});

describe("F1: state ownership", () => {
  it("copies and freezes plain entities and relationships, leaving the consumer's objects mutable", () => {
    const cfg = config();
    const entity: Item = { id: "a" };
    const relationship = { weight: 1 };
    const added = unwrap(addNode(createEmptyState<Item, Link>(), { entity, relationship }, cfg));
    const stored = added.state.entities["a"];
    const node = added.state.nodes[added.nodeId];
    expect(stored?.data).toEqual(entity);
    expect(stored?.data).not.toBe(entity);
    expect(node?.relationship).not.toBe(relationship);
    expect(Object.isFrozen(stored) && Object.isFrozen(stored?.data)).toBe(true);
    expect(Object.isFrozen(node) && Object.isFrozen(node?.childIds) && Object.isFrozen(node?.relationship)).toBe(true);
    expect(Object.isFrozen(added.state.rootIds)).toBe(true);
    expect(Object.isFrozen(entity)).toBe(false);
    // Events carry the stored values.
    const registered = added.events.find((event) => event.type === "ENTITY_REGISTERED");
    expect(registered?.type === "ENTITY_REGISTERED" && registered.entity).toBe(stored?.data);
  });

  it("is shallow: nested objects are not copied (documented contract)", () => {
    const cfg = config();
    const tags = ["x"];
    const s = unwrap(registerEntity(createEmptyState<Item, Link>(), { id: "a", tags }, cfg)).state;
    expect(s.entities["a"]?.data.tags).toBe(tags);
  });

  it("copies arrays and keeps frozen values (and untouched parts) by reference", () => {
    const cfg = config();
    let s = unwrap(addNode(createEmptyState<Item, Link>(), { entity: { id: "a" }, relationship: ["r"] }, cfg)).state;
    expect(Array.isArray(s.nodes["n1"]?.relationship)).toBe(true);
    expect(Object.isFrozen(s.nodes["n1"]?.relationship)).toBe(true);
    const frozen = Object.freeze({ weight: 2 });
    s = unwrap(addNode(s, { entity: { id: "b" }, relationship: frozen }, cfg)).state;
    expect(s.nodes["n2"]?.relationship).toBe(frozen);
    const before = s.nodes["n1"];
    const next = unwrap(updateRelationship(s, { nodeId: "n2", relationship: { weight: 3 } }, cfg)).state;
    expect(next.nodes["n1"]).toBe(before);
  });

  it("freezes class instances in place, keeping prototype, getters and identity", () => {
    class Member {
      constructor(private readonly raw: { id: string }) {}
      get id(): string {
        return this.raw.id;
      }
    }
    const cfg = { ...config(), identity: { key: "id" } } as unknown as EntityStructureConfig<Member, Link>;
    const member = new Member({ id: "m" });
    const s = unwrap(registerEntity(createEmptyState<Member, Link>(), member, cfg)).state;
    expect(s.entities["m"]?.data).toBe(member);
    expect(Object.isFrozen(member)).toBe(true);
    expect(s.entities["m"]?.data).toBeInstanceOf(Member);
  });

  it("updateEntity stores a frozen copy", () => {
    const cfg = config();
    const s = unwrap(registerEntity(createEmptyState<Item, Link>(), { id: "a" }, cfg)).state;
    const data: Item = { id: "a", tags: [] };
    const next = unwrap(updateEntity(s, { key: "a", data }, cfg)).state;
    expect(next.entities["a"]?.data).not.toBe(data);
    expect(Object.isFrozen(next.entities["a"]?.data)).toBe(true);
  });

  it("takes over an initialState built from plain objects and imported snapshots", () => {
    const cfg = config();
    const raw: StructureState<Item, Link> = {
      entities: { a: { key: "a", data: { id: "a" } } },
      nodes: { r: { id: "r", entityKey: "a", parentId: null, childIds: [], relationship: { weight: 1 } } },
      rootIds: ["r"],
    };
    const structure = createEntityStructure(cfg, { initialState: raw });
    const owned = structure.getState();
    expect(Object.isFrozen(owned.entities["a"]?.data)).toBe(true);
    expect(Object.isFrozen(owned.nodes["r"]?.relationship)).toBe(true);
    expect(Object.isFrozen(raw.entities["a"]?.data)).toBe(false); // the consumer's copy is left alone
    // A state produced by the core is adopted by reference.
    expect(createEntityStructure(cfg, { initialState: owned }).getState()).toBe(owned);

    const imported = importStructure(JSON.parse(JSON.stringify(exportStructure(owned))), cfg);
    expect(imported.ok && Object.isFrozen(imported.value.state.nodes["r"]?.relationship)).toBe(true);
  });
});
