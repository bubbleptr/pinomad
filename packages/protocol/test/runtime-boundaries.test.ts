import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runtimeBoundaryViolations } from "./runtime-boundaries.ts";

it("src runs in browsers and Node: no Node builtins or Node-only globals", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  expect(runtimeBoundaryViolations(src, { noDom: false })).toEqual([]);
});
