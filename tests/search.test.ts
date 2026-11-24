import { describe, expect, it } from "vitest";
import {
  addNode,
  createEmptyState,
  findAllByIdentity,
  findByIdentity,
  findByNodeId,
  findByPath,
  getAncestors,
  getChildren,
  getDepth,
  getDescendants,
  getOccurrences,
  getParent,
  getPath,
  getRoot,
  searchEntities,
  toTree,
  validateStructure,
  type EntityStructureConfig,
  type StructureState,
} from "../src/index.js";
import { sequentialIds, unwrap } from "./helpers.js";

interface Org {
  code: string;
  label: string;
}
type State = StructureState<Org, { role: string }>;

const config: EntityStructureConfig<Org, { role: string }> = {
  identity: { key: "code", normalize: (value) => value.toLowerCase() },
  relationships: { mode: "permissive" },
  createId: sequentialIds(),
};

/**
 * root(n1) ─┬─ ops(n2) ── x(n4)
 *           └─ dev(n3) ── x(n5) ── y(n6)
 */
function build(): State {
  let state: State = createEmptyState();
  const add = (code: string, parentId: string | null, role = "member"): void => {
    state = unwrap(addNode(state, { entity: { code, label: code.toUpperCase() }, parentId, relationship: { role } }, config)).state;
  };
  add("root", null, "top");
  add("ops", "n1");
  add("dev", "n1");
  add("x", "n2", "lead");
  add("x", "n3", "advisor");
  add("y", "n5");
  return state;
}

describe("search engine", () => {
  const state = build();

  it("separates registry lookups from occurrence lookups", () => {
    expect(findByIdentity(state, "X", config)?.data.label).toBe("X");
    const occurrences = findAllByIdentity(state, "X", config);
    expect(occurrences.map((node) => node.id)).toEqual(["n4", "n5"]);
    expect(occurrences.map((node) => node.relationship.role)).toEqual(["lead", "advisor"]);
    expect(getOccurrences(state, "x")).toHaveLength(2);
    expect(findAllByIdentity(state, "", config)).toEqual([]);
  });

  it("navigates parents, children, ancestors and descendants", () => {
    expect(findByNodeId(state, "n6")?.entityKey).toBe("y");
    expect(getParent(state, "n6")?.id).toBe("n5");
    expect(getParent(state, "n1")).toBeUndefined();
    expect(getChildren(state, "n1").map((node) => node.id)).toEqual(["n2", "n3"]);
    expect(getChildren(state, null).map((node) => node.id)).toEqual(["n1"]);
    expect(getAncestors(state, "n6").map((node) => node.id)).toEqual(["n5", "n3", "n1"]);
    expect(getDescendants(state, "n1").map((node) => node.id)).toEqual(["n2", "n4", "n3", "n5", "n6"]);
    expect(getRoot(state, "n6")?.id).toBe("n1");
  });

  it("computes depth and paths", () => {
    expect(getDepth(state, "n1")).toBe(0);
    expect(getDepth(state, "n6")).toBe(3);
    expect(getDepth(state, "missing")).toBeUndefined();
    expect(getPath(state, "n6")).toEqual(["n1", "n3", "n5", "n6"]);
    expect(findByPath(state, ["root", "dev", "x", "y"])?.id).toBe("n6");
    expect(findByPath(state, ["root", "ops", "y"])).toBeUndefined();
  });

  it("searches the registry with a predicate", () => {
    expect(searchEntities(state, (entity) => entity.label.startsWith("D")).map((record) => record.key)).toEqual(["dev"]);
  });

  it("derives a nested tree view", () => {
    const [root] = toTree(state);
    expect(root?.entity.label).toBe("ROOT");
    expect(root?.children.map((child) => child.entityKey)).toEqual(["ops", "dev"]);
    expect(root?.children[1]?.children[0]?.children[0]?.entityKey).toBe("y");
    expect(toTree(state, "n5").map((node) => node.id)).toEqual(["n5"]);
  });

  it("handles deep structures without recursion", () => {
    // Built directly (not through operations) to keep the test fast.
    const depth = 20_000;
    const entities: Record<string, { key: string; data: Org }> = {};
    const nodes: Record<string, State["nodes"][string]> = {};
    for (let i = 0; i < depth; i += 1) {
      entities[`e${i}`] = { key: `e${i}`, data: { code: `e${i}`, label: "" } };
      nodes[`d${i}`] = {
        id: `d${i}`,
        entityKey: `e${i}`,
        parentId: i === 0 ? null : `d${i - 1}`,
        childIds: i === depth - 1 ? [] : [`d${i + 1}`],
        relationship: { role: "" },
      };
    }
    const deep: State = { entities, nodes, rootIds: ["d0"] };
    const deepConfig: EntityStructureConfig<Org, { role: string }> = {
      identity: { key: "code" },
      relationships: { mode: "permissive" },
    };
    expect(getDepth(deep, `d${depth - 1}`)).toBe(depth - 1);
    expect(getDescendants(deep, "d0")).toHaveLength(depth - 1);
    expect(getAncestors(deep, `d${depth - 1}`)).toHaveLength(depth - 1);
    expect(toTree(deep)).toHaveLength(1);
    expect(validateStructure(deep, deepConfig).valid).toBe(true);
    const leaf = addNode(deep, { entity: { code: "leaf", label: "" }, parentId: `d${depth - 1}`, relationship: { role: "" } }, {
      ...deepConfig,
      createId: () => "leaf",
    });
    expect(leaf.ok).toBe(true);
  });
});
