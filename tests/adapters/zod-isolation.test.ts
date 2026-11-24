import { expect, it, vi } from "vitest";

// Any attempt to load zod from this module graph fails the test.
vi.mock("zod", () => {
  throw new Error("The core must not load zod.");
});

it("the core works without zod", async () => {
  const core = await import("../../src/index.js");
  const structure = core.createEntityStructure<{ id: string }, null>({
    identity: { key: "id" },
    relationships: { mode: "permissive" },
  });
  const root = structure.addNode({ entity: { id: "a" }, relationship: null });
  expect(root.ok).toBe(true);
  if (root.ok) expect(structure.addNode({ entity: { id: "b" }, parentId: root.value.nodeId, relationship: null }).ok).toBe(true);
  const snapshot = core.exportStructure(structure.getState());
  expect(core.importStructure(snapshot, { identity: { key: "id" }, relationships: { mode: "permissive" } }).ok).toBe(true);
});
