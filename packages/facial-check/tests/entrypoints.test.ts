import { describe, expect, it } from "vitest";
import pkgJson from "../package.json";

const pkg: {
  exports: Record<string, unknown>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
} = pkgJson;

describe("public entry points", () => {
  it.each([
    ["facial-check", () => import("../src/index")],
    ["facial-check/core", () => import("../src/core/index")],
    ["facial-check/react", () => import("../src/react/index")],
    ["facial-check/detectors", () => import("../src/detectors/index")],
  ])("%s loads", async (_name, load) => {
    await expect(load()).resolves.toBeTypeOf("object");
  });

  it("exposes only the public subpaths", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./core", "./detectors", "./package.json", "./react"]);
  });

  it("keeps React as a peer dependency only", () => {
    expect(pkg.peerDependencies).toHaveProperty("react");
    expect(pkg.peerDependencies).toHaveProperty("react-dom");
    expect(pkg.dependencies).not.toHaveProperty("react");
    expect(pkg.dependencies).not.toHaveProperty("react-dom");
  });

  it("pins face-api.js to 0.22.2", () => {
    expect(pkg.dependencies["face-api.js"]).toBe("0.22.2");
  });
});
