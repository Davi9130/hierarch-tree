/**
 * TES-29 — cycles (occurrence and identity), atomicity by reference, and
 * hostile identity keys.
 */
import { describe, expect, it } from "vitest";
import {
  addNode,
  createEmptyState,
  createEntityStructure,
  findByIdentity,
  moveNode,
  normalizeIdentity,
  registerEntity,
  rekeyEntity,
  removeEntity,
  removeNode,
  updateEntity,
  updateRelationship,
  type OperationResult,
} from "../../src/index.js";
import { codes, expectFailure, sequentialIds, unwrap } from "../helpers.js";
import { config, group, leaf, rel, sample, type Ent, type Rel, type S } from "./fixtures.js";

describe("cycles", () => {
  it("occurrence cycles: a node cannot move into itself or any descendant", () => {
    const cfg = config();
    const s = sample(cfg);
    for (const target of ["n1", "n2", "n3", "n4", "n5"]) {
      const result = moveNode(s, { nodeId: "n1", newParentId: target }, cfg);
      expect(codes(expectFailure(result))).toEqual(["CYCLE_DETECTED"]);
    }
    expect(codes(expectFailure(moveNode(s, { nodeId: "n2", newParentId: "n3" }, cfg)))).toEqual(["CYCLE_DETECTED"]);
  });

  it("identity cycles (deny, default): X → Y → X through different occurrences", () => {
    const cfg = config();
    let s: S = createEmptyState();
    s = unwrap(addNode(s, { entity: group("X"), relationship: rel(0) }, cfg)).state; // n1
    s = unwrap(addNode(s, { entity: group("Y"), parentId: "n1", relationship: rel(0) }, cfg)).state; // n2
    // Y → X under the same path
    const direct = expectFailure(addNode(s, { entityKey: "X", parentId: "n2", relationship: rel(0) }, cfg));
    expect(codes(direct)).toEqual(["IDENTITY_CYCLE"]);
    expect(direct[0]?.details?.["cycle"]).toEqual(["X", "Y", "X"]);
    // Y → X in a different branch (decision 1: entity graph, not only the path)
    // note: the failed addNode above already consumed "n3" from createId
    const rootY = unwrap(addNode(s, { entityKey: "Y", relationship: rel(0) }, cfg));
    s = rootY.state;
    expect(codes(expectFailure(addNode(s, { entityKey: "X", parentId: rootY.nodeId, relationship: rel(0) }, cfg)))).toEqual([
      "IDENTITY_CYCLE",
    ]);
    // self loop X → X
    expect(codes(expectFailure(addNode(s, { entityKey: "X", parentId: "n1", relationship: rel(0) }, cfg)))).toContain(
      "IDENTITY_CYCLE",
    );
  });

  it("identity cycles are also caught when created by moveNode, removeNode(reparent) and rekeyEntity", () => {
    const cfg = config();
    let s: S = createEmptyState();
    s = unwrap(addNode(s, { entity: group("X"), relationship: rel(0) }, cfg)).state; // n1
    s = unwrap(addNode(s, { entity: group("Y"), parentId: "n1", relationship: rel(0) }, cfg)).state; // n2
    s = unwrap(addNode(s, { entity: group("Y2"), relationship: rel(0) }, cfg)).state; // n3 (root)
    s = unwrap(addNode(s, { entity: group("Z"), parentId: "n3", relationship: rel(0) }, cfg)).state; // n4 Y2 → Z
    s = unwrap(addNode(s, { entityKey: "X", parentId: "n4", relationship: rel(0) }, cfg)).state; // n5 Z → X
    // move Y2(n3) under Y(n2): edges X→Y, Y→Y2, Y2→Z, Z→X → cycle
    expect(codes(expectFailure(moveNode(s, { nodeId: "n3", newParentId: "n2" }, cfg)))).toEqual(["IDENTITY_CYCLE"]);
    // remove Z(n4) reparenting its child X(n5) onto Y(n2): Y → X closes X → Y → X.
    expect(codes(expectFailure(removeNode(s, { nodeId: "n4", children: "reparent", reparentTo: "n2" }, cfg)))).toEqual([
      "IDENTITY_CYCLE",
    ]);
    // rekey Y2 → "Y": collision, rejected before any cycle could appear
    expect(codes(expectFailure(rekeyEntity(s, { key: "Y2", data: group("Y") }, cfg)))).toEqual(["IDENTITY_COLLISION"]);
  });

  it("identityCycles: allow lets X → Y → X exist but occurrence cycles are still impossible", () => {
    const cfg = config({ policies: { identityCycles: "allow" } });
    let s: S = createEmptyState();
    s = unwrap(addNode(s, { entity: group("X"), relationship: rel(0) }, cfg)).state; // n1
    s = unwrap(addNode(s, { entity: group("Y"), parentId: "n1", relationship: rel(0) }, cfg)).state; // n2
    s = unwrap(addNode(s, { entityKey: "X", parentId: "n2", relationship: rel(0) }, cfg)).state; // n3
    expect(codes(expectFailure(moveNode(s, { nodeId: "n1", newParentId: "n3" }, cfg)))).toEqual(["CYCLE_DETECTED"]);
  });
});

describe("atomicity: failing operations return the same state reference", () => {
  const cfg = config({
    validators: [({ children }) => (children.reduce((sum, child) => sum + child.relationship.share, 0) > 100
      ? { valid: false, code: "OVER_100" }
      : { valid: true })],
  });
  const base = sample(cfg);
  const snapshot = JSON.stringify(base);

  const failing: [string, () => OperationResult<Ent, Rel, object>][] = [
    ["registerEntity collision", () => registerEntity(base, group("G1"), cfg)],
    ["registerEntity invalid", () => registerEntity(base, { kind: "leaf" } as unknown as Ent, cfg)],
    ["updateEntity unknown", () => updateEntity(base, { key: "nope", data: group("nope") }, cfg)],
    ["updateEntity rules", () => updateEntity(base, { key: "L1", data: group("L1") }, cfg)],
    ["rekeyEntity collision", () => rekeyEntity(base, { key: "X", data: leaf("L1") }, cfg)],
    ["removeEntity in use", () => removeEntity(base, { key: "X" }, cfg)],
    ["addNode denied (new entity)", () => addNode(base, { entity: group("NEW"), parentId: "n6", relationship: rel(0) }, cfg)],
    ["addNode validator", () => addNode(base, { entity: leaf("NEW"), parentId: "n1", relationship: rel(90) }, cfg)],
    ["addNode bad index", () => addNode(base, { entity: leaf("NEW"), parentId: "n1", relationship: rel(0), index: 1.5 }, cfg)],
    ["moveNode cycle", () => moveNode(base, { nodeId: "n1", newParentId: "n3" }, cfg)],
    ["moveNode bad index", () => moveNode(base, { nodeId: "n3", newParentId: "n4", index: -2 }, cfg)],
    ["moveNode denied", () => moveNode(base, { nodeId: "n4", newParentId: "n6" }, cfg)],
    ["removeNode unknown", () => removeNode(base, { nodeId: "zz" }, cfg)],
    ["removeNode reparent dup", () => removeNode(base, { nodeId: "n4", children: "reparent" }, cfg)],
    ["updateRelationship validator", () => updateRelationship(base, { nodeId: "n2", relationship: rel(95) }, cfg)],
  ];

  it.each(failing)("%s", (_name, run) => {
    const result = run();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("the stateful wrapper keeps the exact same state reference and does not notify on failure", () => {
    const structure = createEntityStructure(config(), { initialState: base });
    const before = structure.getState();
    let notified = 0;
    structure.subscribe(() => {
      notified += 1;
    });
    expect(structure.moveNode({ nodeId: "n1", newParentId: "n3" }).ok).toBe(false);
    expect(structure.addNode({ entity: group("NEW"), parentId: "n6", relationship: rel(0) }).ok).toBe(false);
    expect(structure.removeEntity("X").ok).toBe(false);
    expect(structure.getState()).toBe(before);
    expect(notified).toBe(0);
  });

  it("a throwing consumer validator propagates but leaves the wrapper state untouched", () => {
    const structure = createEntityStructure(
      config({
        createId: sequentialIds("t"),
        validators: [
          ({ operation }) => {
            if (operation === "addNode") throw new Error("boom");
            return { valid: true };
          },
        ],
      }),
      { initialState: base },
    );
    const before = structure.getState();
    expect(() => structure.addNode({ entity: leaf("Q"), parentId: "n1", relationship: rel(0) })).toThrow("boom");
    expect(structure.getState()).toBe(before);
  });
});

describe("hostile identity keys", () => {
  const cfg = config();

  it.each([
    [undefined, "IDENTITY_MISSING"],
    [null, "IDENTITY_MISSING"],
    ["", "IDENTITY_EMPTY"],
    ["   ", "IDENTITY_EMPTY"],
    ["\t\n", "IDENTITY_EMPTY"],
    [Number.NaN, "IDENTITY_INVALID"],
    [Number.POSITIVE_INFINITY, "IDENTITY_INVALID"],
    [true, "IDENTITY_INVALID"],
    [{}, "IDENTITY_INVALID"],
    [[], "IDENTITY_INVALID"],
    [Symbol("s"), "IDENTITY_INVALID"],
    [10n, "IDENTITY_INVALID"],
  ])("rejects %s with %s", (value, code) => {
    const result = normalizeIdentity(value, cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.code)).toEqual([code]);
  });

  it("numbers are stringified: 1 and \"1\" collide, 0 and -0 collide", () => {
    let s: S = createEmptyState();
    s = unwrap(registerEntity(s, { code: 1, kind: "leaf" } as unknown as Ent, cfg)).state;
    expect(codes(expectFailure(registerEntity(s, leaf("1"), cfg)))).toEqual(["IDENTITY_COLLISION"]);
    s = unwrap(registerEntity(s, { code: 0, kind: "leaf" } as unknown as Ent, cfg)).state;
    expect(codes(expectFailure(registerEntity(s, { code: -0, kind: "leaf" } as unknown as Ent, cfg)))).toEqual([
      "IDENTITY_COLLISION",
    ]);
    expect(findByIdentity(s, 1, cfg)?.key).toBe("1");
  });

  it("normalization that produces a collision is detected on register and on addNode reuse", () => {
    const digits = config({ identity: { key: "code", normalize: (value) => value.replace(/\D/g, "") } });
    let s: S = createEmptyState();
    s = unwrap(registerEntity(s, group("12.345"), digits)).state;
    expect(codes(expectFailure(registerEntity(s, group("12345"), digits)))).toEqual(["IDENTITY_COLLISION"]);
    expect(codes(expectFailure(registerEntity(s, group("ab"), digits)))).toEqual(["IDENTITY_EMPTY"]);
    const added = unwrap(addNode(s, { entity: group("1-2-3-4-5"), relationship: rel(0) }, digits));
    expect(added.entityKey).toBe("12345");
    expect(added.events.map((event) => event.type)).toEqual(["NODE_ADDED"]);
  });

  it("a normalize that returns a non-string is rejected", () => {
    const broken = config({ identity: { key: "code", normalize: () => 42 as unknown as string } });
    expect(codes(expectFailure(registerEntity(createEmptyState<Ent, Rel>(), group("a"), broken)))).toEqual(["IDENTITY_INVALID"]);
  });

  it("prototype-ish keys (__proto__, constructor, hasOwnProperty) behave like plain keys", () => {
    let s: S = createEmptyState();
    for (const key of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
      s = unwrap(addNode(s, { entity: group(key), relationship: rel(0) }, cfg)).state;
      expect(findByIdentity(s, key, cfg)?.data.code).toBe(key);
    }
    expect(Object.keys(s.entities)).toEqual(["__proto__", "constructor", "hasOwnProperty", "toString"]);
    expect(Object.getPrototypeOf(s.entities)).toBe(Object.prototype);
  });

  it("createId returning hostile ids is handled (empty, duplicate, __proto__)", () => {
    const ids = ["", "__proto__", "__proto__"];
    const hostile = config({ createId: () => ids.shift() ?? "x" });
    let s: S = createEmptyState();
    expect(codes(expectFailure(addNode(s, { entity: group("a"), relationship: rel(0) }, hostile)))).toEqual([
      "INVALID_NODE_ID",
    ]);
    s = unwrap(addNode(s, { entity: group("a"), relationship: rel(0) }, hostile)).state;
    expect(s.nodes["__proto__"]?.entityKey).toBe("a");
    expect(codes(expectFailure(addNode(s, { entity: group("b"), relationship: rel(0) }, hostile)))).toEqual([
      "NODE_ID_COLLISION",
    ]);
  });

  it("with sequential ids, the index order is not affected by wrong ids passed by the consumer", () => {
    const seq = config({ createId: sequentialIds() });
    const s = sample(seq);
    expect(codes(expectFailure(moveNode(s, { nodeId: "", newParentId: null }, seq)))).toEqual(["NODE_NOT_FOUND"]);
    expect(codes(expectFailure(moveNode(s, { nodeId: "n2", newParentId: "" }, seq)))).toEqual(["PARENT_NOT_FOUND"]);
    expect(codes(expectFailure(addNode(s, { entityKey: "", relationship: rel(0) }, seq)))).toEqual(["ENTITY_NOT_FOUND"]);
  });
});
