import { describe, expect, it } from "vitest";
import {
  CORE_ERROR_CODES,
  createEmptyState,
  createEntityStructure,
  EntityStructureConfigError,
  exportStructure,
  importStructure,
  SNAPSHOT_VERSION,
  type EntityStructureConfig,
  type ImportStructureResult,
  type StructureState,
  type ValidationError,
} from "../src/index.js";
import { addNode } from "../src/core/structure.js";
import { registerEntity } from "../src/core/registry.js";
import { codes, sequentialIds, unwrap } from "./helpers.js";

interface Item {
  id: string;
  kind: "group" | "leaf";
}
interface Link {
  weight: number;
}
type State = StructureState<Item, Link>;

function makeConfig(overrides: Partial<EntityStructureConfig<Item, Link>> = {}): EntityStructureConfig<Item, Link> {
  return {
    identity: { key: "id", normalize: (value) => value.trim().toLowerCase() },
    relationships: {
      mode: "permissive",
      rules: [{ id: "leaf-has-no-children", parent: { kind: "leaf" }, allowed: false, code: "LEAF_PARENT" }],
    },
    createId: sequentialIds(),
    ...overrides,
  };
}

const group = (id: string): Item => ({ id, kind: "group" });
const leaf = (id: string): Item => ({ id, kind: "leaf" });

/** a(n1) → [b(n2) → [x(n3)], c(n4) → [x(n5)]]; d(n6) root; e registered only. */
function build(config: EntityStructureConfig<Item, Link>): State {
  let state = createEmptyState<Item, Link>();
  const add = (entity: Item, parentId: string | null, weight: number): void => {
    state = unwrap(addNode(state, { entity, parentId, relationship: { weight } }, config)).state;
  };
  add(group("a"), null, 0);
  add(group("b"), "n1", 1);
  add(leaf("x"), "n2", 2);
  add(group("c"), "n1", 3);
  add(leaf("x"), "n4", 4); // same entity, second occurrence
  add(group("d"), null, 0);
  state = unwrap(registerEntity(state, group("e"), config)).state;
  return state;
}

const roundTrip = (state: State): unknown => JSON.parse(JSON.stringify(exportStructure(state)));

function expectErrors(result: ImportStructureResult<Item, Link>): readonly ValidationError[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

/** A valid snapshot as plain data, to be broken by each test. */
function snapshot(): {
  version: number;
  entities: { key: string; data: unknown }[];
  nodes: { id: string; entityKey: string; parentId: string | null; childIds: string[]; relationship?: unknown }[];
  rootIds: string[];
} {
  return {
    version: 1,
    entities: [
      { key: "a", data: group("a") },
      { key: "b", data: group("b") },
    ],
    nodes: [
      { id: "n1", entityKey: "a", parentId: null, childIds: ["n2"], relationship: { weight: 0 } },
      { id: "n2", entityKey: "b", parentId: "n1", childIds: [], relationship: { weight: 1 } },
    ],
    rootIds: ["n1"],
  };
}

describe("exportStructure", () => {
  it("writes a flat, versioned, JSON-safe snapshot in pre-order", () => {
    const config = makeConfig();
    const exported = exportStructure(build(config));
    expect(exported.version).toBe(SNAPSHOT_VERSION);
    expect(exported.rootIds).toEqual(["n1", "n6"]);
    expect(exported.nodes.map((node) => node.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
    expect(exported.nodes[0]).toEqual({
      id: "n1",
      entityKey: "a",
      parentId: null,
      childIds: ["n2", "n4"],
      relationship: { weight: 0 },
    });
    expect(exported.entities.map((entity) => entity.key)).toEqual(["a", "b", "x", "c", "d", "e"]);
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
  });

  it("does not share arrays with the state", () => {
    const state = build(makeConfig());
    const exported = exportStructure(state);
    expect(exported.rootIds).not.toBe(state.rootIds);
    expect(exported.nodes[0]?.childIds).not.toBe(state.nodes["n1"]?.childIds);
  });

  it("exports an empty state", () => {
    expect(exportStructure(createEmptyState())).toEqual({ version: 1, entities: [], nodes: [], rootIds: [] });
  });
});

describe("importStructure — round-trip", () => {
  it("import(export(s)) reproduces an equivalent state", () => {
    const config = makeConfig();
    const state = build(config);
    const result = importStructure(roundTrip(state), config);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const imported = result.value;
    expect(imported.state).toEqual(state);
    expect(imported.migratedFrom).toBeUndefined();
    expect(exportStructure(imported.state)).toEqual(exportStructure(state));
  });

  it("produces a state the wrapper accepts and keeps operating on", () => {
    const config = makeConfig();
    const result = importStructure(roundTrip(build(config)), config);
    if (!result.ok) throw new Error("setup");
    const structure = createEntityStructure(config, { initialState: result.value.state });
    expect(structure.getOccurrences("x").map((node) => node.id)).toEqual(["n3", "n5"]);
    expect(structure.addNode({ entity: leaf("y"), parentId: "n6", relationship: { weight: 9 } }).ok).toBe(true);
  });

  it("keeps undefined relationships that JSON drops", () => {
    const config: EntityStructureConfig<Item, Link | undefined> = { identity: { key: "id" }, relationships: { mode: "permissive" } };
    const data = snapshot();
    delete data.nodes[0]?.relationship;
    const result = importStructure(JSON.parse(JSON.stringify(data)), config);
    expect(result.ok && result.value.state.nodes["n1"]?.relationship).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("accepts ids such as __proto__ as plain keys", () => {
    const data = snapshot();
    data.entities[0] = { key: "__proto__", data: group("__proto__") };
    if (data.nodes[0] !== undefined) data.nodes[0].entityKey = "__proto__";
    const result = importStructure(data, makeConfig());
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value.state.entities)).toContain("__proto__");
  });
});

describe("importStructure — version and migrations", () => {
  it("rejects a missing or non-integer version", () => {
    const { version: _omit, ...noVersion } = snapshot();
    expect(codes(expectErrors(importStructure(noVersion, makeConfig())))).toEqual(["SNAPSHOT_UNSUPPORTED_VERSION"]);
    expect(codes(expectErrors(importStructure({ ...snapshot(), version: "1" }, makeConfig())))).toEqual([
      "SNAPSHOT_UNSUPPORTED_VERSION",
    ]);
  });

  it("rejects an unknown version without a migration", () => {
    const errors = expectErrors(importStructure({ ...snapshot(), version: 2 }, makeConfig()));
    expect(codes(errors)).toEqual(["SNAPSHOT_UNSUPPORTED_VERSION"]);
    expect(errors[0]?.details).toEqual({ version: 2, supported: 1 });
  });

  it("chains migrations until the current version, then validates", () => {
    // v-1: { items: [{ id, kind, parent }] } → v0: renamed field → v1
    const legacy = {
      version: -1,
      items: [
        { id: "a", kind: "group", parent: null },
        { id: "b", kind: "leaf", parent: "a" },
      ],
    };
    const migrations = {
      [-1]: (data: Record<string, unknown>) => ({ version: 0, records: data["items"] }),
      0: (data: Record<string, unknown>) => {
        const records = data["records"] as { id: string; kind: string; parent: string | null }[];
        return {
          version: 1,
          entities: records.map(({ id, kind }) => ({ key: id, data: { id, kind } })),
          nodes: records.map((record) => ({
            id: `n-${record.id}`,
            entityKey: record.id,
            parentId: record.parent === null ? null : `n-${record.parent}`,
            childIds: records.filter((child) => child.parent === record.id).map((child) => `n-${child.id}`),
            relationship: { weight: 1 },
          })),
          rootIds: records.filter((record) => record.parent === null).map((record) => `n-${record.id}`),
        };
      },
    };
    const result = importStructure(legacy, makeConfig(), { migrations });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.migratedFrom).toBe(-1);
    expect(result.value.state.nodes["n-b"]?.parentId).toBe("n-a");
  });

  it("migrated data still goes through the whole pipeline", () => {
    const migrations = { 0: () => ({ ...snapshot(), rootIds: [] }) };
    expect(codes(expectErrors(importStructure({ version: 0 }, makeConfig(), { migrations })))).toContain(
      "INCONSISTENT_LINK",
    );
  });

  it("reports migrations that throw or do not advance", () => {
    const throwing = importStructure({ version: 0 }, makeConfig(), {
      migrations: {
        0: () => {
          throw new Error("boom");
        },
      },
    });
    expect(expectErrors(throwing)[0]).toMatchObject({
      code: "SNAPSHOT_MIGRATION_FAILED",
      details: { fromVersion: 0, reason: "boom" },
    });
    const looping = importStructure({ version: 0 }, makeConfig(), {
      migrations: { 0: () => ({ version: -1 }), [-1]: () => ({ version: 0 }) },
    });
    expect(codes(expectErrors(looping))).toEqual(["SNAPSHOT_MIGRATION_FAILED"]);
    const garbage = importStructure({ version: 0 }, makeConfig(), { migrations: { 0: () => "nope" } });
    expect(codes(expectErrors(garbage))).toEqual(["SNAPSHOT_MIGRATION_FAILED"]);
  });
});

describe("importStructure — format", () => {
  it("rejects non-object input", () => {
    for (const input of [null, 42, "x", []]) {
      expect(codes(expectErrors(importStructure(input, makeConfig())))).toEqual(["SNAPSHOT_INVALID_FORMAT"]);
    }
  });

  it("reports every format error with a JSON pointer and the node id when known", () => {
    const data = {
      version: 1,
      entities: [{ key: "", data: group("a") }, { key: "b" }, "oops"],
      nodes: [
        { id: "n1", entityKey: 5, parentId: 7, childIds: "n2" },
        { id: "n2", entityKey: "b", parentId: null, childIds: [3] },
        { entityKey: "b", parentId: null, childIds: [] },
      ],
      rootIds: [null],
    };
    const errors = expectErrors(importStructure(data, makeConfig()));
    expect(new Set(codes(errors))).toEqual(new Set(["SNAPSHOT_INVALID_FORMAT"]));
    expect(errors.map((error) => error.details?.["pointer"])).toEqual([
      "/entities/0/key",
      "/entities/1/data",
      "/entities/2",
      "/nodes/0/entityKey",
      "/nodes/0/parentId",
      "/nodes/0/childIds",
      "/nodes/1/childIds/0",
      "/nodes/2/id",
      "/rootIds/0",
    ]);
    expect(errors[1]?.entityKey).toBe("b");
    expect(errors[3]?.nodeId).toBe("n1");
    expect(errors[6]?.nodeId).toBe("n2");
  });

  it("requires the top-level arrays", () => {
    const errors = expectErrors(importStructure({ version: 1 }, makeConfig()));
    expect(errors.map((error) => error.details?.["pointer"])).toEqual(["/entities", "/nodes", "/rootIds"]);
  });
});

describe("importStructure — references", () => {
  it("reports unknown entities, parents and children, all at once", () => {
    const data = snapshot();
    data.nodes.push(
      { id: "n3", entityKey: "ghost", parentId: "n2", childIds: [], relationship: { weight: 1 } },
      { id: "n4", entityKey: "a", parentId: "missing", childIds: [], relationship: { weight: 1 } },
    );
    const n1 = data.nodes[0];
    const n2 = data.nodes[1];
    if (n1 === undefined || n2 === undefined) throw new Error("setup");
    n1.childIds.push("n9");
    n2.childIds.push("n3");
    const errors = expectErrors(importStructure(data, makeConfig()));
    expect(errors.filter((error) => error.code === "DANGLING_REFERENCE").map((error) => error.nodeId)).toEqual([
      "n1",
      "n3",
      "n4",
    ]);
    const ghost = errors.find((error) => error.entityKey === "ghost");
    expect(ghost).toMatchObject({ nodeId: "n3", path: ["n1", "n2", "n3"] });
  });

  it("reports unknown roots and parent/child mismatches", () => {
    const data = snapshot();
    data.rootIds.push("n7");
    const n2 = data.nodes[1];
    if (n2 === undefined) throw new Error("setup");
    n2.parentId = null; // listed as child of n1 but claims to be a root
    const errors = expectErrors(importStructure(data, makeConfig()));
    expect(codes(errors)).toEqual(expect.arrayContaining(["DANGLING_REFERENCE", "INCONSISTENT_LINK"]));
  });
});

describe("importStructure — duplicates and identity", () => {
  it("reports duplicate node ids", () => {
    const data = snapshot();
    data.nodes.push({ id: "n2", entityKey: "a", parentId: null, childIds: [], relationship: { weight: 0 } });
    const errors = expectErrors(importStructure(data, makeConfig()));
    expect(errors[0]).toMatchObject({ code: "NODE_ID_COLLISION", nodeId: "n2", details: { pointer: "/nodes/2" } });
  });

  it("reports duplicate entity keys", () => {
    const data = snapshot();
    data.entities.push({ key: "b", data: group("b") });
    const errors = expectErrors(importStructure(data, makeConfig()));
    expect(codes(errors)).toEqual(["IDENTITY_COLLISION"]);
    expect(errors[0]).toMatchObject({ entityKey: "b", details: { pointer: "/entities/2" } });
  });

  it("reports keys that collide after normalization, with the mismatch from the pipeline", () => {
    const data = snapshot();
    data.entities.push({ key: " A ", data: group(" A ") });
    const errors = expectErrors(importStructure(data, makeConfig()));
    expect(errors[0]).toMatchObject({
      code: "IDENTITY_COLLISION",
      entityKey: " A ",
      details: { resolvedKey: "a", existingKey: "a" },
    });
    expect(codes(errors)).toContain("IDENTITY_MISMATCH");
  });

  it("reports a stored key that does not match the entity identity", () => {
    const data = snapshot();
    data.entities[1] = { key: "b", data: group("B-other") };
    const errors = expectErrors(importStructure(data, makeConfig()));
    expect(errors).toEqual([expect.objectContaining({ code: "IDENTITY_MISMATCH", entityKey: "b" })]);
  });

  it("reports entities without a valid identity", () => {
    const data = snapshot();
    data.entities[1] = { key: "b", data: { kind: "group" } };
    expect(codes(expectErrors(importStructure(data, makeConfig())))).toEqual(["IDENTITY_MISSING"]);
  });
});

describe("importStructure — cycles", () => {
  it("names a parent cycle that is detached from the roots", () => {
    const data = snapshot();
    data.nodes.push(
      { id: "c1", entityKey: "a", parentId: "c2", childIds: ["c2"], relationship: { weight: 0 } },
      { id: "c2", entityKey: "b", parentId: "c1", childIds: ["c1"], relationship: { weight: 0 } },
    );
    const errors = expectErrors(importStructure(data, makeConfig()));
    const cycles = errors.filter((error) => error.code === "CYCLE_DETECTED");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.details?.["cycle"]).toEqual(["c1", "c2"]);
    expect(codes(errors)).toContain("INCONSISTENT_LINK");
  });

  it("blocks identity cycles (a → b → a) by default", () => {
    const data = snapshot();
    const n2 = data.nodes[1];
    if (n2 === undefined) throw new Error("setup");
    n2.childIds.push("n3");
    data.nodes.push({ id: "n3", entityKey: "a", parentId: "n2", childIds: [], relationship: { weight: 0 } });
    const errors = expectErrors(importStructure(data, makeConfig()));
    expect(codes(errors)).toEqual(["IDENTITY_CYCLE"]);
    expect(errors[0]?.path).toBeDefined();
    expect(
      importStructure(data, makeConfig({ policies: { identityCycles: "allow" } })).ok,
    ).toBe(true);
  });

  it("enforces maxDepth", () => {
    const errors = expectErrors(importStructure(snapshot(), makeConfig({ policies: { maxDepth: 0 } })));
    expect(errors).toEqual([expect.objectContaining({ code: "MAX_DEPTH_EXCEEDED", nodeId: "n2", path: ["n1", "n2"] })]);
  });
});

describe("importStructure — relationship rules and consumer validators", () => {
  it("reports every rule violation and validator error together", () => {
    const data = snapshot();
    data.entities.push({ key: "l", data: leaf("l") }, { key: "m", data: group("m") });
    const n2 = data.nodes[1];
    if (n2 === undefined) throw new Error("setup");
    n2.childIds.push("n3");
    data.nodes.push(
      { id: "n3", entityKey: "l", parentId: "n2", childIds: ["n4"], relationship: { weight: 1 } },
      { id: "n4", entityKey: "m", parentId: "n3", childIds: [], relationship: { weight: -1 } },
      { id: "n5", entityKey: "b", parentId: null, childIds: [], relationship: { weight: -2 } },
      { id: "n6", entityKey: "b", parentId: null, childIds: [], relationship: { weight: 0 } },
    );
    data.rootIds.push("n5", "n6");
    const config = makeConfig({
      validators: [
        ({ node }) =>
          node.relationship.weight < 0 ? { valid: false, code: "NEGATIVE_WEIGHT", message: "weight < 0" } : { valid: true },
      ],
    });
    const errors = expectErrors(importStructure(data, config));
    expect(codes(errors).sort()).toEqual(["LEAF_PARENT", "NEGATIVE_WEIGHT", "NEGATIVE_WEIGHT", "SIBLING_DUPLICATE"]);
    expect(errors.find((error) => error.code === "LEAF_PARENT")).toMatchObject({
      nodeId: "n4",
      ruleId: "leaf-has-no-children",
      path: ["n1", "n2", "n3", "n4"],
    });
  });

  it("restrictive mode applies to imported links", () => {
    const config = makeConfig({ relationships: { mode: "restrictive", rules: [] } });
    expect(codes(expectErrors(importStructure(snapshot(), config)))).toEqual(["RELATIONSHIP_NOT_ALLOWED"]);
  });

  it("passes the import context to rules and validators, and returns warnings", () => {
    const seen: unknown[] = [];
    const config = makeConfig({
      validators: [
        ({ context, operation }) => {
          seen.push([operation, context]);
          return { valid: false, severity: "warning", code: "HEADS_UP" };
        },
      ],
    });
    const result = importStructure(snapshot(), config, { context: { source: "file" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(codes(result.value.warnings)).toContain("HEADS_UP");
    expect(seen[0]).toEqual(["validateStructure", { source: "file" }]);
  });
});

describe("importStructure — configuration and catalog", () => {
  it("throws on invalid configuration", () => {
    expect(() => importStructure(snapshot(), { identity: {} } as never)).toThrow(EntityStructureConfigError);
  });

  it("registers the snapshot codes in the catalog", () => {
    expect(CORE_ERROR_CODES.SNAPSHOT_INVALID_FORMAT).toBe("structure");
    expect(CORE_ERROR_CODES.SNAPSHOT_UNSUPPORTED_VERSION).toBe("structure");
    expect(CORE_ERROR_CODES.SNAPSHOT_MIGRATION_FAILED).toBe("structure");
  });
});
