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
