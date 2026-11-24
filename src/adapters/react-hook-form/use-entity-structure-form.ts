import { useMemo, useRef, useState } from "react";
import {
  useForm,
  type FieldValues,
  type UseFormProps,
  type UseFormReset,
  type UseFormReturn,
} from "react-hook-form";
import {
  addNode,
  createEmptyState,
  findAllByIdentity,
  findByIdentity,
  importStructure,
  InvalidStateError,
  moveNode,
  registerEntity,
  rekeyEntity,
  removeEntity,
  removeNode,
  toTree,
  updateEntity,
  updateRelationship,
  validateStructure,
  type AddNodeInput,
  type EntityKey,
  type EntityRecord,
  type EntityStructureConfig,
  type ImportStructureOptions,
  type ImportStructureResult,
  type MoveNodeInput,
  type NodeId,
  type OperationResult,
  type RekeyEntityInput,
  type RemoveEntityInput,
  type RemoveNodeInput,
  type StructureNode,
  type StructureSnapshotV1,
  type StructureState,
  type TreeNode,
  type UpdateEntityInput,
  type UpdateRelationshipInput,
  type ValidationResult,
} from "../../index.js";
import { resolveConfig } from "../../core/config.js";
import { addedSegments, diffStructure } from "./commit.js";
import { checkPathSegments } from "./paths.js";

/** The form value: the core state, unchanged. There is no second copy anywhere. */
export type StructureFormValues<TEntity, TRelationship> = StructureState<TEntity, TRelationship>;

export interface UseEntityStructureFormOptions<TEntity, TRelationship>
  extends Omit<
    UseFormProps<StructureFormValues<TEntity, TRelationship>, unknown, StructureFormValues<TEntity, TRelationship>>,
    "defaultValues" | "values"
  > {
  readonly config: EntityStructureConfig<TEntity, TRelationship>;
  /**
   * A core `StructureState` (checked with `validateStructure`) or a snapshot
   * from `exportStructure` (loaded with `importStructure`). Read once, on the
   * first render; invalid data throws `InvalidStateError`. Empty when omitted.
   */
  readonly defaultValues?: StructureState<TEntity, TRelationship> | StructureSnapshotV1<TEntity, TRelationship>;
  readonly importOptions?: ImportStructureOptions;
}

export interface EntityStructureFormOperations<TEntity, TRelationship> {
  readonly config: EntityStructureConfig<TEntity, TRelationship>;
  /** Current form values as a core state (what every operation reads). */
  getState(): StructureState<TEntity, TRelationship>;

  registerEntity(entity: TEntity): OperationResult<TEntity, TRelationship, { key: EntityKey }>;
  updateEntity(input: UpdateEntityInput<TEntity>): OperationResult<TEntity, TRelationship>;
  rekeyEntity(input: RekeyEntityInput<TEntity>): OperationResult<TEntity, TRelationship, { key: EntityKey }>;
  removeEntity(input: EntityKey | RemoveEntityInput): OperationResult<TEntity, TRelationship>;
  addNode(
    input: AddNodeInput<TEntity, TRelationship>,
  ): OperationResult<TEntity, TRelationship, { nodeId: NodeId; entityKey: EntityKey }>;
  removeNode(input: NodeId | RemoveNodeInput): OperationResult<TEntity, TRelationship>;
  moveNode(input: MoveNodeInput): OperationResult<TEntity, TRelationship>;
  updateRelationship(input: UpdateRelationshipInput<TRelationship>): OperationResult<TEntity, TRelationship>;

  /** Full pipeline over the current values, including what the user typed. */
  validateStructure(options?: { readonly context?: unknown }): ValidationResult;
  getNode(nodeId: NodeId): StructureNode<TRelationship> | undefined;
  findByIdentity(value: unknown): EntityRecord<TEntity> | undefined;
  findAllByIdentity(value: unknown): StructureNode<TRelationship>[];
  toTree(rootId?: NodeId): TreeNode<TEntity, TRelationship>[];
  /** Loads a snapshot with `importStructure` and resets the form; on failure nothing changes. */
  importSnapshot(data: unknown, options?: ImportStructureOptions): ImportStructureResult<TEntity, TRelationship>;
}

/**
 * Everything `useForm` returns, plus the structure operations. `reset` keeps
 * the React Hook Form signature but validates the new values first and throws
 * `InvalidStateError` when they are not a valid structure.
 */
export type EntityStructureForm<TEntity, TRelationship> = UseFormReturn<
  StructureFormValues<TEntity, TRelationship>,
  unknown,
  StructureFormValues<TEntity, TRelationship>
> &
  EntityStructureFormOperations<TEntity, TRelationship>;

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

function isSnapshot(data: object): boolean {
  return "version" in data;
}

function readState<TEntity, TRelationship>(values: FieldValues): StructureState<TEntity, TRelationship> {
  // React Hook Form drops `nodes` / `entities` once their last key is unregistered.
  return {
    entities: isObject(values["entities"]) ? values["entities"] : {},
    nodes: isObject(values["nodes"]) ? values["nodes"] : {},
    rootIds: Array.isArray(values["rootIds"]) ? values["rootIds"] : [],
  } as StructureState<TEntity, TRelationship>;
}

function checkedState<TEntity, TRelationship>(
  data: StructureState<TEntity, TRelationship> | StructureSnapshotV1<TEntity, TRelationship>,
  config: EntityStructureConfig<TEntity, TRelationship>,
  importOptions: ImportStructureOptions | undefined,
): StructureState<TEntity, TRelationship> {
  let state: StructureState<TEntity, TRelationship>;
  if (isSnapshot(data)) {
    const imported = importStructure(data, config, importOptions);
    if (!imported.ok) throw new InvalidStateError(imported.errors);
    state = imported.value.state;
  } else {
    state = data as StructureState<TEntity, TRelationship>;
    const validation = validateStructure(state, config);
    if (!validation.valid) throw new InvalidStateError(validation.errors);
  }
  const unsafe = checkPathSegments(state);
  if (unsafe.length > 0) throw new InvalidStateError(unsafe);
  return state;
}

/**
 * React Hook Form over the pure core. The form value **is** the normalized
 * core state (`entities`, `nodes`, `rootIds`): entity data lives once at
 * `entities.<key>.data` (shared by every occurrence) and each occurrence's
 * relationship at `nodes.<nodeId>.relationship`. Structural operations read the
 * current values, run the pure core operation and write back only the paths it
 * changed (`setValue` / `unregister`), so there is nothing to synchronize.
 */
export function useEntityStructureForm<TEntity, TRelationship = unknown>(
  options: UseEntityStructureFormOptions<TEntity, TRelationship>,
): EntityStructureForm<TEntity, TRelationship> {
  const { config, defaultValues, importOptions, ...formProps } = options;
  const configRef = useRef(config);
  configRef.current = config;

  const [initial] = useState(() => {
    resolveConfig(config); // fail fast on an invalid configuration
    return defaultValues === undefined
      ? createEmptyState<TEntity, TRelationship>()
      : checkedState(defaultValues, config, importOptions);
  });

  const form = useForm<StructureFormValues<TEntity, TRelationship>, unknown, StructureFormValues<TEntity, TRelationship>>(
    { ...formProps, defaultValues: initial },
  );

  const operations = useMemo(() => {
    // Generic paths (`nodes.${string}`) cannot be checked against
    // `Path<StructureState<TEntity, TRelationship>>` while the types are still
    // parameters, so the adapter talks to the form through this untyped view.
    const raw = form as unknown as UseFormReturn<FieldValues>;
    const getConfig = () => configRef.current;
    const getState = () => readState<TEntity, TRelationship>(raw.getValues());

    function commit<TExtra extends object>(
      previous: StructureState<TEntity, TRelationship>,
      result: OperationResult<TEntity, TRelationship, TExtra>,
    ): OperationResult<TEntity, TRelationship, TExtra> {
      if (!result.ok || result.value.state === previous) return result;
      const next = result.value.state;
      const unsafe = checkPathSegments(next, addedSegments(previous, next));
      if (unsafe.length > 0) return { ok: false, errors: unsafe };
      const values = raw.getValues();
      const writes = diffStructure(previous, next, {
        nodes: isObject(values["nodes"]),
        entities: isObject(values["entities"]),
      });
      for (const write of writes) {
        if (write.type === "set") raw.setValue(write.name, write.value, { shouldDirty: true });
        else raw.unregister(write.name, { keepDefaultValue: true });
      }
      return result;
    }

    const run = <TExtra extends object>(
      operation: (state: StructureState<TEntity, TRelationship>) => OperationResult<TEntity, TRelationship, TExtra>,
    ): OperationResult<TEntity, TRelationship, TExtra> => {
      const previous = getState();
      return commit(previous, operation(previous));
    };

    const reset: UseFormReset<StructureFormValues<TEntity, TRelationship>> = (values, keepStateOptions) => {
      if (values === undefined) {
        form.reset(undefined, keepStateOptions);
        return;
      }
      const resolved = typeof values === "function" ? values(form.getValues()) : values;
      const state = checkedState(resolved as StructureState<TEntity, TRelationship>, getConfig(), undefined);
      form.reset(state, keepStateOptions);
    };

    const operationsObject: EntityStructureFormOperations<TEntity, TRelationship> & {
      reset: UseFormReset<StructureFormValues<TEntity, TRelationship>>;
    } = {
      config: configRef.current,
      getState,
      registerEntity: (entity) => run((state) => registerEntity(state, entity, getConfig())),
      updateEntity: (input) => run((state) => updateEntity(state, input, getConfig())),
      rekeyEntity: (input) => run((state) => rekeyEntity(state, input, getConfig())),
      removeEntity: (input) =>
        run((state) => removeEntity(state, typeof input === "string" ? { key: input } : input, getConfig())),
      addNode: (input) => run((state) => addNode(state, input, getConfig())),
      removeNode: (input) =>
        run((state) => removeNode(state, typeof input === "string" ? { nodeId: input } : input, getConfig())),
      moveNode: (input) => run((state) => moveNode(state, input, getConfig())),
      updateRelationship: (input) => run((state) => updateRelationship(state, input, getConfig())),

      validateStructure: (validationOptions) => validateStructure(getState(), getConfig(), validationOptions),
      getNode: (nodeId) => {
        const { nodes } = getState();
        return Object.prototype.hasOwnProperty.call(nodes, nodeId) ? nodes[nodeId] : undefined;
      },
      findByIdentity: (value) => findByIdentity(getState(), value, getConfig()),
      findAllByIdentity: (value) => findAllByIdentity(getState(), value, getConfig()),
      toTree: (rootId) => toTree(getState(), rootId),
      importSnapshot(data, snapshotOptions) {
        const imported = importStructure(data, getConfig(), snapshotOptions);
        if (!imported.ok) return imported;
        const unsafe = checkPathSegments(imported.value.state);
        if (unsafe.length > 0) return { ok: false, errors: unsafe };
        form.reset(imported.value.state);
        return imported;
      },
      reset,
    };
    return operationsObject;
  }, [form]);

  // `form` is the stable object from `useForm`; its `formState` is a proxy, so
  // the spread must happen on every render to pass the current one along.
  return Object.assign({}, form, operations, { config }) as EntityStructureForm<TEntity, TRelationship>;
}
