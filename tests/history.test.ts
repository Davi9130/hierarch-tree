import { describe, expect, it } from "vitest";
import {
  createEntityStructure,
  createHistory,
  DEFAULT_HISTORY_LIMIT,
  EntityStructureConfigError,
  toHistoryEntries,
  trackHistory,
  type EntityStructureConfig,
  type StructureEvent,
} from "../src/index.js";
import { sequentialIds } from "./helpers.js";

interface Item {
  id: string;
  name: string;
}
interface Link {
  weight: number;
}

const config = (): EntityStructureConfig<Item, Link> => ({
  identity: { key: "id" },
  relationships: { mode: "permissive" },
  policies: { entityRemoval: "when-unreferenced" },
  createId: sequentialIds(),
});

function clock(start = 1000): () => number {
  let time = start;
  return () => {
    time += 1;
    return time;
  };
}

describe("createHistory", () => {
  it("is opt-in: a structure without history records nothing", () => {
    const structure = createEntityStructure(config());
    const history = createHistory<Item, Link>();
    structure.addNode({ entity: { id: "a", name: "A" }, relationship: { weight: 1 } });
    expect(history.entries()).toEqual([]);
  });

  it("maps every event type with id, timestamp, keys, positions, before/after and context", () => {
    const structure = createEntityStructure(config());
    const history = createHistory<Item, Link>({ now: clock() });
    const stop = trackHistory(structure, history, { getContext: () => ({ user: "u1" }) });

    structure.registerEntity({ id: "z", name: "Z" }); // h1 ENTITY_REGISTERED
    structure.addNode({ entity: { id: "a", name: "A" }, relationship: { weight: 1 } }); // n1: h2 ENTITY_REGISTERED, h3 NODE_ADDED
    structure.addNode({ entity: { id: "b", name: "B" }, parentId: "n1", relationship: { weight: 2 } }); // n2
    structure.addNode({ entity: { id: "c", name: "C" }, relationship: { weight: 0 } }); // n3
    structure.moveNode({ nodeId: "n2", newParentId: "n3" });
    structure.updateRelationship({ nodeId: "n2", relationship: { weight: 5 } });
    structure.updateEntity({ key: "a", data: { id: "a", name: "A2" } });
    structure.rekeyEntity({ key: "z", data: { id: "y", name: "Z" } });
    structure.removeNode("n2"); // also removes entity "b" (when-unreferenced)
    stop();

    const entries = history.entries();
    expect(entries.map((entry) => entry.type)).toEqual([
      "ENTITY_REGISTERED",
      "ENTITY_REGISTERED",
      "NODE_ADDED",
      "ENTITY_REGISTERED",
      "NODE_ADDED",
      "ENTITY_REGISTERED",
      "NODE_ADDED",
      "NODE_MOVED",
      "RELATIONSHIP_UPDATED",
      "ENTITY_UPDATED",
      "ENTITY_REKEYED",
      "NODE_REMOVED",
      "ENTITY_REMOVED",
    ]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(entries.every((entry) => typeof entry.timestamp === "number")).toBe(true);
    expect(entries.every((entry) => (entry.context as { user: string }).user === "u1")).toBe(true);

    const byType = (type: string) => entries.filter((entry) => entry.type === type);
    expect(byType("NODE_ADDED")[1]).toMatchObject({ nodeId: "n2", entityKey: "b", to: { parentId: "n1", index: 0 } });
    expect(byType("NODE_MOVED")[0]).toMatchObject({
      nodeId: "n2",
      entityKey: "b", // filled from the state
      from: { parentId: "n1", index: 0 },
      to: { parentId: "n3", index: 0 },
    });
    expect(byType("RELATIONSHIP_UPDATED")[0]).toMatchObject({
      nodeId: "n2",
      entityKey: "b",
      before: { weight: 2 },
      after: { weight: 5 },
    });
    expect(byType("ENTITY_UPDATED")[0]).toMatchObject({
      entityKey: "a",
      nodeId: undefined,
      before: { name: "A" },
      after: { name: "A2" },
    });
    expect(byType("ENTITY_REKEYED")[0]).toMatchObject({ entityKey: "y", previousEntityKey: "z" });
    expect(byType("NODE_REMOVED")[0]).toMatchObject({
      nodeId: "n2",
      entityKey: "b",
      from: { parentId: "n3" },
      before: { id: "n2", relationship: { weight: 5 } },
    });
    expect(byType("ENTITY_REMOVED")[0]).toMatchObject({ entityKey: "b", before: { id: "b" } });
    expect(entries[0]?.event).toEqual({ type: "ENTITY_REGISTERED", key: "z", entity: { id: "z", name: "Z" } });
  });

  it("stops recording after unsubscribe and ignores failed operations", () => {
    const structure = createEntityStructure(config());
    const history = createHistory<Item, Link>();
    const stop = trackHistory(structure, history);
    structure.addNode({ entity: { id: "a", name: "A" }, relationship: { weight: 1 } });
    const failed = structure.addNode({ entity: { id: "b", name: "B" }, parentId: "missing", relationship: { weight: 1 } });
    expect(failed.ok).toBe(false);
    expect(history.entries()).toHaveLength(2);
    stop();
    structure.addNode({ entity: { id: "c", name: "C" }, relationship: { weight: 1 } });
    expect(history.entries()).toHaveLength(2);
  });

  it("keeps only the latest `limit` entries", () => {
    const history = createHistory<Item, Link>({ limit: 3 });
    const events: StructureEvent<Item, Link>[] = ["a", "b", "c", "d", "e"].map((id) => ({
      type: "ENTITY_REGISTERED",
      key: id,
      entity: { id, name: id },
    }));
    history.record(events.slice(0, 2));
    history.record(events.slice(2));
    expect(history.entries().map((entry) => entry.entityKey)).toEqual(["c", "d", "e"]);
    expect(history.entries().map((entry) => entry.id)).toEqual(["h3", "h4", "h5"]);
    history.clear();
    expect(history.entries()).toEqual([]);
  });

  it("supports manual recording with context, injectable ids and clock", () => {
    const history = createHistory<Item, Link>({ now: () => 42, createId: sequentialIds("evt-") });
    const created = history.record(
      [{ type: "RELATIONSHIP_UPDATED", nodeId: "n1", previous: { weight: 1 }, next: { weight: 2 } }],
      { context: { reason: "fix" } },
    );
    expect(created).toEqual([
      expect.objectContaining({ id: "evt-1", timestamp: 42, entityKey: undefined, context: { reason: "fix" } }),
    ]);
  });

  it("entries() returns a copy", () => {
    const history = createHistory<Item, Link>();
    const snapshot = history.entries();
    history.record([{ type: "ENTITY_REGISTERED", key: "a", entity: { id: "a", name: "A" } }]);
    expect(snapshot).toEqual([]);
  });

  it("validates the limit", () => {
    expect(createHistory().limit).toBe(DEFAULT_HISTORY_LIMIT);
    expect(createHistory({ limit: Number.POSITIVE_INFINITY }).limit).toBe(Number.POSITIVE_INFINITY);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => createHistory({ limit })).toThrow(EntityStructureConfigError);
    }
  });
});

describe("toHistoryEntries", () => {
  it("is a pure mapping", () => {
    const events: StructureEvent<Item, Link>[] = [{ type: "ENTITY_REMOVED", key: "a", entity: { id: "a", name: "A" } }];
    const options = { timestamp: 1, createId: () => "x" };
    expect(toHistoryEntries(events, options)).toEqual(toHistoryEntries(events, options));
    expect(toHistoryEntries([], options)).toEqual([]);
  });
});
