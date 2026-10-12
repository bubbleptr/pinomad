import { describe, expect, it } from "vitest";
import { WHEEL_OPTIONS, wheelHit } from "./wheel-hit.ts";

describe("wheelHit", () => {
  it("returns the option index at each option's center", () => {
    WHEEL_OPTIONS.forEach((option, index) => {
      expect(wheelHit(option.dx, option.dy)).toBe(index);
    });
  });

  it("returns -1 at the send button itself", () => {
    expect(wheelHit(0, 0)).toBe(-1);
  });

  it("returns -1 between the options when outside both radii", () => {
    // A point on the perpendicular bisector of the two option centers,
    // pushed out along it until it clears both hit radii.
    const [a, b] = [WHEEL_OPTIONS[0], WHEEL_OPTIONS[1]];
    const midX = (a.dx + b.dx) / 2;
    const midY = (a.dy + b.dy) / 2;
    const vx = b.dx - a.dx;
    const vy = b.dy - a.dy;
    const len = Math.hypot(vx, vy);
    const x = midX + (-vy / len) * 10;
    const y = midY + (vx / len) * 10;
    expect(Math.hypot(x - a.dx, y - a.dy)).toBeGreaterThan(36);
    expect(Math.hypot(x - b.dx, y - b.dy)).toBeGreaterThan(36);
    expect(wheelHit(x, y)).toBe(-1);
  });

  it("hits just inside the radius and misses just outside", () => {
    const option = WHEEL_OPTIONS[0];
    expect(wheelHit(option.dx + 35, option.dy)).toBe(0);
    expect(wheelHit(option.dx + 37, option.dy)).toBe(-1);
  });
});
