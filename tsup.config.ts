import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  // Declarations are emitted by `tsc -p tsconfig.build.json` (TypeScript 7 has no compiler API for dts bundlers).
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
