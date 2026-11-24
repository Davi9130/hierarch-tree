/**
 * Internal helpers for string-keyed records. Every lookup uses own-property
 * checks so keys such as "constructor" or "__proto__" behave like any other key.
 */

const hasOwnProperty = Object.prototype.hasOwnProperty;

export function hasOwn(record: object, key: string): boolean {
  return hasOwnProperty.call(record, key);
}

export function getOwn<TValue>(
  record: Readonly<Record<string, TValue>>,
  key: string,
): TValue | undefined {
  return hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Returns a shallow copy of `record` with `changes` applied (`undefined`
 * deletes). Existing keys keep their position; new keys are appended.
 */
export function patchRecord<TValue>(
  record: Readonly<Record<string, TValue>>,
  changes: ReadonlyMap<string, TValue | undefined>,
): Record<string, TValue> {
  const next: Record<string, TValue> = {};
  const keys = Object.keys(record);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key === undefined) continue;
    const value = changes.has(key) ? changes.get(key) : record[key];
    if (value !== undefined) setOwn(next, key, value);
  }
  for (const [key, value] of changes) {
    if (value !== undefined && !hasOwnProperty.call(record, key)) setOwn(next, key, value);
  }
  return next;
}

/** Assigns an own data property, without triggering the `__proto__` setter. */
function setOwn<TValue>(target: Record<string, TValue>, key: string, value: TValue): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

export function insertAt<T>(list: readonly T[], index: number, value: T): T[] {
  const next = list.slice();
  next.splice(index, 0, value);
  return next;
}

export function without<T>(list: readonly T[], value: T): T[] {
  return list.filter((item) => item !== value);
}

/**
 * Takes ownership of a consumer value before it enters the state (F1): plain
 * objects and arrays are shallow-copied and frozen, so mutating the object the
 * consumer passed in never changes the state; other objects (class instances)
 * are frozen in place, because copying cannot preserve private fields or
 * internal slots. Primitives and already-frozen values are returned as-is, so
 * values that are already in the state keep their reference.
 */
export function ownValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.slice()) as T;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return Object.freeze(value);
  const copy = Object.create(prototype as object | null) as T;
  Object.defineProperties(copy, Object.getOwnPropertyDescriptors(value));
  return Object.freeze(copy);
}

/**
 * Same reference, or same prototype and the same own enumerable properties
 * compared with `Object.is` (one level deep).
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!hasOwnProperty.call(b, key)) return false;
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}
