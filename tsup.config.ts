import { defineConfig } from "tsup";

export default defineConfig({
  // `zustand` is a peer dependency, so tsup keeps it external. Shared core code
  // goes into a common chunk (ESM splitting), so both entries use the same
  // classes (e.g. `instanceof InvalidStateError` works across them).
  entry: { index: "src/index.ts", zustand: "src/adapters/zustand/index.ts" },
  format: ["esm"],
  splitting: true,
  // Declarations are emitted by `tsc -p tsconfig.build.json` (TypeScript 7 has no compiler API for dts bundlers).
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
