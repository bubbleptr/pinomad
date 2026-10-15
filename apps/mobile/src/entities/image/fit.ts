// Send-ready size math, kept in a dependency-free module so vitest (node,
// no native modules) can cover it. Mirrors the web client's 1568px cap.
export const MAX_IMAGE_SIDE = 1568;

/** Scale `width`×`height` so the long side is ≤ maxSide; never upscales. */
export function fitWithin(
  width: number,
  height: number,
  maxSide = MAX_IMAGE_SIDE,
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
