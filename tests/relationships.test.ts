import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  EntityStructureConfigError,
  type EntityStructureConfig,
  type RelationshipRule,
  type StructureState,
} from "../src/index.js";
import { addNode, moveNode, updateRelationship } from "../src/core/structure.js";
import { updateEntity, rekeyEntity } from "../src/core/entity-operations.js";
import { registerEntity } from "../src/core/registry.js";
import { canRelate, getAllowedChildren, getAllowedParents, validateRelationship } from "../src/core/rules.js";
import { validateStructure } from "../src/core/validation.js";
import {
  companyA,
  companyB,
  corporateConfig,
  personX,
  personY,
  type Party,
  type Shareholding,
} from "../examples/corporate-structure.js";
import { codes, expectFailure, sequentialIds, unwrap } from "./helpers.js";

type State = StructureState<Party, Shareholding>;
const share = (percentage: number): Shareholding => ({ percentage });

describe("scenario C — PF/PJ example configuration", () => {
  const config = corporateConfig();

  it.each([
    [companyA, personX, true],
    [companyA, companyB, true],
    [personX, personY, true],
    [personX, companyA, false],
  ])("canRelate(%s, %s) = %s", (parent, child, expected) => {
    expect(canRelate(parent, child, config)).toBe(expected);
  });

  it("applies the same matrix to concrete operations", () => {
    const cfg = corporateConfig({ createId: sequentialIds() });
    let state: State = createEmptyState();
    state = unwrap(addNode(state, { entity: companyA, relationship: share(100) }, cfg)).state; // n1
    state = unwrap(addNode(state, { entity: personX, parentId: "n1", relationship: share(50) }, cfg)).state; // n2
    state = unwrap(addNode(state, { entity: companyB, parentId: "n1", relationship: share(50) }, cfg)).state; // n3
    state = unwrap(addNode(state, { entity: personY, parentId: "n2", relationship: share(100) }, cfg)).state; // n4
    const errors = expectFailure(addNode(state, { entity: companyB, parentId: "n2", relationship: share(0) }, cfg));
    expect(codes(errors)).toEqual(["INVALID_SHAREHOLDER"]);
    expect(errors[0]?.ruleId).toBe("pf-cannot-have-pj");
    expect(errors[0]?.category).toBe("relationship");
  });
});

// ---------------------------------------------------------------------------

interface Thing {
  id: string;
  kind: string;
  tags?: string;
}
type Rule = RelationshipRule<Thing, { tag?: string }>;

function thingConfig(
  rules: Rule[],
  extra: Partial<EntityStructureConfig<Thing, { tag?: string }>> = {},
): EntityStructureConfig<Thing, { tag?: string }> {
  return { identity: { key: "id" }, relationships: { rules, ...extra.relationships }, createId: sequentialIds(), ...extra };
}
const a: Thing = { id: "a", kind: "group" };
const b: Thing = { id: "b", kind: "leaf" };

describe("rule precedence", () => {
  it("deny wins over allow, regardless of order", () => {
    const allowFirst = thingConfig([
      { id: "allow", allowed: true },
      { id: "deny", parent: { kind: "group" }, child: { kind: "leaf" }, allowed: false },
    ]);
    const result = validateRelationship(a, b, allowFirst);
    expect(codes(result.errors)).toEqual(["RELATIONSHIP_DENIED"]);
    expect(result.errors[0]?.ruleId).toBe("deny");
  });

  it("restrictive is the default: no matching rule blocks", () => {
    const config = thingConfig([{ parent: { kind: "other" }, allowed: true }]);
    expect(codes(validateRelationship(a, b, config).errors)).toEqual(["RELATIONSHIP_NOT_ALLOWED"]);
  });

  it("permissive mode: no matching rule allows", () => {
    const config = thingConfig([], { relationships: { mode: "permissive" } });
    expect(canRelate(a, b, config)).toBe(true);
  });

  it("the custom validator always runs: after allow, after deny and in permissive mode", () => {
    const calls: string[] = [];
    const validate = (ctx: { parent: { key: string }; child: { key: string } }) => {
      calls.push(`${ctx.parent.key}>${ctx.child.key}`);
      return { valid: false as const, code: "CUSTOM_NO" };
    };
    const allowed = thingConfig([{ allowed: true }], { relationships: { rules: [{ allowed: true }], validate } });
    expect(codes(validateRelationship(a, b, allowed).errors)).toEqual(["CUSTOM_NO"]);
    const denied = thingConfig([], { relationships: { rules: [{ allowed: false }], validate } });
    expect(codes(validateRelationship(a, b, denied).errors)).toEqual(["RELATIONSHIP_DENIED", "CUSTOM_NO"]);
    const permissive = thingConfig([], { relationships: { mode: "permissive", validate } });
    expect(codes(validateRelationship(a, b, permissive).errors)).toEqual(["CUSTOM_NO"]);
    expect(calls).toEqual(["a>b", "a>b", "a>b"]);
  });

  it("custom validator warnings do not block", () => {
    const config = thingConfig([], {
      relationships: { mode: "permissive", validate: () => ({ valid: false, severity: "warning", code: "HEADS_UP" }) },
    });
    const result = validateRelationship(a, b, config);
    expect(result.valid).toBe(true);
    expect(codes(result.warnings)).toEqual(["HEADS_UP"]);
  });

  it("supports one-of arrays, predicates and `when` conditions on the relationship", () => {
    const config = thingConfig([
      { parent: { kind: ["group", "root"] }, child: (thing) => thing.id.startsWith("b"), allowed: true },
      { allowed: false, when: ({ relationship }) => relationship?.tag === "blocked" },
    ]);
    expect(canRelate(a, b, config)).toBe(true);
    expect(canRelate(a, b, config, { relationship: { tag: "blocked" } })).toBe(false);
    expect(canRelate(a, { id: "c", kind: "leaf" }, config)).toBe(false);
  });

  it("rejects non-primitive declarative matchers and duplicate rule ids", () => {
    const nested = { identity: { key: "id" }, relationships: { rules: [{ parent: { kind: { deep: 1 } }, allowed: true }] } };
    expect(() => canRelate(a, b, nested as unknown as EntityStructureConfig<Thing, unknown>)).toThrow(
      EntityStructureConfigError,
    );
    const dup = thingConfig([
      { id: "x", allowed: true },
      { id: "x", allowed: false },
    ]);
    expect(() => canRelate(a, b, dup)).toThrow(/Duplicate rule id/);
  });
});

describe("rules apply to every mutation", () => {
  function setup(): { config: EntityStructureConfig<Party, Shareholding>; state: State } {
    const config = corporateConfig({ createId: sequentialIds() });
    let state: State = createEmptyState();
    state = unwrap(addNode(state, { entity: companyA, relationship: share(100) }, config)).state; // n1 PJ
    state = unwrap(addNode(state, { entity: personX, parentId: "n1", relationship: share(40) }, config)).state; // n2 PF
    state = unwrap(addNode(state, { entity: companyB, parentId: "n1", relationship: share(40) }, config)).state; // n3 PJ
    return { config, state };
  }

  it("scenario D — moveNode revalidates the rules at the destination", () => {
    const { config, state } = setup();
    const errors = expectFailure(moveNode(state, { nodeId: "n3", newParentId: "n2" }, config));
    expect(codes(errors)).toEqual(["INVALID_SHAREHOLDER"]);
    expect(errors[0]?.nodeId).toBe("n3");
  });

  it("updateEntity revalidates existing links when the type changes", () => {
    const { config, state } = setup();
    // companyA (parent of a PJ) becoming a PF would make PF → PJ.
    const asParent = expectFailure(updateEntity(state, { key: "11111111000111", data: { ...companyA, type: "PF" } }, config));
    expect(codes(asParent)).toEqual(["INVALID_SHAREHOLDER"]);
    // companyB stays valid as a child of a PJ whatever its type.
    expect(updateEntity(state, { key: "22222222000122", data: { ...companyB, type: "PF" } }, config).ok).toBe(true);
  });

  it("rekeyEntity goes through the same rules", () => {
    const { config, state } = setup();
    const errors = expectFailure(
      rekeyEntity(state, { key: "11111111000111", data: { ...companyA, taxPayer: "99", type: "PF" } }, config),
    );
    expect(codes(errors)).toEqual(["INVALID_SHAREHOLDER"]);
  });

  it("consumer validators run on the parent of the touched node", () => {
    const { config, state } = setup();
    const errors = expectFailure(updateRelationship(state, { nodeId: "n2", relationship: share(70) }, config));
    expect(codes(errors)).toEqual(["PERCENTAGE_EXCEEDED"]);
    expect(errors[0]?.nodeId).toBe("n1");
    expect(errors[0]?.category).toBe("domain");
    expect(codes(expectFailure(addNode(state, { entity: personY, parentId: "n1", relationship: share(30) }, config)))).toEqual([
      "PERCENTAGE_EXCEEDED",
    ]);
    expect(addNode(state, { entity: personY, parentId: "n1", relationship: share(20) }, config).ok).toBe(true);
  });

  it("relationship and domain errors are reported together", () => {
    const { config, state } = setup();
    const errors = expectFailure(addNode(state, { entity: companyA, parentId: "n2", relationship: share(500) }, config));
    expect(codes(errors)).toEqual(["IDENTITY_CYCLE"]); // structure errors stop the pipeline
    const both = expectFailure(addNode(state, { entity: { ...companyB, taxPayer: "5" }, parentId: "n2", relationship: share(500) }, config));
    expect(codes(both)).toEqual(["INVALID_SHAREHOLDER", "PERCENTAGE_EXCEEDED"]);
  });

  it("validator warnings are returned on success", () => {
    const config = corporateConfig({
      createId: sequentialIds(),
      validators: [({ node }) => ({ valid: node.relationship.percentage > 0, severity: "warning", code: "ZERO" } as const)],
    });
    const result = unwrap(addNode(createEmptyState<Party, Shareholding>(), { entity: companyA, relationship: share(0) }, config));
    expect(codes(result.warnings)).toEqual(["ZERO"]);
  });
});

describe("compatibility queries", () => {
  it("lists allowed children and parents among registered entities", () => {
    const config = corporateConfig();
    let state: State = createEmptyState();
    for (const party of [companyA, companyB, personX]) state = unwrap(registerEntity(state, party, config)).state;
    const children = getAllowedChildren(state, "33333333333", config).map((record) => record.key);
    expect(children).toEqual(["33333333333"]);
    const parents = getAllowedParents(state, "22222222000122", config).map((record) => record.key);
    expect(parents.sort()).toEqual(["11111111000111", "22222222000122"]);
    expect(getAllowedChildren(state, "unknown", config)).toEqual([]);
  });
});

describe("validateStructure", () => {
  function sample(): { config: EntityStructureConfig<Party, Shareholding>; state: State } {
    const config = corporateConfig({ createId: sequentialIds() });
    let state: State = createEmptyState();
    state = unwrap(addNode(state, { entity: companyA, relationship: share(100) }, config)).state;
    state = unwrap(addNode(state, { entity: personX, parentId: "n1", relationship: share(50) }, config)).state;
    return { config, state };
  }

  it("accepts a valid state", () => {
    const { config, state } = sample();
    expect(validateStructure(state, config)).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("reports rule violations under a stricter configuration", () => {
    const { state } = sample();
    const strict = corporateConfig({ relationships: { mode: "restrictive", rules: [] } });
    expect(codes(validateStructure(state, strict).errors)).toEqual(["RELATIONSHIP_NOT_ALLOWED"]);
  });

  it("detects broken referential integrity", () => {
    const { config, state } = sample();
    const n2 = state.nodes["n2"];
    if (n2 === undefined) throw new Error("setup");
    const dangling: State = { ...state, nodes: { ...state.nodes, n2: { ...n2, entityKey: "ghost" } } };
    expect(codes(validateStructure(dangling, config).errors)).toContain("DANGLING_REFERENCE");
    const orphan: State = { ...state, nodes: { ...state.nodes, n9: { ...n2, id: "n9", parentId: "n1" } } };
    expect(codes(validateStructure(orphan, config).errors)).toContain("INCONSISTENT_LINK");
    const loop: State = {
      ...state,
      rootIds: [],
      nodes: {
        n1: { id: "n1", entityKey: "11111111000111", parentId: "n2", childIds: ["n2"], relationship: share(1) },
        n2: { ...n2, childIds: ["n1"] },
      },
    };
    expect(codes(validateStructure(loop, config).errors)).toContain("INCONSISTENT_LINK");
    const badKey: State = { ...state, entities: { ...state.entities, other: { key: "x", data: personY } } };
    expect(codes(validateStructure(badKey, config).errors)).toContain("IDENTITY_MISMATCH");
  });
});
