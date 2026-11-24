/**
 * Optional Zustand adapter (`hierarch-tree/zustand`). Requires `zustand` (>= 5)
 * as a peer dependency; the core (`hierarch-tree`) never imports it.
 */
export {
  createEntityStructureStore,
  type CreateEntityStructureStoreOptions,
  type EntityStructureActions,
  type EntityStructureStore,
  type EntityStructureStoreState,
} from "./store.js";
export {
  selectActions,
  selectAllByIdentity,
  selectChildren,
  selectEntity,
  selectNode,
  selectRootIds,
  selectStructure,
  type StoreSelector,
} from "./selectors.js";
