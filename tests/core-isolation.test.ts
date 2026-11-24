import { describe, expect, it } from "vitest";

// `import.meta.glob` is resolved by Vite/Vitest at transform time. Typed here to
// avoid pulling in `vite/client` / `@types/node` just for this guard.
declare global {
  interface ImportMeta {
    glob(
      patterns: string[],
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, string>;
  }
}

const coreSources = import.meta.glob(["../src/index.ts", "../src/core/**/*.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const FORBIDDEN = /(?:from|import)\s*\(?\s*["'](?:zustand|react|zod|react-hook-form)(?:\/[^"']*)?["']|["'][^"']*adapters\//;

describe("core isolation", () => {
  it("the core and the main entry never import adapters or their peer dependencies", () => {
    const files = Object.keys(coreSources);
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((file) => FORBIDDEN.test(coreSources[file] ?? ""))).toEqual([]);
  });
});
