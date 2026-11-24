/**
 * Example: a shareholding structure kept in a Zustand store. This file is
 * type-checked with the project (`pnpm typecheck`); `docs/zustand.md` walks
 * through it.
 */
import { createEntityStructureStore, selectAllByIdentity, selectChildren, selectNode } from "../src/adapters/zustand/index.js";
import { companyA, corporateConfig, personX, type Party, type Shareholding } from "./corporate-structure.js";

// One store per structure (e.g. per screen or per form); never a singleton.
export const shareholdingStore = createEntityStructureStore<Party, Shareholding>({
  config: corporateConfig(),
});

export function buildExample(): string[] {
  const { actions } = shareholdingStore.getState();

  const company = actions.addNode({ entity: companyA, relationship: { percentage: 100 } });
  if (!company.ok) return company.errors.map((error) => error.code);

  const partner = actions.addNode({
    entity: personX,
    parentId: company.value.nodeId,
    relationship: { percentage: 60, role: "partner" },
  });
  if (!partner.ok) return partner.errors.map((error) => error.code);

  // Invalid: shares would add up to 150%. Nothing changes and nobody is notified.
  const tooMuch = actions.updateRelationship({ nodeId: partner.value.nodeId, relationship: { percentage: 150 } });
  const rejected = tooMuch.ok ? [] : tooMuch.errors.map((error) => error.code); // ["PERCENTAGE_EXCEEDED"]

  const state = shareholdingStore.getState();
  const node = selectNode<Party, Shareholding>(partner.value.nodeId)(state);
  const children = selectChildren<Party, Shareholding>(company.value.nodeId)(state);
  const occurrences = selectAllByIdentity<Party, Shareholding>("333.333.333-33")(state);
  return [String(node?.relationship.percentage), String(children.length), String(occurrences.length), ...rejected];
}
