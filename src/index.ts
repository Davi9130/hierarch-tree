// Types
export * from "./core/types.js";

// Errors
export {
  CORE_ERROR_CODES,
  EntityStructureConfigError,
  isCoreErrorCode,
  type CoreErrorCode,
  type ErrorCategory,
  type ErrorCode,
} from "./core/errors.js";

// State and identity
export { createEmptyState } from "./core/state.js";
export { normalizeIdentity, resolveIdentity, type IdentityResult } from "./core/identity.js";

// Registry
export { findByIdentity, findEntity, getAllEntities, hasEntity, registerEntity } from "./core/registry.js";
export {
  rekeyEntity,
  removeEntity,
  updateEntity,
  type RekeyEntityInput,
  type RemoveEntityInput,
  type UpdateEntityInput,
} from "./core/entity-operations.js";

// Structure
export {
  addNode,
  moveNode,
  removeNode,
  updateRelationship,
  type AddNodeInput,
  type MoveNodeInput,
  type RemoveNodeInput,
  type UpdateRelationshipInput,
} from "./core/structure.js";

// Rules and validation
export {
  canRelate,
  getAllowedChildren,
  getAllowedParents,
  validateRelationship,
  type CompatibilityOptions,
} from "./core/rules.js";
export { validateStructure } from "./core/validation.js";

// Search
export {
  findAllByIdentity,
  findByNodeId,
  findByPath,
  getAncestors,
  getChildren,
  getDepth,
  getDescendants,
  getOccurrences,
  getParent,
  getPath,
  getRoot,
  searchEntities,
  toTree,
} from "./core/search.js";

// Stateful wrapper
export {
  createEntityStructure,
  InvalidStateError,
  type CreateEntityStructureOptions,
  type EntityStructure,
  type StructureListener,
} from "./core/entity-structure.js";
