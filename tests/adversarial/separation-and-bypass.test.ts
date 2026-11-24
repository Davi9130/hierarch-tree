/**
 * TES-29 — independent verification: identity / occurrence / relationship
 * separation, and attempts to get around the rules through alternative operations.
 */
import { describe, expect, it } from "vitest";
import {
  addNode,
  createEmptyState,
  findAllByIdentity,
  moveNode,
  rekeyEntity,
  removeEntity,
  removeNode,
  updateEntity,
  updateRelationship,
  validateStructure,
  type EntityStructureConfig,
} from "../../src/index.js";
import { companyA, corporateConfig, personX, type Party, type Shareholding } from "../../examples/corporate-structure.js";
import { codes, expectFailure, sequentialIds, unwrap } from "../helpers.js";
import { config, group, leaf, rel, sample, type Ent, type Rel, type S } from "./fixtures.js";

describe("separation: identity vs occurrence vs relationship", () => {
  it("updating one occurrence's relationship does not touch the other occurrence of the same entity", () => {
    const cfg = config();
    const s = sample(cfg);
    const before5 = s.nodes["n5"];
    const next = unwrap(updateRelationship(s, { nodeId: "n2", relationship: rel(99, "changed") }, cfg)).state;
    expect(next.nodes["n2"]?.relationship).toEqual(rel(99, "changed"));
    expect(next.nodes["n5"]).toBe(before5); // same reference: untouched
    expect(next.nodes["n5"]?.relationship).toEqual(rel(30, "second"));
    expect(next.entities).toBe(s.entities); // registry untouched by a relationship edit
  });

  it("updating the central record is reflected in every occurrence, without touching relationships", () => {
    const cfg = config();
    const s = sample(cfg);
    const next = unwrap(updateEntity(s, { key: "X", data: leaf("X", "renamed") }, cfg)).state;
    expect(next.nodes).toBe(s.nodes); // occurrences hold only the key
    const occurrences = findAllByIdentity(next, "X", cfg);
    expect(occurrences.map((node) => node.id)).toEqual(["n2", "n5"]);
    for (const node of occurrences) expect(next.entities[node.entityKey]?.data.label).toBe("renamed");
    expect(next.nodes["n2"]?.relationship).toEqual(rel(10, "first"));
    expect(next.nodes["n5"]?.relationship).toEqual(rel(30, "second"));
  });

  it("removing one occurrence keeps the central record and the other occurrence", () => {
    const cfg = config();
    const s = sample(cfg);
    const next = unwrap(removeNode(s, { nodeId: "n5" }, cfg)).state;
    expect(next.entities["X"]).toBe(s.entities["X"]);
    expect(findAllByIdentity(next, "X", cfg).map((node) => node.id)).toEqual(["n2"]);
  });

  it("rekeyEntity moves every occurrence to the new key and keeps per-occurrence relationships", () => {
    const cfg = config();
    const s = sample(cfg);
    const next = unwrap(rekeyEntity(s, { key: "X", data: leaf("X2") }, cfg)).state;
    expect(next.entities["X"]).toBeUndefined();
    expect(next.nodes["n2"]?.entityKey).toBe("X2");
    expect(next.nodes["n5"]?.entityKey).toBe("X2");
    expect(next.nodes["n2"]?.relationship).toEqual(rel(10, "first"));
    expect(next.nodes["n5"]?.relationship).toEqual(rel(30, "second"));
    expect(validateStructure(next, cfg).valid).toBe(true);
  });
});

describe("bypass attempts — every alternative path is revalidated", () => {
  it("updateEntity cannot change the kind of an entity when an existing link would become invalid", () => {
    const cfg = config();
    const s = sample(cfg);
    // L1 is a leaf under X (leaf). Turning L1 into a group makes X → L1 invalid.
    const errors = expectFailure(updateEntity(s, { key: "L1", data: group("L1") }, cfg));
    expect(codes(errors)).toEqual(["RELATIONSHIP_DENIED"]);
    expect(errors[0]?.ruleId).toBe("leaf-no-group");
    expect(errors[0]?.nodeId).toBe("n3");
  });

  it("updateEntity cannot change the identity (must use rekeyEntity)", () => {
    const cfg = config();
    const s = sample(cfg);
    expect(codes(expectFailure(updateEntity(s, { key: "X", data: leaf("Y") }, cfg)))).toEqual([
      "IDENTITY_CHANGE_REQUIRES_REKEY",
    ]);
  });

  it("updateEntity with data whose identity is missing/empty fails", () => {
    const cfg = config();
    const s = sample(cfg);
    expect(codes(expectFailure(updateEntity(s, { key: "X", data: { kind: "leaf" } as unknown as Ent }, cfg)))).toEqual([
      "IDENTITY_MISSING",
    ]);
    expect(codes(expectFailure(updateEntity(s, { key: "X", data: leaf("   ") }, cfg)))).toEqual(["IDENTITY_EMPTY"]);
  });

  it("updateEntity on an entity used under a PF is revalidated with the PF/PJ example (PF → PJ via type change)", () => {
    const cfg = corporateConfig({ createId: sequentialIds() });
    let s = createEmptyState<Party, Shareholding>();
    s = unwrap(addNode(s, { entity: companyA, relationship: { percentage: 100 } }, cfg)).state; // n1
    s = unwrap(addNode(s, { entity: personX, parentId: "n1", relationship: { percentage: 50 } }, cfg)).state; // n2
    const personZ: Party = { taxPayer: "999.999.999-99", type: "PF", name: "Z" };
    s = unwrap(addNode(s, { entity: personZ, parentId: "n2", relationship: { percentage: 10 } }, cfg)).state; // n3
    const errors = expectFailure(
      updateEntity(s, { key: "99999999999", data: { ...personZ, type: "PJ" } }, cfg),
    );
    expect(errors[0]?.ruleId).toBe("pf-cannot-have-pj");
  });

  it("rekeyEntity rejects a collision that only appears after normalization", () => {
    const cfg = config({ identity: { key: "code", normalize: (value) => value.trim().toUpperCase() } });
    let s: S = createEmptyState();
    s = unwrap(addNode(s, { entity: group("a"), relationship: rel(0) }, cfg)).state;
    s = unwrap(addNode(s, { entity: group("b"), relationship: rel(0) }, cfg)).state;
    expect(Object.keys(s.entities)).toEqual(["A", "B"]);
    const errors = expectFailure(rekeyEntity(s, { key: "A", data: group("  b ") }, cfg));
    expect(codes(errors)).toEqual(["IDENTITY_COLLISION"]);
    expect(errors[0]?.entityKey).toBe("B");
  });

  it("rekeyEntity that also changes data into an invalid kind is rejected", () => {
    const cfg = config();
    const s = sample(cfg);
    expect(codes(expectFailure(rekeyEntity(s, { key: "L1", data: group("L1-new") }, cfg)))).toEqual([
      "RELATIONSHIP_DENIED",
    ]);
  });

  it("moveNode to an incompatible destination is rejected (rules revalidated at the destination)", () => {
    const cfg = config();
    const s = sample(cfg);
    // G2 (group) under L9 (leaf) → leaf-no-group.
    const errors = expectFailure(moveNode(s, { nodeId: "n4", newParentId: "n6" }, cfg));
    expect(codes(errors)).toEqual(["RELATIONSHIP_DENIED"]);
  });

  it("moveNode into a destination that already has the same identity as a child is rejected", () => {
    const cfg = config();
    const s = sample(cfg);
    // n5 (X) → G1, which already has X (n2) as a direct child.
    expect(codes(expectFailure(moveNode(s, { nodeId: "n5", newParentId: "n1" }, cfg)))).toEqual([
      "SIBLING_DUPLICATE",
    ]);
  });

  it("removeNode with reparent is revalidated: children landing under an incompatible parent are rejected", () => {
    const cfg = config();
    let s = sample(cfg);
    s = unwrap(addNode(s, { entity: group("W"), parentId: "n1", relationship: rel(0) }, cfg)).state; // n7
    s = unwrap(addNode(s, { entity: group("G5"), parentId: "n7", relationship: rel(0) }, cfg)).state; // n8
    // Remove W (n7) reparenting its child G5 (group) onto X (n2, leaf) → leaf-no-group.
    const errors = expectFailure(removeNode(s, { nodeId: "n7", children: "reparent", reparentTo: "n2" }, cfg));
    expect(codes(errors)).toEqual(["RELATIONSHIP_DENIED"]);
  });

  it("removeNode reparent producing sibling duplicates is rejected", () => {
    const cfg = config();
    const s = sample(cfg);
    // Remove G2 (n4) reparenting its child X (n5) to G1 (n1), which already has X (n2).
    expect(codes(expectFailure(removeNode(s, { nodeId: "n4", children: "reparent" }, cfg)))).toEqual([
      "SIBLING_DUPLICATE",
    ]);
  });

  it("addNode with a new, invalid entity fails and does not register it", () => {
    const cfg = config();
    const s = sample(cfg);
    // valid identity but forbidden link: group under leaf root L9
    const denied = addNode(s, { entity: group("NEW"), parentId: "n6", relationship: rel(0) }, cfg);
    expectFailure(denied);
    // invalid identity
    for (const bad of [{ kind: "leaf" }, { code: "", kind: "leaf" }, { code: null, kind: "leaf" }, { code: {}, kind: "leaf" }]) {
      const result = addNode(s, { entity: bad as unknown as Ent, parentId: "n1", relationship: rel(0) }, cfg);
      expect(result.ok).toBe(false);
    }
    expect(Object.keys(s.entities)).not.toContain("NEW");
  });

  it("addNode with an existing identity reuses the record — new data is not applied silently (decision 2)", () => {
    const cfg = config();
    // Same identity "X" but kind "group" under the leaf root L9 (n6). If the
    // input data were used, leaf → group would be denied; the rules use the
    // REGISTERED record (a leaf), so the link is allowed and the input is dropped.
    const added = addNode(sample(cfg), { entity: group("X", "other"), parentId: "n6", relationship: rel(0) }, cfg);
    expect(added.ok).toBe(true);
    if (added.ok) {
      expect(added.value.state.entities["X"]?.data).toEqual(leaf("X"));
      expect(added.value.events.map((event) => event.type)).toEqual(["NODE_ADDED"]);
    }
  });

  it.each(["block", "when-unreferenced"] as const)("removeEntity on a referenced entity is blocked under %s", (policy) => {
    const cfg = config({ policies: { entityRemoval: policy } });
    const s = sample(cfg);
    const errors = expectFailure(removeEntity(s, { key: "X" }, cfg));
    expect(codes(errors)).toEqual(["ENTITY_IN_USE"]);
    expect(errors[0]?.details?.["nodeIds"]).toEqual(["n2", "n5"]);
  });

  it("removeEntity under force removes every occurrence with its subtree and keeps integrity", () => {
    const cfg = config({ policies: { entityRemoval: "force" } });
    const s = sample(cfg);
    const next = unwrap(removeEntity(s, { key: "X" }, cfg)).state;
    expect(Object.keys(next.nodes).sort()).toEqual(["n1", "n4", "n6"]);
    expect(next.nodes["n1"]?.childIds).toEqual(["n4"]);
    expect(next.nodes["n4"]?.childIds).toEqual([]);
    expect(next.entities["X"]).toBeUndefined();
    expect(validateStructure(next, cfg).valid).toBe(true);
  });

  it("removeEntity under force still runs consumer validators on the affected parents", () => {
    let calls = 0;
    const cfg = config({
      policies: { entityRemoval: "force" },
      validators: [
        ({ node, operation }) => {
          if (operation === "removeEntity" && node.entityKey === "G2") calls += 1;
          return operation === "removeEntity" && node.entityKey === "G2" && node.childIds.length === 0
            ? { valid: false, code: "GROUP_EMPTY" }
            : { valid: true };
        },
      ],
    });
    const s = sample(cfg);
    expect(codes(expectFailure(removeEntity(s, { key: "X" }, cfg)))).toEqual(["GROUP_EMPTY"]);
    expect(calls).toBeGreaterThan(0);
  });

  it("removeNode under when-unreferenced removes the record only with the last occurrence", () => {
    const cfg = config({ policies: { entityRemoval: "when-unreferenced" } });
    let s = sample(cfg);
    s = unwrap(removeNode(s, { nodeId: "n5" }, cfg)).state;
    expect(s.entities["X"]).toBeDefined();
    s = unwrap(removeNode(s, { nodeId: "n2" }, cfg)).state; // cascades L1 too
    expect(s.entities["X"]).toBeUndefined();
    expect(s.entities["L1"]).toBeUndefined();
    expect(validateStructure(s, cfg).valid).toBe(true);
  });

  it("removeNode reparent into own subtree / itself is a cycle", () => {
    const cfg = config();
    const s = sample(cfg);
    expect(codes(expectFailure(removeNode(s, { nodeId: "n2", children: "reparent", reparentTo: "n3" }, cfg)))).toEqual([
      "CYCLE_DETECTED",
    ]);
    expect(codes(expectFailure(removeNode(s, { nodeId: "n2", children: "reparent", reparentTo: "n2" }, cfg)))).toEqual([
      "CYCLE_DETECTED",
    ]);
  });

  it("updateRelationship is checked by `when` rules and by the custom validate predicate", () => {
    const cfg: EntityStructureConfig<Ent, Rel> = config({
      relationships: {
        mode: "permissive",
        rules: [{ id: "no-negative", when: ({ relationship }) => (relationship?.share ?? 0) < 0, allowed: false }],
        validate: ({ relationship }) =>
          (relationship?.share ?? 0) > 100 ? { valid: false, code: "TOO_BIG" } : { valid: true },
      },
    });
    const s = sample(cfg);
    expect(codes(expectFailure(updateRelationship(s, { nodeId: "n2", relationship: rel(-1) }, cfg)))).toEqual([
      "RELATIONSHIP_DENIED",
    ]);
    expect(codes(expectFailure(updateRelationship(s, { nodeId: "n2", relationship: rel(101) }, cfg)))).toEqual([
      "TOO_BIG",
    ]);
  });
});
