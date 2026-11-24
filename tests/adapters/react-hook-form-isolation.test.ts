import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob(
      patterns: string[],
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, string>;
  }
}

const sources = import.meta.glob(["../../src/adapters/react-hook-form/**/*.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("react-hook-form adapter sources", () => {
  it("never synchronize the form and the core with useEffect", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(3);
    expect(files.filter((file) => /useEffect|useLayoutEffect/.test(sources[file] ?? ""))).toEqual([]);
  });

  it("only import the core through its public entry", () => {
    const deep = Object.entries(sources).filter(([, source]) =>
      /from\s+["']\.\.\/\.\.\/core\/(?!config\.js)/.test(source),
    );
    expect(deep.map(([file]) => file)).toEqual([]);
  });
});
