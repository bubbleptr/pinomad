import { describe, expect, it } from "vitest";
import { WHEEL_OPTIONS, wheelHit } from "./wheel-hit.ts";

// Screen coords, y down, origin at the send button's center.
const pointAt = (degrees: number, radius: number): [number, number] => {
  const radians = (degrees * Math.PI) / 180;
  return [radius * Math.cos(radians), -radius * Math.sin(radians)];
};

describe("wheelHit", () => {
  it("hits each segment at its mid-angle, mid-radius point", () => {
    const mid = 136 / 2 + 46 / 2;
    WHEEL_OPTIONS.forEach((_option, index) => {
      const span = 90 / WHEEL_OPTIONS.length;
      const degrees = 90 + span * index + span / 2;
      const [dx, dy] = pointAt(degrees, mid);
      expect(wheelHit(dx, dy)).toBe(index);
    });
  });

  it("cancels at the send button itself", () => {
    expect(wheelHit(0, 0)).toBe(-1);
  });

  it("cancels inside the center even at a valid angle", () => {
    const [dx, dy] = pointAt(112, 30);
    expect(wheelHit(dx, dy)).toBe(-1);
  });

  it("splits the boundary between two segments", () => {
    const [ax, ay] = pointAt(134, 90);
    const [bx, by] = pointAt(136, 90);
    expect(wheelHit(ax, ay)).toBe(0);
    expect(wheelHit(bx, by)).toBe(1);
  });

  it("keeps a selection when the finger overshoots outward", () => {
    const [dx, dy] = pointAt(112, 136 + 40);
    expect(wheelHit(dx, dy)).toBe(0);
  });

  it("misses outside the fan's angular span", () => {
    expect(wheelHit(90, 0)).toBe(-1); // straight right
    expect(wheelHit(0, 90)).toBe(-1); // straight down
  });
});
