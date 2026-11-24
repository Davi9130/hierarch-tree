// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * End-to-end integration (TES-34): the PF/PJ example wired through
 * core + Zod + Zustand and core + Zod + React Hook Form, both starting from the
 * same imported JSON snapshot. Everything goes through the public entrypoints
 * (`src/index.ts` and the adapter `index.ts` files), as a consumer would.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  addNode,
  createEmptyState,
  exportStructure,
  findAllByIdentity,
  getDescendants,
  importStructure,
  InvalidStateError,
  validateStructure,
  type EntityStructureConfig,
  type StructureState,
  type ValidationError,
} from "../../src/index.js";
import {
  createStructureSnapshotSchema,
  parseStructureSnapshot,
  ZOD_ERROR_CODES,
} from "../../src/adapters/zod/index.js";
import {
  createEntityStructureStore,
  selectAllByIdentity,
  selectChildren,
  type EntityStructureActions,
} from "../../src/adapters/zustand/index.js";
import {
  createStructureResolver,
  useEntityStructureForm,
  type StructureFormValues,
} from "../../src/adapters/react-hook-form/index.js";
import { companyA, companyB, personX, personY, type Party, type Shareholding } from "../../examples/corporate-structure.js";
import { corporateZodConfig, partySchema, shareholdingSchema } from "../../examples/corporate-zod.js";
import { codes, sequentialIds, unwrap } from "../helpers.js";

const snapshotSchema = createStructureSnapshotSchema({ entity: partySchema, relationship: shareholdingSchema });
const KEY_A = "11111111000111";
const KEY_X = "33333333333";
const companyC: Party = { taxPayer: "77.777.777/0001-77", type: "PJ", name: "Company C" };

function failuresOf(result: { ok: true } | { ok: false; errors: readonly ValidationError[] }): readonly ValidationError[] {
  return result.ok ? [] : result.errors;
}

function config(prefix = "new"): EntityStructureConfig<Party, Shareholding> {
  return corporateZodConfig({ createId: sequentialIds(prefix) });
}

/**
 * The JSON a backend would send: A(PJ) owns X(PF) 30% and Y(PF) 20%;
 * B(PJ) owns A 40% and X 50% (X appears twice, with different link data).
 */
function snapshotJson(): { json: string; ids: Record<"a" | "b" | "ax" | "ay" | "ba" | "bx", string> } {
  const cfg = corporateZodConfig({ createId: sequentialIds("s") });
  let state = createEmptyState<Party, Shareholding>();
  const add = (input: Parameters<typeof addNode<Party, Shareholding>>[1]): string => {
    const value = unwrap(addNode(state, input, cfg));
    state = value.state;
    return value.nodeId;
  };
  const b = add({ entity: companyB, relationship: { percentage: 100 } });
  const a = add({ entity: companyA, relationship: { percentage: 100 } });
  const ax = add({ entity: personX, parentId: a, relationship: { percentage: 30, role: "partner" } });
  const ay = add({ entity: personY, parentId: a, relationship: { percentage: 20 } });
  const ba = add({ entity: companyA, parentId: b, relationship: { percentage: 40 } });
  const bx = add({ entity: personX, parentId: b, relationship: { percentage: 50 } });
  return { json: JSON.stringify(exportStructure(state)), ids: { a, b, ax, ay, ba, bx } };
}

/** JSON text → Zod-checked snapshot, as the docs recommend before importing. */
function parsedSnapshot() {
  const { json, ids } = snapshotJson();
  const parsed = parseStructureSnapshot(JSON.parse(json), snapshotSchema);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return { snapshot: parsed.value, ids };
}

describe("snapshot gate (Zod) before import", () => {
  it("rejects domain-invalid JSON with the node/entity located, and the core import rejects it too", () => {
    const { json, ids } = snapshotJson();
    const data = JSON.parse(json) as {
      entities: { key: string; data: Party }[];
      nodes: { id: string; relationship: Shareholding }[];
    };
    data.entities.find((entity) => entity.key === "22222222000122")!.data.name = "B"; // too short for partySchema
    data.nodes.find((node) => node.id === ids.ax)!.relationship.percentage = 130; // above shareholdingSchema max

    const parsed = parseStructureSnapshot(data, snapshotSchema);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(codes(parsed.errors)).toEqual(["SNAPSHOT_INVALID_FORMAT", "SNAPSHOT_INVALID_FORMAT"]);
    expect(parsed.errors.map((error) => error.entityKey ?? error.nodeId)).toEqual(["22222222000122", ids.ax]);

    // Skipping the Zod gate does not bypass the domain: the import pipeline runs the same validators.
    const imported = importStructure(data, config());
    expect(imported.ok).toBe(false);
    if (!imported.ok) {
      expect(codes(imported.errors)).toContain(ZOD_ERROR_CODES.ENTITY_SCHEMA_INVALID);
      expect(codes(imported.errors)).toContain(ZOD_ERROR_CODES.RELATIONSHIP_SCHEMA_INVALID);
    }
    expect(() => createEntityStructureStore({ config: config(), initialData: data as never })).toThrow(InvalidStateError);
  });
});

describe("core + Zod + Zustand from an imported snapshot", () => {
  it("loads the snapshot, enforces rules/schemas atomically and round-trips", () => {
    const { snapshot, ids } = parsedSnapshot();
    const store = createEntityStructureStore({ config: config(), initialData: snapshot });
    const { actions } = store.getState();
    const initial = store.getState().structure;

    // Same identity, two occurrences, one central record.
    expect(selectAllByIdentity<Party, Shareholding>("333.333.333-33")(store.getState()).map((n) => n.id).sort()).toEqual([ids.ax, ids.bx].sort());
    expect(Object.keys(initial.entities)).toHaveLength(4);
    expect(selectChildren<Party, Shareholding>(ids.b)(store.getState()).map((n) => n.id)).toEqual([ids.ba, ids.bx]);

    // Each failing operation: structured error, store state identical by reference.
    const failures = [
      actions.addNode({ entity: companyC, parentId: ids.ax, relationship: { percentage: 1 } }), // PF -> PJ denied
      actions.updateEntity({ key: KEY_X, data: { ...personX, name: "X" } }), // partySchema
      actions.updateRelationship({ nodeId: ids.ay, relationship: { percentage: -1 } }), // shareholdingSchema
      actions.updateRelationship({ nodeId: ids.ay, relationship: { percentage: 80 } }), // 30 + 80 > 100
      actions.moveNode({ nodeId: ids.b, newParentId: ids.ba }), // B -> A(under B): structural cycle
      actions.moveNode({ nodeId: ids.b, newParentId: ids.a }), // B under A while A is under B: identity cycle
    ];
    expect(failures.map((result) => (result.ok ? "ok" : result.errors[0]?.code))).toEqual([
      "INVALID_SHAREHOLDER",
      ZOD_ERROR_CODES.ENTITY_SCHEMA_INVALID,
      ZOD_ERROR_CODES.RELATIONSHIP_SCHEMA_INVALID,
      "PERCENTAGE_EXCEEDED",
      expect.stringMatching(/CYCLE/),
      expect.stringMatching(/CYCLE/),
    ]);
    expect(store.getState().structure).toBe(initial);

    // Valid edits.
    unwrap(actions.updateEntity({ key: KEY_X, data: { ...personX, name: "Person X Renamed" } }));
    unwrap(actions.rekeyEntity({ key: KEY_X, data: { ...personX, taxPayer: "555.555.555-55", name: "Person X Renamed" } }));
    unwrap(actions.moveNode({ nodeId: ids.ay, newParentId: null, index: 0 }));
    const after = store.getState().structure;
    expect(after.nodes[ids.ax]?.entityKey).toBe("55555555555");
    expect(after.nodes[ids.bx]?.entityKey).toBe("55555555555");
    expect(after.entities[KEY_X]).toBeUndefined();
    expect(after.rootIds).toEqual([ids.ay, ids.b, ids.a]);
    expect(after.nodes[ids.a]?.childIds).toEqual([ids.ax]);
    // Moving Y under B now would make B's shares 40 + 50 + 20 = 110%: rejected at the destination.
    expect(codes(failuresOf(actions.moveNode({ nodeId: ids.ay, newParentId: ids.b })))).toEqual(["PERCENTAGE_EXCEEDED"]);
    expect(validateStructure(after, config()).valid).toBe(true);

    // Export -> JSON -> import gives back the same state.
    const roundTrip = importStructure(JSON.parse(JSON.stringify(exportStructure(after))), config());
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) expect(roundTrip.value.state).toEqual(after);
  });

  it("two stores from the same snapshot stay independent", () => {
    const { snapshot, ids } = parsedSnapshot();
    const first = createEntityStructureStore({ config: config(), initialData: snapshot });
    const second = createEntityStructureStore({ config: config(), initialData: snapshot });
    unwrap(first.getState().actions.removeNode(ids.bx));
    expect(first.getState().structure.nodes[ids.bx]).toBeUndefined();
    expect(second.getState().structure.nodes[ids.bx]).toBeDefined();
  });
});

describe("core + Zod + React Hook Form from an imported snapshot", () => {
  it("form values are the core state; operations are validated; the resolver gates submit", async () => {
    const { snapshot, ids } = parsedSnapshot();
    const cfg = config();
    const { result } = renderHook(() => {
      const hook = useEntityStructureForm<Party, Shareholding>({
        config: cfg,
        defaultValues: snapshot,
        resolver: createStructureResolver(cfg),
      });
      void hook.formState.errors; // subscribe during render, as a component reading the errors would
      return hook;
    });
    const form = () => result.current;
    const initial = form().getState();
    expect(findAllByIdentity(initial, "333.333.333-33", cfg).map((node) => node.id).sort()).toEqual([ids.ax, ids.bx].sort());
    expect(getDescendants(initial, ids.b).map((node) => node.id)).toEqual([ids.ba, ids.bx]); // occurrences do not share children
    expect(getDescendants(initial, ids.a).map((node) => node.id)).toEqual([ids.ax, ids.ay]);

    // Rules and schemas apply to form operations, atomically.
    act(() => {
      const denied = form().addNode({ entity: companyC, parentId: ids.ay, relationship: { percentage: 1 } });
      expect(denied.ok ? [] : codes(denied.errors)).toContain("INVALID_SHAREHOLDER");
      const invalid = form().addNode({ entity: { ...personY, taxPayer: "666.666.666-66", name: "Z" }, parentId: ids.a, relationship: { percentage: 1 } });
      expect(invalid.ok ? [] : codes(invalid.errors)).toContain(ZOD_ERROR_CODES.ENTITY_SCHEMA_INVALID);
    });
    expect(form().getState()).toEqual(initial);

    let added = "";
    act(() => {
      added = unwrap(form().addNode({ entity: personY, parentId: ids.b, relationship: { percentage: 5 } })).nodeId;
    });
    expect(form().getValues(`nodes.${ids.b}.childIds`)).toEqual([ids.ba, ids.bx, added]);
    expect(findAllByIdentity(form().getState(), personY.taxPayer, cfg)).toHaveLength(2);

    // Typing goes straight into the draft (no pipeline); the resolver blocks submit.
    act(() => form().setValue(`entities.${KEY_A}.data.name`, "A"));
    let submitted: StructureFormValues<Party, Shareholding> | undefined;
    await act(async () => {
      await form().handleSubmit((values) => {
        submitted = values;
      })();
    });
    expect(submitted).toBeUndefined();
    // Entity-schema errors come from the occurrence pipeline, so they land on every occurrence of A
    // (`errors.nodes[nodeId]`), not on `errors.entities[KEY_A]`.
    expect(form().formState.errors.nodes?.[ids.a]?.type).toBe(ZOD_ERROR_CODES.ENTITY_SCHEMA_INVALID);
    expect(form().formState.errors.nodes?.[ids.ba]?.type).toBe(ZOD_ERROR_CODES.ENTITY_SCHEMA_INVALID);
    expect(form().formState.errors.entities?.[KEY_A]).toBeUndefined();

    act(() => form().setValue(`entities.${KEY_A}.data.name`, "Company A Ltda"));
    await act(async () => {
      await form().handleSubmit((values) => {
        submitted = values;
      })();
    });
    expect(submitted).toBeDefined();
    const saved = submitted as StructureState<Party, Shareholding>;
    expect(validateStructure(saved, cfg).valid).toBe(true);
    expect(saved.entities[KEY_A]?.data.name).toBe("Company A Ltda");

    // The submitted value is a plain core state: export/import round-trips.
    const roundTrip = importStructure(JSON.parse(JSON.stringify(exportStructure(saved))), cfg);
    expect(roundTrip.ok && roundTrip.value.state).toEqual(saved);
  });

  it("Zustand and RHF produce the same state for the same operations on the same snapshot", () => {
    const { snapshot, ids } = parsedSnapshot();
    const store = createEntityStructureStore({ config: config("x"), initialData: snapshot });
    const { result } = renderHook(() => useEntityStructureForm<Party, Shareholding>({ config: config("x"), defaultValues: snapshot }));

    const apply = (ops: Pick<EntityStructureActions<Party, Shareholding>, "addNode" | "moveNode" | "updateRelationship">) => [
      ops.addNode({ entity: personY, parentId: ids.b, relationship: { percentage: 10 } }).ok,
      ops.moveNode({ nodeId: ids.ay, newParentId: null }).ok,
      ops.updateRelationship({ nodeId: ids.bx, relationship: { percentage: 45, role: "investor" } }).ok,
      ops.addNode({ entity: companyC, parentId: ids.ax, relationship: { percentage: 1 } }).ok, // denied
    ];

    const storeOutcome = apply(store.getState().actions);
    let formOutcome: boolean[] = [];
    act(() => {
      formOutcome = apply(result.current);
    });
    expect(storeOutcome).toEqual([true, true, true, false]);
    expect(formOutcome).toEqual(storeOutcome);
    expect(result.current.getState()).toEqual(store.getState().structure);
  });
});
