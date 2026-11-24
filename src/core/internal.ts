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

/** Returns a shallow copy of `record` with `changes` applied (`undefined` deletes). */
export function patchRecord<TValue>(
  record: Readonly<Record<string, TValue>>,
  changes: ReadonlyMap<string, TValue | undefined>,
): Record<string, TValue> {
  const next: Record<string, TValue> = {};
  for (const key of Object.keys(record)) {
    if (!changes.has(key)) {
      Object.defineProperty(next, key, {
        value: record[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  for (const [key, value] of changes) {
    if (value !== undefined) {
      Object.defineProperty(next, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return next;
}

export function insertAt<T>(list: readonly T[], index: number, value: T): T[] {
  const next = list.slice();
  next.splice(index, 0, value);
  return next;
}

export function without<T>(list: readonly T[], value: T): T[] {
  return list.filter((item) => item !== value);
}
