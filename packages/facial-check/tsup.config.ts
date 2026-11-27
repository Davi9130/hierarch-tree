import { defineConfig } from "tsup";

export default defineConfig({
  // One bundle per public entry point (see "exports" in package.json).
  entry: {
    index: "src/index.ts",
    react: "src/react/index.ts",
    core: "src/core/index.ts",
    detectors: "src/detectors/index.ts",
  },
  format: ["esm", "cjs"],
  // Emits index.d.ts (ESM) and index.d.cts (CJS) for every entry.
  dts: true,
  // Shared code goes into common chunks, so classes are not duplicated
  // across entry points (`instanceof` keeps working between them).
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  platform: "browser",
  // dependencies and peerDependencies are external by default; listed here
  // explicitly so React is never bundled into the package.
  external: ["react", "react-dom", "react/jsx-runtime", "face-api.js", "@mediapipe/tasks-vision"],
});
