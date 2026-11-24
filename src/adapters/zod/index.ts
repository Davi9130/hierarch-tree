/**
 * Optional Zod adapter (`hierarch-tree/zod`). Turns consumer-defined Zod
 * schemas into validators for the core pipeline and validates snapshots before
 * `importStructure`. The core never imports this module, so it works without
 * `zod` installed.
 */
import { z } from "zod";
import type {
  EntityKey,
  NodeId,
  Result,
  StructureSnapshotV1,
  StructureValidator,
  ValidationError,
  Verdict,
} from "../../index.js";

/** Codes produced by this adapter (category `"domain"` once in the pipeline). */
export const ZOD_ERROR_CODES = {
  ENTITY_SCHEMA_INVALID: "ENTITY_SCHEMA_INVALID",
  RELATIONSHIP_SCHEMA_INVALID: "RELATIONSHIP_SCHEMA_INVALID",
} as const;

/** Any Zod 4 schema (classic or mini). */
export type ZodSchema<TOutput = unknown> = z.core.$ZodType<TOutput>;

/** A Zod issue path, with symbols converted to strings so it stays serializable. */
export type ZodIssuePath = readonly (string | number)[];

/** `details` of every error produced from a Zod issue. */
export interface ZodIssueDetails {
  readonly source: "entity" | "relationship" | "snapshot";
  /** Path inside the validated value (e.g. `["address", "zip"]`). */
  readonly path: ZodIssuePath;
  /** The Zod issue code (e.g. `"too_small"`). */
  readonly zodCode: string;
}

export interface ZodValidatorOptions {
  /** Error code reported for each issue. Defaults to the `ZOD_ERROR_CODES` entry. */
  readonly code?: string;
  /** `"warning"` reports the issues without blocking the operation. Default `"error"`. */
  readonly severity?: "error" | "warning";
}

export interface ZodRelationshipValidatorOptions extends ZodValidatorOptions {
  /** Skip root nodes, whose relationship has no parent. Default `false`. */
  readonly skipRoots?: boolean;
}

function toPath(path: readonly PropertyKey[]): ZodIssuePath {
  return path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment));
}

function toVerdicts(
  issues: readonly z.core.$ZodIssue[],
  source: "entity" | "relationship",
  code: string,
  severity: "error" | "warning",
): Verdict[] {
  return issues.map((issue) => {
    const details: ZodIssueDetails = { source, path: toPath(issue.path), zodCode: issue.code };
    return { valid: false, code, message: issue.message, severity, details: { ...details } };
  });
}

/**
 * Validates the central data of every occurrence the pipeline touches against
 * `schema`. Each Zod issue becomes one `ValidationError`: the core fills
 * `nodeId`, `entityKey` and `path` (node ids from the root); the path inside
 * the entity is `details.path`.
 *
 * Runs on `addNode`, `updateEntity`, `rekeyEntity`, `moveNode`, `importStructure`
 * and `validateStructure`. An entity registered without any occurrence
 * (`registerEntity` alone) is not checked until it is placed in the structure.
 */
export function zodEntityValidator<TEntity = unknown, TRelationship = unknown>(
  schema: ZodSchema,
  options: ZodValidatorOptions = {},
): StructureValidator<TEntity, TRelationship> {
  const code = options.code ?? ZOD_ERROR_CODES.ENTITY_SCHEMA_INVALID;
  const severity = options.severity ?? "error";
  return ({ node }) => {
    const result = z.safeParse(schema, node.entity);
    return result.success ? { valid: true } : toVerdicts(result.error.issues, "entity", code, severity);
  };
}

/**
 * Validates the relationship metadata of every occurrence the pipeline touches
 * against `schema`. Runs on `addNode`, `updateRelationship`, `moveNode`,
 * `importStructure` and `validateStructure`. Errors carry `nodeId` and `path`
 * of the occurrence; the path inside the relationship is `details.path`.
 */
export function zodRelationshipValidator<TEntity = unknown, TRelationship = unknown>(
  schema: ZodSchema,
  options: ZodRelationshipValidatorOptions = {},
): StructureValidator<TEntity, TRelationship> {
  const code = options.code ?? ZOD_ERROR_CODES.RELATIONSHIP_SCHEMA_INVALID;
  const severity = options.severity ?? "error";
  const skipRoots = options.skipRoots ?? false;
  return ({ node }) => {
    if (skipRoots && node.parentId === null) return { valid: true };
    const result = z.safeParse(schema, node.relationship);
    return result.success ? { valid: true } : toVerdicts(result.error.issues, "relationship", code, severity);
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

const id = z.string().min(1, "Must be a non-empty string.");

export interface StructureSnapshotSchemaOptions<TEntity, TRelationship> {
  /** Schema for `entities[].data`; use `z.unknown()` to leave it unchecked. */
  readonly entity: ZodSchema<TEntity>;
  /** Schema for `nodes[].relationship`; use `z.unknown()` to leave it unchecked. */
  readonly relationship: ZodSchema<TRelationship>;
}

/**
 * Builds a schema for the version 1 snapshot written by `exportStructure` that
 * also checks the consumer's entity data and relationship metadata. Unknown
 * keys are stripped from the parsed value.
 */
export function createStructureSnapshotSchema<TEntity, TRelationship>(
  options: StructureSnapshotSchemaOptions<TEntity, TRelationship>,
): z.ZodType<StructureSnapshotV1<TEntity, TRelationship>> {
  return z.object({
    version: z.literal(1),
    entities: z.array(z.object({ key: id, data: options.entity })),
    nodes: z.array(
      z.object({
        id,
        entityKey: id,
        parentId: id.nullable(),
        childIds: z.array(id),
        relationship: options.relationship,
      }),
    ),
    rootIds: z.array(id),
  });
}

/**
 * Format-only schema of the version 1 snapshot: ids, references and lists are
 * checked; `data` must be present, its content and `relationship` are not checked.
 */
export const structureSnapshotSchema: z.ZodType<StructureSnapshotV1<unknown, unknown>> =
  createStructureSnapshotSchema({
    entity: z.unknown().refine((value) => value !== undefined, "Required."),
    relationship: z.unknown(),
  });

function pointerOf(path: ZodIssuePath): string {
  return path.map((segment) => `/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function stringAt(data: unknown, path: readonly (string | number)[]): string | undefined {
  let current: unknown = data;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return typeof current === "string" && current !== "" ? current : undefined;
}

/**
 * Maps Zod issues found in snapshot data into core-style errors
 * (`SNAPSHOT_INVALID_FORMAT`, category `"structure"`), with `nodeId` /
 * `entityKey` when the issue is inside a node or an entity, and
 * `details.pointer` (JSON Pointer) / `details.path` into the snapshot.
 */
export function snapshotIssuesToErrors(data: unknown, issues: readonly z.core.$ZodIssue[]): ValidationError[] {
  return issues.map((issue) => {
    const path = toPath(issue.path);
    const [section, index] = path;
    let fields: { nodeId?: NodeId; entityKey?: EntityKey } = {};
    if (typeof index === "number") {
      if (section === "nodes") {
        const nodeId = stringAt(data, ["nodes", index, "id"]);
        if (nodeId !== undefined) fields = { nodeId };
      } else if (section === "entities") {
        const entityKey = stringAt(data, ["entities", index, "key"]);
        if (entityKey !== undefined) fields = { entityKey };
      }
    }
    const details: ZodIssueDetails & { readonly pointer: string } = {
      source: "snapshot",
      path,
      zodCode: issue.code,
      pointer: pointerOf(path),
    };
    return {
      code: "SNAPSHOT_INVALID_FORMAT",
      category: "structure",
      message: path.length > 0 ? `${path.join(".")}: ${issue.message}` : issue.message,
      ...fields,
      details: { ...details },
    };
  });
}

/**
 * Validates snapshot data (e.g. `JSON.parse` output) against a snapshot schema
 * before `importStructure`. Without `schema` only the format is checked; pass
 * one from `createStructureSnapshotSchema` to also check the consumer's data.
 * Migrations of older versions must run before this check.
 */
export function parseStructureSnapshot(
  data: unknown,
): Result<StructureSnapshotV1<unknown, unknown>, readonly ValidationError[]>;
export function parseStructureSnapshot<TEntity, TRelationship>(
  data: unknown,
  schema: z.ZodType<StructureSnapshotV1<TEntity, TRelationship>>,
): Result<StructureSnapshotV1<TEntity, TRelationship>, readonly ValidationError[]>;
export function parseStructureSnapshot(
  data: unknown,
  schema: z.ZodType<StructureSnapshotV1<unknown, unknown>> = structureSnapshotSchema,
): Result<StructureSnapshotV1<unknown, unknown>, readonly ValidationError[]> {
  const result = schema.safeParse(data);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, errors: snapshotIssuesToErrors(data, result.error.issues) };
}
