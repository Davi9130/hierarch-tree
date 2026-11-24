import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    zod: "src/adapters/zod/index.ts",
    zustand: "src/adapters/zustand/index.ts",
    "react-hook-form": "src/adapters/react-hook-form/index.ts",
  },
  // `zustand`, `react` and `react-hook-form` are peer dependencies, so tsup keeps them external. Shared core code
  // goes into a common chunk (ESM splitting), so both entries use the same
  // classes (e.g. `instanceof InvalidStateError` works across them).
  format: ["esm"],
  splitting: true,
  // Declarations are emitted by `tsc -p tsconfig.build.json` (TypeScript 7 has no compiler API for dts bundlers).
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
