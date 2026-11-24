/**
 * Shared fixtures for the adversarial suite (TES-29). Generic domain: entities
 * have a `kind` ("group" | "leaf"); groups may contain anything, leaves may
 * only contain leaves. Restrictive mode, so anything not allowed is blocked.
 */
import {
  addNode,
  createEmptyState,
  type EntityStructureConfig,
  type StructureState,
} from "../../src/index.js";
import { sequentialIds, unwrap } from "../helpers.js";

export interface Ent {
  code: string;
  kind: "group" | "leaf";
  label?: string;
}

export interface Rel {
  share: number;
  note?: string;
}

export type S = StructureState<Ent, Rel>;

export const group = (code: string, label?: string): Ent =>
  label === undefined ? { code, kind: "group" } : { code, kind: "group", label };
export const leaf = (code: string, label?: string): Ent =>
  label === undefined ? { code, kind: "leaf" } : { code, kind: "leaf", label };
export const rel = (share: number, note?: string): Rel => (note === undefined ? { share } : { share, note });

export function config(
  overrides: Partial<EntityStructureConfig<Ent, Rel>> = {},
): EntityStructureConfig<Ent, Rel> {
  return {
    identity: { key: "code" },
    relationships: {
      mode: "restrictive",
      rules: [
        { id: "group-any", parent: { kind: "group" }, allowed: true },
        { id: "leaf-leaf", parent: { kind: "leaf" }, child: { kind: "leaf" }, allowed: true },
        { id: "leaf-no-group", parent: { kind: "leaf" }, child: { kind: "group" }, allowed: false },
      ],
    },
    createId: sequentialIds(),
    ...overrides,
  };
}

/**
 * G1(n1) ─┬─ X(n2) ── L1(n3)
 *         └─ G2(n4) ── X(n5)
 * L9(n6) root leaf
 */
export function sample(cfg: EntityStructureConfig<Ent, Rel>): S {
  let s: S = createEmptyState();
  s = unwrap(addNode(s, { entity: group("G1"), relationship: rel(100) }, cfg)).state; // n1
  s = unwrap(addNode(s, { entity: leaf("X"), parentId: "n1", relationship: rel(10, "first") }, cfg)).state; // n2
  s = unwrap(addNode(s, { entity: leaf("L1"), parentId: "n2", relationship: rel(1) }, cfg)).state; // n3
  s = unwrap(addNode(s, { entity: group("G2"), parentId: "n1", relationship: rel(20) }, cfg)).state; // n4
  s = unwrap(addNode(s, { entityKey: "X", parentId: "n4", relationship: rel(30, "second") }, cfg)).state; // n5
  s = unwrap(addNode(s, { entity: leaf("L9"), relationship: rel(0) }, cfg)).state; // n6
  return s;
}

/** Builds a chain of `depth` nodes directly in normalized form (no operations). */
export function chainState(depth: number): S {
  const entities: Record<string, { key: string; data: Ent }> = {};
  const nodes: Record<string, { id: string; entityKey: string; parentId: string | null; childIds: string[]; relationship: Rel }> = {};
  for (let i = 0; i < depth; i += 1) {
    const key = `e${i}`;
    entities[key] = { key, data: group(key) };
    nodes[`c${i}`] = {
      id: `c${i}`,
      entityKey: key,
      parentId: i === 0 ? null : `c${i - 1}`,
      childIds: i === depth - 1 ? [] : [`c${i + 1}`],
      relationship: rel(1),
    };
  }
  return { entities, nodes, rootIds: depth > 0 ? ["c0"] : [] };
}

/** One group root ("w-root") with `width` leaf children, built directly in normalized form. */
export function wideState(width: number): S {
  const childIds = Array.from({ length: width }, (_, i) => `w${i}`);
  const entities: Record<string, { key: string; data: Ent }> = { root: { key: "root", data: group("root") } };
  const nodes: Record<string, { id: string; entityKey: string; parentId: string | null; childIds: string[]; relationship: Rel }> = {
    "w-root": { id: "w-root", entityKey: "root", parentId: null, childIds, relationship: rel(0) },
  };
  for (const id of childIds) {
    const key = `k-${id}`;
    entities[key] = { key, data: leaf(key) };
    nodes[id] = { id, entityKey: key, parentId: "w-root", childIds: [], relationship: rel(0) };
  }
  return { entities, nodes, rootIds: ["w-root"] };
}
