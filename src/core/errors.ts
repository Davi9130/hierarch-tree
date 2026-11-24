import type { ValidationError } from "./types.js";

export type ErrorCategory = "structure" | "identity" | "relationship" | "domain";

/** Catalog of every error code produced by the core, with its category. */
export const CORE_ERROR_CODES = {
  // structure
  NODE_NOT_FOUND: "structure",
  PARENT_NOT_FOUND: "structure",
  CYCLE_DETECTED: "structure",
  NODE_ID_COLLISION: "structure",
  INVALID_NODE_ID: "structure",
  INVALID_INDEX: "structure",
  MAX_DEPTH_EXCEEDED: "structure",
  IDENTITY_CYCLE: "structure",
  DANGLING_REFERENCE: "structure",
  INCONSISTENT_LINK: "structure",
  // structure — snapshots (importStructure)
  SNAPSHOT_INVALID_FORMAT: "structure",
  SNAPSHOT_UNSUPPORTED_VERSION: "structure",
  SNAPSHOT_MIGRATION_FAILED: "structure",
  // identity
  IDENTITY_MISSING: "identity",
  IDENTITY_INVALID: "identity",
  IDENTITY_EMPTY: "identity",
  IDENTITY_COLLISION: "identity",
  IDENTITY_MISMATCH: "identity",
  IDENTITY_CHANGE_REQUIRES_REKEY: "identity",
  ENTITY_NOT_FOUND: "identity",
  ENTITY_IN_USE: "identity",
  // relationship
  RELATIONSHIP_DENIED: "relationship",
  RELATIONSHIP_NOT_ALLOWED: "relationship",
  RELATIONSHIP_INVALID: "relationship",
  SIBLING_DUPLICATE: "relationship",
  // domain (consumer validators without an explicit code)
  VALIDATION_FAILED: "domain",
} as const satisfies Record<string, ErrorCategory>;

export type CoreErrorCode = keyof typeof CORE_ERROR_CODES;

/** Core codes plus any code returned by consumer validators. */
export type ErrorCode = CoreErrorCode | (string & {});

export function isCoreErrorCode(code: string): code is CoreErrorCode {
  return Object.prototype.hasOwnProperty.call(CORE_ERROR_CODES, code);
}

type ErrorFields = Omit<ValidationError, "code" | "category" | "message">;

/** Builds a structured core error. */
export function coreError(
  code: CoreErrorCode,
  message: string,
  fields: ErrorFields = {},
): ValidationError {
  return { code, category: CORE_ERROR_CODES[code], message, ...fields };
}

/** Thrown for programmer errors in the configuration (never for data errors). */
export class EntityStructureConfigError extends Error {
  override readonly name = "EntityStructureConfigError";
}
