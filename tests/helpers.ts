import { expect } from "vitest";
import type { OperationResult, StructureState, ValidationError } from "../src/index.js";

/** Deterministic id generator: n1, n2, n3... */
export function sequentialIds(prefix = "n"): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}${counter}`;
  };
}

type Success<R> = R extends { ok: true; value: infer V } ? V : never;

/** Unwraps a successful result or fails the test with the errors. */
export function unwrap<R extends OperationResult<unknown, unknown, object>>(result: R): Success<R> {
  if (!result.ok) {
    throw new Error(`Expected success, got: ${JSON.stringify(result.errors, null, 2)}`);
  }
  return result.value as Success<R>;
}

/** Asserts failure, that the state is untouched, and returns the error codes. */
export function expectFailure(
  result: OperationResult<unknown, unknown, object>,
  previous?: StructureState<unknown, unknown>,
  current?: StructureState<unknown, unknown>,
): readonly ValidationError[] {
  expect(result.ok).toBe(false);
  if (previous !== undefined && current !== undefined) expect(current).toBe(previous);
  return result.ok ? [] : result.errors;
}

export function codes(errors: readonly ValidationError[]): string[] {
  return errors.map((error) => error.code);
}
