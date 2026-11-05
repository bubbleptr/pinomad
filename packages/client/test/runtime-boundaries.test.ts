import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runtimeBoundaryViolations } from "../../protocol/test/runtime-boundaries.ts";

it("src runs in browsers and Node without a DOM: no Node builtins, Node-only or DOM-only globals, or React", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  expect(runtimeBoundaryViolations(src, { noDom: true })).toEqual([]);
});
