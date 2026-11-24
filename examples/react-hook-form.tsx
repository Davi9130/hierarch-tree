/**
 * Example: editing a shareholding structure with React Hook Form. This file is
 * type-checked with the project (`pnpm typecheck`); `docs/react-hook-form.md`
 * walks through it and `tests/adapters/react-hook-form.test.tsx` runs the same
 * pattern in jsdom.
 */
import { Controller, FormProvider, useFormContext, useFormState } from "react-hook-form";
import {
  createStructureResolver,
  useEntityStructureForm,
  useStructureChildren,
  type StructureChild,
  type StructureFormValues,
} from "../src/adapters/react-hook-form/index.js";
import type { StructureState } from "../src/index.js";
import { corporateConfig, personY, type Party, type Shareholding } from "./corporate-structure.js";

type Values = StructureFormValues<Party, Shareholding>;

const config = corporateConfig();
// Created once: it runs the full core pipeline on submit.
const resolver = createStructureResolver(config);

/** One occurrence. Recursion is plain component recursion. */
function Occurrence({ child }: { child: StructureChild }) {
  const form = useFormContext<Values>();
  const children = useStructureChildren<Party, Shareholding>(child.nodeId);
  const { errors } = useFormState({ control: form.control, name: child.path });
  const error = errors.nodes?.[child.nodeId];

  return (
    <li>
      {/* Shared by every occurrence of the entity: use a controlled field. */}
      <Controller
        control={form.control}
        name={`${child.entityPath}.name`}
        render={({ field }) => <input {...field} />}
      />
      {/* This occurrence's own link data. */}
      <input type="number" {...form.register(`${child.relationshipPath}.percentage`, { valueAsNumber: true })} />
      {error?.message !== undefined && <span role="alert">{error.message}</span>}
      <ul>
        {children.map((grandchild) => (
          <Occurrence key={grandchild.nodeId} child={grandchild} />
        ))}
      </ul>
    </li>
  );
}

export function ShareholdingForm({
  initial,
  onSave,
}: {
  initial: StructureState<Party, Shareholding>;
  onSave: (values: Values) => void;
}) {
  const form = useEntityStructureForm<Party, Shareholding>({
    config,
    defaultValues: initial,
    resolver,
  });
  const roots = useStructureChildren<Party, Shareholding>(null, { control: form.control });
  const firstRoot = roots[0];
  const secondRoot = roots[1];

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSave)}>
        <ul>
          {roots.map((root) => (
            <Occurrence key={root.nodeId} child={root} />
          ))}
        </ul>
        {firstRoot !== undefined && (
          <button
            type="button"
            onClick={() => form.addNode({ entity: personY, parentId: firstRoot.nodeId, relationship: { percentage: 0 } })}
          >
            Add Person Y
          </button>
        )}
        {firstRoot !== undefined && secondRoot !== undefined && (
          <button
            type="button"
            onClick={() => {
              const [first] = form.getNode(firstRoot.nodeId)?.childIds ?? [];
              if (first !== undefined) form.moveNode({ nodeId: first, newParentId: secondRoot.nodeId });
            }}
          >
            Move first shareholder
          </button>
        )}
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}
