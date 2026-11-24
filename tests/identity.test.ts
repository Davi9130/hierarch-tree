import { describe, expect, it } from "vitest";
import { EntityStructureConfigError, type EntityStructureConfig } from "../src/index.js";
import { normalizeIdentity, resolveIdentity } from "../src/core/identity.js";

interface Item {
  id?: string | number;
  uuid?: string;
  externalId?: string;
  region?: string;
  code?: string;
}

const byId: EntityStructureConfig<Item, unknown> = { identity: { key: "id" } };
const byUuid: EntityStructureConfig<Item, unknown> = { identity: { key: "uuid" } };

describe("identity resolver", () => {
  it("resolves by `id` property", () => {
    expect(resolveIdentity({ id: "a-1" }, byId)).toEqual({ ok: true, value: "a-1" });
  });

  it("resolves by `uuid` property", () => {
    const uuid = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
    expect(resolveIdentity({ uuid }, byUuid)).toEqual({ ok: true, value: uuid });
  });

  it("stringifies numeric identities", () => {
    expect(resolveIdentity({ id: 42 }, byId)).toEqual({ ok: true, value: "42" });
  });

  it("resolves by function, including composite keys", () => {
    const config: EntityStructureConfig<Item, unknown> = {
      identity: { getKey: (item) => `${item.region ?? ""}:${item.code ?? ""}` },
    };
    expect(resolveIdentity({ region: "eu", code: "7" }, config)).toEqual({
      ok: true,
      value: "eu:7",
    });
  });

  it("applies normalization", () => {
    const config: EntityStructureConfig<Item, unknown> = {
      identity: { key: "externalId", normalize: (value) => value.replace(/\D/g, "") },
    };
    expect(resolveIdentity({ externalId: "12.345-6" }, config)).toEqual({
      ok: true,
      value: "123456",
    });
  });

  it.each([
    [{}, "IDENTITY_MISSING"],
    [{ id: "" }, "IDENTITY_EMPTY"],
    [{ id: "   " }, "IDENTITY_EMPTY"],
  ])("rejects %j with %s", (item, code) => {
    const result = resolveIdentity(item, byId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe(code);
  });

  it("rejects values that are empty after normalization", () => {
    const config: EntityStructureConfig<Item, unknown> = {
      identity: { key: "externalId", normalize: (value) => value.replace(/\D/g, "") },
    };
    const result = resolveIdentity({ externalId: "abc" }, config);
    expect(result.ok ? null : result.errors[0]?.code).toBe("IDENTITY_EMPTY");
  });

  it.each([[{ nested: true }], [Number.NaN], [Number.POSITIVE_INFINITY], [true]])(
    "rejects non-identity value %j",
    (value) => {
      const result = normalizeIdentity(value, byId);
      expect(result.ok ? null : result.errors[0]?.code).toBe("IDENTITY_INVALID");
    },
  );

  it("throws a config error when identity is not configured", () => {
    const broken = { identity: {} } as unknown as EntityStructureConfig<Item, unknown>;
    expect(() => resolveIdentity({ id: "x" }, broken)).toThrow(EntityStructureConfigError);
  });
});
