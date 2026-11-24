import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createStructureSnapshotSchema,
  parseStructureSnapshot,
  structureSnapshotSchema,
  ZOD_ERROR_CODES,
  zodEntityValidator,
  zodRelationshipValidator,
} from "../../src/adapters/zod/index.js";
import {
  addNode,
  createEmptyState,
  createEntityStructure,
  exportStructure,
  importStructure,
  type EntityStructureConfig,
} from "../../src/index.js";
import { companyA, companyB, personX, type Party, type Shareholding } from "../../examples/corporate-structure.js";
import { corporateZodConfig, partySchema, shareholdingSchema } from "../../examples/corporate-zod.js";
import { codes, expectFailure, sequentialIds, unwrap } from "../helpers.js";

function zodConfig(
  overrides: Partial<EntityStructureConfig<Party, Shareholding>> = {},
): EntityStructureConfig<Party, Shareholding> {
  return corporateZodConfig({ createId: sequentialIds(), ...overrides });
}

/** A → X and B → X: the same entity in two positions. */
function seeded(config = zodConfig()) {
  const structure = createEntityStructure(config);
  const a = unwrap(structure.addNode({ entity: companyA, relationship: { percentage: 100 } })).nodeId;
  const b = unwrap(structure.addNode({ entity: companyB, relationship: { percentage: 100 } })).nodeId;
  const ax = unwrap(structure.addNode({ entity: personX, parentId: a, relationship: { percentage: 40 } })).nodeId;
  const bx = unwrap(structure.addNode({ entity: personX, parentId: b, relationship: { percentage: 60 } })).nodeId;
  return { structure, a, b, ax, bx };
}

describe("zodEntityValidator", () => {
  it("accepts valid entities", () => {
    const { structure } = seeded();
    expect(structure.validateStructure().valid).toBe(true);
  });

  it("blocks addNode with an invalid entity and keeps the state", () => {
    const { structure, a } = seeded();
    const before = structure.getState();
    const result = structure.addNode({
      entity: { taxPayer: "555.555.555-55", type: "PF", name: "Z" },
      parentId: a,
      relationship: { percentage: 10 },
    });
    const errors = expectFailure(result, before, structure.getState());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: ZOD_ERROR_CODES.ENTITY_SCHEMA_INVALID,
      category: "domain",
      nodeId: "n5",
      entityKey: "55555555555",
      path: [a, "n5"],
      details: { source: "entity", path: ["name"], zodCode: "too_small" },
    });
    expect(errors[0]?.message).toBe("O nome precisa ter ao menos 2 caracteres.");
  });

  it("blocks updateEntity and reports every occurrence with its own path", () => {
    const { structure, a, b, ax, bx } = seeded();
    const before = structure.getState();
    const result = structure.updateEntity({
      key: "33333333333",
      data: { ...personX, name: "", type: "XX" as Party["type"] },
    });
    const errors = expectFailure(result, before, structure.getState());
    // An unknown `type` also matches no relationship rule; only the schema errors matter here.
    expect(codes(errors)).toContain("RELATIONSHIP_NOT_ALLOWED");
    const byNode = (nodeId: string) =>
      errors.filter((error) => error.nodeId === nodeId && error.code === ZOD_ERROR_CODES.ENTITY_SCHEMA_INVALID);
    for (const [nodeId, path] of [
      [ax, [a, ax]],
      [bx, [b, bx]],
    ] as const) {
      expect(byNode(nodeId).map((error) => error.details?.["path"])).toEqual([["type"], ["name"]]);
      for (const error of byNode(nodeId)) expect(error.path).toEqual(path);
    }
  });

  it("reports nested paths inside the entity", () => {
    const schema = z.object({ address: z.object({ zip: z.string().length(8) }) });
    const config: EntityStructureConfig<{ id: string; address: { zip: string } }, null> = {
      identity: { key: "id" },
      createId: sequentialIds(),
      validators: [zodEntityValidator(schema)],
    };
    const result = addNode(createEmptyState<{ id: string; address: { zip: string } }, null>(), { entity: { id: "e1", address: { zip: "123" } }, relationship: null }, config);
    const errors = expectFailure(result);
    expect(errors[0]).toMatchObject({ nodeId: "n1", path: ["n1"], details: { path: ["address", "zip"] } });
  });

  it("supports a custom code and warning severity", () => {
    const structure = createEntityStructure(
      zodConfig({ validators: [zodEntityValidator(partySchema, { code: "PARTY_INVALID", severity: "warning" })] }),
    );
    const result = structure.addNode({ entity: { ...companyA, name: "A" }, relationship: { percentage: 1 } });
    const value = unwrap(result);
    expect(codes(value.warnings)).toEqual(["PARTY_INVALID"]);
  });
});

describe("zodRelationshipValidator", () => {
  it("blocks updateRelationship with invalid metadata and keeps the state", () => {
    const { structure, a, ax } = seeded();
    const before = structure.getState();
    const result = structure.updateRelationship({ nodeId: ax, relationship: { percentage: 140 } });
    const errors = expectFailure(result, before, structure.getState());
    // Schema validators run alongside the consumer's own domain validators.
    expect(codes(errors)).toEqual(["RELATIONSHIP_SCHEMA_INVALID", "PERCENTAGE_EXCEEDED"]);
    expect(errors.filter((error) => error.code === ZOD_ERROR_CODES.RELATIONSHIP_SCHEMA_INVALID)).toEqual([
      expect.objectContaining({
        nodeId: ax,
        entityKey: "33333333333",
        path: [a, ax],
        details: { source: "relationship", path: ["percentage"], zodCode: "too_big" },
      }),
    ]);
  });

  it("blocks addNode with invalid metadata", () => {
    const { structure, a } = seeded();
    const result = structure.addNode({
      entity: { taxPayer: "666", type: "PF", name: "Person W" },
      parentId: a,
      relationship: { percentage: -1, role: 3 as unknown as string },
    });
    const errors = expectFailure(result);
    expect(errors.map((error) => error.details?.["path"])).toEqual([["percentage"], ["role"]]);
  });

  it("only blocks the offending occurrence, the other relationship of the same entity stays independent", () => {
    const { structure, bx } = seeded();
    unwrap(structure.updateRelationship({ nodeId: bx, relationship: { percentage: 99 } }));
    expect(structure.findByNodeId(bx)?.relationship).toEqual({ percentage: 99 });
  });

  it("can skip roots, whose relationship has no parent", () => {
    const config: EntityStructureConfig<{ id: string }, { weight: number } | null> = {
      identity: { key: "id" },
      relationships: { mode: "permissive" },
      createId: sequentialIds(),
      validators: [zodRelationshipValidator(z.object({ weight: z.number() }), { skipRoots: true })],
    };
    const structure = createEntityStructure(config);
    const root = unwrap(structure.addNode({ entity: { id: "r" }, relationship: null })).nodeId;
    expect(structure.addNode({ entity: { id: "c" }, parentId: root, relationship: null }).ok).toBe(false);
    expect(structure.addNode({ entity: { id: "c" }, parentId: root, relationship: { weight: 1 } }).ok).toBe(true);

    const strict = createEntityStructure({ ...config, validators: [zodRelationshipValidator(z.object({ weight: z.number() }))] });
    expect(strict.addNode({ entity: { id: "r" }, relationship: null }).ok).toBe(false);
  });

  it("runs on importStructure through the core pipeline", () => {
    const { structure, a, ax } = seeded(zodConfig({ validators: [] }));
    const snapshot = exportStructure(structure.getState());
    const tampered = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) => (node.id === ax ? { ...node, relationship: { percentage: 500 } } : node)),
    };
    const result = importStructure(tampered, zodConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.filter((error) => error.code === "RELATIONSHIP_SCHEMA_INVALID")).toEqual([
        expect.objectContaining({ nodeId: ax, path: [a, ax], details: expect.objectContaining({ path: ["percentage"] }) }),
      ]);
    }
  });
});

describe("structureSnapshotSchema", () => {
  it("accepts what exportStructure writes, and the parsed snapshot imports", () => {
    const { structure } = seeded();
    const json: unknown = JSON.parse(JSON.stringify(exportStructure(structure.getState())));
    expect(structureSnapshotSchema.safeParse(json).success).toBe(true);
    const parsed = parseStructureSnapshot(json);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const imported = importStructure(parsed.value, zodConfig());
      expect(imported.ok).toBe(true);
    }
  });

  it("maps format issues to SNAPSHOT_INVALID_FORMAT with pointer, path and nodeId", () => {
    const { structure, ax } = seeded();
    const snapshot = exportStructure(structure.getState());
    const index = snapshot.nodes.findIndex((node) => node.id === ax);
    const broken = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) => (node.id === ax ? { ...node, parentId: "", childIds: "x" } : node)),
      entities: [...snapshot.entities, { key: "k" }],
    };
    const parsed = parseStructureSnapshot(broken);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SNAPSHOT_INVALID_FORMAT",
          category: "structure",
          nodeId: ax,
          details: expect.objectContaining({ pointer: `/nodes/${index}/parentId`, path: ["nodes", index, "parentId"] }),
        }),
        expect.objectContaining({ nodeId: ax, details: expect.objectContaining({ pointer: `/nodes/${index}/childIds` }) }),
        expect.objectContaining({
          entityKey: "k",
          details: expect.objectContaining({ pointer: `/entities/${snapshot.entities.length}/data` }),
        }),
      ]),
    );
    expect(parsed.errors).toHaveLength(3);
  });

  it("rejects other versions and non-objects", () => {
    expect(parseStructureSnapshot({ version: 2, entities: [], nodes: [], rootIds: [] }).ok).toBe(false);
    const parsed = parseStructureSnapshot("nope");
    expect(parsed.ok ? [] : parsed.errors.map((error) => error.details?.["pointer"])).toEqual([""]);
  });

  it("checks the consumer's data with createStructureSnapshotSchema", () => {
    const { structure, ax } = seeded();
    const snapshot = exportStructure(structure.getState());
    const index = snapshot.nodes.findIndex((node) => node.id === ax);
    const schema = createStructureSnapshotSchema({ entity: partySchema, relationship: shareholdingSchema });
    expect(parseStructureSnapshot(snapshot, schema).ok).toBe(true);

    const tampered = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) => (node.id === ax ? { ...node, relationship: { percentage: "40" } } : node)),
    };
    const parsed = parseStructureSnapshot(tampered, schema);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual([
        expect.objectContaining({
          nodeId: ax,
          details: expect.objectContaining({
            pointer: `/nodes/${index}/relationship/percentage`,
            path: ["nodes", index, "relationship", "percentage"],
          }),
        }),
      ]);
    }
  });
});
