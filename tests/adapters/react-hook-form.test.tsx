// @vitest-environment jsdom
/// <reference lib="dom" />
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Controller, FormProvider, useFormContext, useFormState } from "react-hook-form";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStructureResolver,
  FIELD_PATH_UNSAFE,
  useEntityStructureForm,
  useStructureChildren,
  type EntityStructureForm,
  type StructureChild,
  type StructureFormValues,
  type UseEntityStructureFormOptions,
} from "../../src/adapters/react-hook-form/index.js";
import { diffStructure } from "../../src/adapters/react-hook-form/commit.js";
import { addNode, createEmptyState, exportStructure, InvalidStateError, type StructureState } from "../../src/index.js";
import {
  companyA,
  companyB,
  corporateConfig,
  personX,
  personY,
  type Party,
  type Shareholding,
} from "../../examples/corporate-structure.js";

type Values = StructureFormValues<Party, Shareholding>;
type Form = EntityStructureForm<Party, Shareholding>;

function sequentialIds(prefix = "n"): () => string {
  let next = 0;
  return () => `${prefix}${(next += 1)}`;
}

const config = corporateConfig({ createId: sequentialIds() });

/** A: (X, Y) and B: () — built with the pure core, as an app would load it. */
function initialState(): { state: StructureState<Party, Shareholding>; a: string; b: string; x: string; y: string } {
  const ids = sequentialIds("i");
  const local = corporateConfig({ createId: ids });
  const step = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result as Extract<T, { ok: true }>;
  };
  let state = createEmptyState<Party, Shareholding>();
  const a = step(addNode(state, { entity: companyA, relationship: { percentage: 100 } }, local));
  state = a.value.state;
  const b = step(addNode(state, { entity: companyB, relationship: { percentage: 100 } }, local));
  state = b.value.state;
  const x = step(addNode(state, { entity: personX, parentId: a.value.nodeId, relationship: { percentage: 30 } }, local));
  state = x.value.state;
  const y = step(addNode(state, { entity: personY, parentId: a.value.nodeId, relationship: { percentage: 20 } }, local));
  state = y.value.state;
  return { state, a: a.value.nodeId, b: b.value.nodeId, x: x.value.nodeId, y: y.value.nodeId };
}

function NodeRow({ child }: { child: StructureChild }) {
  const { register, control } = useFormContext<Values>();
  const children = useStructureChildren<Party, Shareholding>(child.nodeId);
  const { errors } = useFormState({ control, name: child.path });
  const error = errors.nodes?.[child.nodeId];
  return (
    <li data-testid={`node-${child.nodeId}`}>
      {error?.message !== undefined && <span role="alert" data-code={error.type}>{error.message}</span>}
      {/* Entity data is shared by every occurrence: controlled, so all of them re-render. */}
      <Controller
        control={control}
        name={`${child.entityPath}.name`}
        render={({ field }) => <input aria-label={`name-${child.nodeId}`} {...field} />}
      />
      <input
        aria-label={`pct-${child.nodeId}`}
        type="number"
        {...register(`${child.relationshipPath}.percentage`, { valueAsNumber: true })}
      />
      <ul data-testid={`children-${child.nodeId}`}>
        {children.map((grandchild) => (
          <NodeRow key={grandchild.nodeId} child={grandchild} />
        ))}
      </ul>
    </li>
  );
}

function Roots() {
  const roots = useStructureChildren<Party, Shareholding>(null);
  return (
    <ul data-testid="roots">
      {roots.map((root) => (
        <NodeRow key={root.nodeId} child={root} />
      ))}
    </ul>
  );
}

function setup(options: Partial<UseEntityStructureFormOptions<Party, Shareholding>> = {}) {
  const handle: { form?: Form; submitted: Values[] } = { submitted: [] };
  function App() {
    const form = useEntityStructureForm<Party, Shareholding>({ config, ...options });
    handle.form = form;
    return (
      <FormProvider {...form}>
        <form onSubmit={form.handleSubmit((values) => void handle.submitted.push(values))}>
          <Roots />
          <button type="submit">save</button>
        </form>
      </FormProvider>
    );
  }
  render(<App />);
  const form = (): Form => {
    if (handle.form === undefined) throw new Error("not rendered");
    return handle.form;
  };
  return { form, handle };
}

const input = (label: string) => screen.getByLabelText<HTMLInputElement>(label);
const type = (label: string, value: string) => fireEvent.change(input(label), { target: { value } });
const childIdsIn = (nodeId: string) =>
  Array.from(screen.getByTestId(`children-${nodeId}`).children).map((li) => li.getAttribute("data-testid"));

afterEach(cleanup);

describe("Scenario F — React Hook Form adapter", () => {
  it("renders the nested structure from the normalized state", () => {
    const { state, a, x, y } = initialState();
    setup({ defaultValues: state });
    expect(childIdsIn(a)).toEqual([`node-${x}`, `node-${y}`]);
    expect(input(`name-${x}`).value).toBe("Person X");
    expect(input(`pct-${y}`).value).toBe("20");
  });

  it("moves an occurrence to another parent keeping what the user typed", () => {
    const { state, a, b, x, y } = initialState();
    const { form } = setup({ defaultValues: state });
    type(`pct-${x}`, "45");
    type(`name-${x}`, "Person X (edited)");

    let result: ReturnType<Form["moveNode"]> | undefined;
    act(() => {
      result = form().moveNode({ nodeId: x, newParentId: b });
    });
    expect(result?.ok).toBe(true);
    expect(childIdsIn(a)).toEqual([`node-${y}`]);
    expect(childIdsIn(b)).toEqual([`node-${x}`]);
    expect(input(`pct-${x}`).value).toBe("45");
    expect(input(`name-${x}`).value).toBe("Person X (edited)");

    const current = form().getState();
    expect(current.nodes[x]?.parentId).toBe(b);
    expect(current.nodes[x]?.relationship.percentage).toBe(45);
    expect(form().validateStructure().valid).toBe(true);
  });

  it("moves within the same parent (reorder) keeping values", () => {
    const { state, a, x, y } = initialState();
    const { form } = setup({ defaultValues: state });
    type(`pct-${y}`, "7");
    act(() => void form().moveNode({ nodeId: y, newParentId: a, index: 0 }));
    expect(childIdsIn(a)).toEqual([`node-${y}`, `node-${x}`]);
    expect(input(`pct-${y}`).value).toBe("7");
  });

  it("moves a subtree with its descendants and their values", () => {
    const { state, a, b, x } = initialState();
    const { form } = setup({ defaultValues: state });
    // B becomes a child of A, then a person is added under B, typed, and B moves to the root.
    act(() => void form().moveNode({ nodeId: b, newParentId: a }));
    let added = "";
    act(() => {
      const result = form().addNode({ entity: personX, parentId: b, relationship: { percentage: 10 } });
      if (result.ok) added = result.value.nodeId;
    });
    expect(added).not.toBe("");
    type(`pct-${added}`, "12");
    act(() => void form().moveNode({ nodeId: b, newParentId: null }));
    expect(childIdsIn(b)).toEqual([`node-${added}`]);
    expect(input(`pct-${added}`).value).toBe("12");
    expect(input(`pct-${x}`).value).toBe("30");
  });

  it("adds and removes nested occurrences without touching the other values", () => {
    const { state, a, b, x, y } = initialState();
    const { form } = setup({ defaultValues: state });
    type(`pct-${y}`, "25");

    let added = "";
    act(() => {
      const result = form().addNode({ entity: personY, parentId: b, relationship: { percentage: 5 } });
      if (result.ok) added = result.value.nodeId;
    });
    expect(childIdsIn(b)).toEqual([`node-${added}`]);
    type(`pct-${added}`, "6");

    act(() => void form().removeNode(x));
    expect(childIdsIn(a)).toEqual([`node-${y}`]);
    expect(screen.queryByLabelText(`pct-${x}`)).toBeNull();
    expect(input(`pct-${y}`).value).toBe("25");
    expect(input(`pct-${added}`).value).toBe("6");

    const current = form().getState();
    expect(current.nodes[x]).toBeUndefined();
    // The central record survives the removal of one occurrence.
    expect(form().findByIdentity(personX.taxPayer)).toBeDefined();
    expect(form().validateStructure().valid).toBe(true);
  });

  it("keeps a single entity record shared by every occurrence", () => {
    const { state, b } = initialState();
    const { form } = setup({ defaultValues: state });
    let second = "";
    act(() => {
      const result = form().addNode({ entity: personX, parentId: b, relationship: { percentage: 50 } });
      if (result.ok) second = result.value.nodeId;
    });
    const occurrences = form().findAllByIdentity(personX.taxPayer);
    expect(occurrences).toHaveLength(2);
    const [first] = occurrences.filter((node) => node.id !== second);
    if (first === undefined) throw new Error("missing occurrence");

    type(`name-${second}`, "Shared name");
    expect(input(`name-${first.id}`).value).toBe("Shared name");
    const key = form().findByIdentity(personX.taxPayer)?.key ?? "";
    expect(Object.keys(form().getState().entities).filter((k) => k === key)).toHaveLength(1);
    expect(form().getState().entities[key]?.data.name).toBe("Shared name");

    // Each occurrence keeps its own relationship.
    expect(input(`pct-${first.id}`).value).toBe("30");
    expect(input(`pct-${second}`).value).toBe("50");

    act(() => void form().updateEntity({ key, data: { ...personX, name: "Via updateEntity" } }));
    expect(input(`name-${first.id}`).value).toBe("Via updateEntity");
    expect(input(`name-${second}`).value).toBe("Via updateEntity");
  });

  it("updates a relationship through the core and the input follows", () => {
    const { state, x } = initialState();
    const { form } = setup({ defaultValues: state });
    act(() => void form().updateRelationship({ nodeId: x, relationship: { percentage: 33, role: "partner" } }));
    expect(input(`pct-${x}`).value).toBe("33");
    expect(form().getNode(x)?.relationship).toEqual({ percentage: 33, role: "partner" });
  });

  it("rejected operations leave the form untouched", () => {
    const { state, a, x } = initialState();
    const { form } = setup({ defaultValues: state });
    type(`pct-${x}`, "40");
    const before = form().getValues();
    let result: ReturnType<Form["addNode"]> | undefined;
    act(() => {
      // PF cannot hold PJ (consumer rule), so this must fail atomically.
      result = form().addNode({ entity: companyB, parentId: x, relationship: { percentage: 1 } });
    });
    expect(result?.ok).toBe(false);
    if (result !== undefined && !result.ok) expect(result.errors.map((error) => error.code)).toContain("INVALID_SHAREHOLDER");
    expect(form().getValues()).toEqual(before);
    expect(childIdsIn(a)).toHaveLength(2);
    // A cycle is rejected as well.
    act(() => {
      expect(form().moveNode({ nodeId: a, newParentId: x }).ok).toBe(false);
    });
    expect(form().getValues()).toEqual(before);
  });

  it("starts empty, adds roots with numeric keys and survives removing everything", () => {
    const { form } = setup();
    let first = "";
    act(() => {
      const result = form().addNode({ entity: companyA, relationship: { percentage: 100 } });
      if (result.ok) first = result.value.nodeId;
    });
    expect(screen.getByTestId("roots").children).toHaveLength(1);
    // Normalized key "11111111000111" looks numeric: the container must stay an object.
    expect(Array.isArray(form().getValues().entities)).toBe(false);
    act(() => void form().removeNode(first));
    act(() => void form().removeEntity(form().findByIdentity(companyA.taxPayer)?.key ?? ""));
    expect(form().getState()).toEqual({ entities: {}, nodes: {}, rootIds: [] });
    act(() => {
      const result = form().addNode({ entity: companyB, relationship: { percentage: 100 } });
      expect(result.ok).toBe(true);
    });
    expect(Array.isArray(form().getValues().entities)).toBe(false);
    expect(Array.isArray(form().getValues().nodes)).toBe(false);
    expect(form().validateStructure().valid).toBe(true);
  });

  it("rekeys an entity and every occurrence follows", () => {
    const { state, x } = initialState();
    const { form } = setup({ defaultValues: state });
    const oldKey = form().findByIdentity(personX.taxPayer)?.key ?? "";
    act(() => {
      const result = form().rekeyEntity({ key: oldKey, data: { ...personX, taxPayer: "555.555.555-55" } });
      expect(result.ok).toBe(true);
    });
    expect(form().getState().entities[oldKey]).toBeUndefined();
    expect(form().getNode(x)?.entityKey).toBe("55555555555");
    expect(input(`name-${x}`).value).toBe("Person X");
    type(`name-${x}`, "After rekey");
    expect(form().getState().entities["55555555555"]?.data.name).toBe("After rekey");
  });

  it("reset loads imported data, and rejects invalid data", () => {
    const { state, a, b } = initialState();
    const { form } = setup({ defaultValues: state });
    type(`pct-${a}`, "1");

    // A snapshot as it would come from a server: only A with one child.
    const other = initialState();
    const snapshot = exportStructure(other.state);
    const trimmed = {
      ...snapshot,
      nodes: snapshot.nodes.filter((node) => node.id !== other.b && node.id !== other.y),
      rootIds: [other.a],
    };
    const aNode = trimmed.nodes.find((node) => node.id === other.a);
    if (aNode !== undefined) Object.assign(aNode, { childIds: [other.x] });
    let imported: ReturnType<Form["importSnapshot"]> | undefined;
    act(() => {
      imported = form().importSnapshot(JSON.parse(JSON.stringify(trimmed)));
    });
    expect(imported?.ok).toBe(true);
    expect(screen.queryByTestId(`node-${b}`)).toBeNull();
    expect(input(`pct-${a}`).value).toBe("100");
    expect(childIdsIn(a)).toEqual([`node-${other.x}`]);

    // Invalid snapshot: nothing changes.
    act(() => {
      const bad = form().importSnapshot({ version: 1, entities: [], nodes: [{ id: "z" }], rootIds: ["z"] });
      expect(bad.ok).toBe(false);
    });
    expect(childIdsIn(a)).toEqual([`node-${other.x}`]);

    // `reset` with a core state, and with an invalid one.
    act(() => form().reset(state));
    expect(screen.getByTestId(`node-${b}`)).toBeDefined();
    const broken: StructureState<Party, Shareholding> = { ...state, rootIds: [...state.rootIds, "ghost"] };
    expect(() => form().reset(broken)).toThrow(InvalidStateError);
    expect(screen.getByTestId(`node-${b}`)).toBeDefined();

    // `reset()` goes back to the default values.
    act(() => void form().removeNode(b));
    act(() => form().reset());
    expect(screen.getByTestId(`node-${b}`)).toBeDefined();
    expect(form().validateStructure().valid).toBe(true);
  });

  it("accepts a snapshot as defaultValues and rejects invalid defaults", () => {
    const { state, x } = initialState();
    setup({ defaultValues: exportStructure(state) });
    expect(input(`pct-${x}`).value).toBe("30");
    cleanup();
    const broken: StructureState<Party, Shareholding> = { ...state, rootIds: ["ghost"] };
    expect(() => render(<Probe options={{ config, defaultValues: broken }} />)).toThrow(InvalidStateError);
  });

  it("rejects ids and keys that cannot be form paths", () => {
    const { form } = setup({ config: corporateConfig({ identity: { key: "taxPayer" }, createId: sequentialIds() }) });
    act(() => {
      const result = form().addNode({ entity: companyA, relationship: { percentage: 100 } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]?.code).toBe(FIELD_PATH_UNSAFE);
    });
    expect(form().getState()).toEqual({ entities: {}, nodes: {}, rootIds: [] });
  });

  it("createStructureResolver blocks handleSubmit on an invalid structure", async () => {
    const { state, a, x } = initialState();
    const { handle } = setup({ defaultValues: state, resolver: createStructureResolver(config) });
    type(`pct-${x}`, "90"); // 90 + 20 > 100 under A
    await act(async () => {
      fireEvent.click(screen.getByText("save"));
    });
    expect(handle.submitted).toHaveLength(0);
    const alert = screen.getByTestId(`node-${a}`).querySelector('[role="alert"]');
    expect(alert?.getAttribute("data-code")).toBe("PERCENTAGE_EXCEEDED");
    expect(alert?.textContent).toBe("Shares add up to 110%.");

    type(`pct-${x}`, "50");
    await act(async () => {
      fireEvent.click(screen.getByText("save"));
    });
    expect(handle.submitted).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(handle.submitted[0]?.nodes[x]?.relationship.percentage).toBe(50);
  });
});

function Probe({ options }: { options: UseEntityStructureFormOptions<Party, Shareholding> }) {
  useEntityStructureForm(options);
  return null;
}

describe("diffStructure", () => {
  it("a move only writes parentId and the two child lists", () => {
    const { state, a, b, x } = initialState();
    const moved = (() => {
      const nodes = { ...state.nodes };
      const nodeA = nodes[a];
      const nodeB = nodes[b];
      const nodeX = nodes[x];
      if (nodeA === undefined || nodeB === undefined || nodeX === undefined) throw new Error("fixture");
      nodes[a] = { ...nodeA, childIds: nodeA.childIds.filter((id) => id !== x) };
      nodes[b] = { ...nodeB, childIds: [x] };
      nodes[x] = { ...nodeX, parentId: b };
      return { ...state, nodes };
    })();
    expect(diffStructure(state, moved, { nodes: true, entities: true })).toEqual([
      { type: "set", name: `nodes.${a}.childIds`, value: [state.nodes[a]?.childIds[1]] },
      { type: "set", name: `nodes.${b}.childIds`, value: [x] },
      { type: "set", name: `nodes.${x}.parentId`, value: b },
    ]);
  });

  it("writes whole containers when React Hook Form dropped them", () => {
    const { state } = initialState();
    const writes = diffStructure(createEmptyState<Party, Shareholding>(), state, { nodes: false, entities: false });
    expect(writes.map((write) => write.name)).toEqual(["entities", "nodes", "rootIds"]);
  });
});
