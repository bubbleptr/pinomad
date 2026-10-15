import { describe, expect, test } from "vitest";
import { fitWithin, MAX_IMAGE_SIDE } from "./fit.ts";

describe("fitWithin", () => {
  test("never upscales a small image", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  test("caps the long side at the max", () => {
    const fitted = fitWithin(4000, 2000);
    expect(fitted.width).toBe(MAX_IMAGE_SIDE);
    expect(fitted.height).toBe(Math.round(MAX_IMAGE_SIDE / 2));
  });

  test("caps a portrait image on its height", () => {
    const fitted = fitWithin(1000, 4000);
    expect(fitted.height).toBe(MAX_IMAGE_SIDE);
    expect(fitted.width).toBe(Math.round(MAX_IMAGE_SIDE / 4));
  });

  test("keeps a square image square", () => {
    const fitted = fitWithin(3000, 3000);
    expect(fitted).toEqual({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE });
  });

  test("returns at least 1px per side", () => {
    const fitted = fitWithin(10000, 1);
    expect(fitted.height).toBe(1);
    expect(fitted.width).toBe(MAX_IMAGE_SIDE);
  });
});
