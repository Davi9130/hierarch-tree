import { describe, expect, it } from "vitest";
import { createEmptyState, type EntityStructureConfig } from "../src/index.js";
import {
  findByIdentity,
  findEntity,
  getAllEntities,
  hasEntity,
  registerEntity,
} from "../src/core/registry.js";

interface Person {
  document: string;
  name: string;
}

const config: EntityStructureConfig<Person, unknown> = {
  identity: { key: "document", normalize: (value) => value.replace(/\D/g, "") },
};

describe("entity registry", () => {
  it("registers an entity under its normalized key", () => {
    const result = registerEntity(createEmptyState<Person, unknown>(), { document: "1.2-3", name: "Ann" }, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.key).toBe("123");
    expect(findEntity(result.value.state, "123")?.data.name).toBe("Ann");
    expect(hasEntity(result.value.state, "123")).toBe(true);
    expect(result.value.events).toEqual([
      { type: "ENTITY_REGISTERED", key: "123", entity: { document: "1.2-3", name: "Ann" } },
    ]);
  });

  it("detects collisions after normalization and keeps the state", () => {
    const first = registerEntity(createEmptyState<Person, unknown>(), { document: "123", name: "Ann" }, config);
    if (!first.ok) throw new Error("setup");
    const state = first.value.state;
    const second = registerEntity(state, { document: "1-2-3", name: "Other" }, config);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errors[0]?.code).toBe("IDENTITY_COLLISION");
    expect(findEntity(state, "123")?.data.name).toBe("Ann");
  });

  it("finds by raw identity value using the same normalization", () => {
    const result = registerEntity(createEmptyState<Person, unknown>(), { document: "123", name: "Ann" }, config);
    if (!result.ok) throw new Error("setup");
    expect(findByIdentity(result.value.state, "1.2.3", config)?.key).toBe("123");
    expect(findByIdentity(result.value.state, "999", config)).toBeUndefined();
    expect(getAllEntities(result.value.state)).toHaveLength(1);
  });

  it("treats prototype property names as ordinary keys", () => {
    const plain: EntityStructureConfig<{ id: string }, unknown> = { identity: { key: "id" } };
    const empty = createEmptyState<{ id: string }, unknown>();
    expect(findEntity(empty, "constructor")).toBeUndefined();
    expect(hasEntity(empty, "toString")).toBe(false);
    const result = registerEntity(empty, { id: "__proto__" }, plain);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(findEntity(result.value.state, "__proto__")?.data.id).toBe("__proto__");
      expect(Object.getPrototypeOf(result.value.state.entities)).toBe(Object.prototype);
    }
  });

  it("does not mutate the previous state", () => {
    const empty = createEmptyState<Person, unknown>();
    registerEntity(empty, { document: "1", name: "A" }, config);
    expect(empty.entities).toEqual({});
  });
});
