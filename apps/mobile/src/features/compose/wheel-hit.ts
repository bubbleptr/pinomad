// The press-and-hold fan on the send button: while a run is busy, holding
// send opens a quarter-ring of segments fanned up-left; releasing over one
// submits with that mode, releasing in the center cancels.
//
// Geometry: an annular sector centered on the send button's center, inner
// radius INNER, outer radius OUTER, spanning START..END degrees in math
// convention (0° = right, 90° = straight up; screen dy is y-down so we
// negate it). Segments split the span evenly in WHEEL_OPTIONS order.
export type WheelMode = "steer" | "followUp";

export interface WheelOption {
  readonly mode: WheelMode;
  readonly label: string;
}

export const WHEEL_OPTIONS: readonly WheelOption[] = [
  { mode: "followUp", label: "Follow-up" },
  { mode: "steer", label: "Steer" },
];

export const FAN_START = 90;
export const FAN_END = 180;
export const FAN_INNER = 46;
export const FAN_OUTER = 136;
// The send circle stays the touch point; releasing inside it cancels.
const CANCEL_RADIUS = 40;
// Angular and radial slack so a sloppy drag still resolves to a segment.
const ANGLE_SLACK = 10;
const OUTER_SLACK = 48;

/** Degrees covered by one segment; index 0 sits at the start angle. */
const segmentSpan = (): number => {
  "worklet";
  return (FAN_END - FAN_START) / WHEEL_OPTIONS.length;
};

/** Segment index of a math angle, clamped into the fan's span. */
function segmentIndex(degrees: number): number {
  "worklet";
  const span = segmentSpan();
  const clamped = Math.min(FAN_END - 0.0001, Math.max(FAN_START, degrees));
  return Math.min(WHEEL_OPTIONS.length - 1, Math.floor((clamped - FAN_START) / span));
}

/** Index of the segment under (dx, dy) — origin at the send center, y down. */
export function wheelHit(dx: number, dy: number): number {
  "worklet";
  const radius = Math.hypot(dx, dy);
  if (radius < CANCEL_RADIUS) return -1;
  const degrees = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
  if (degrees < FAN_START - ANGLE_SLACK || degrees > FAN_END + ANGLE_SLACK) return -1;
  if (radius > FAN_OUTER + OUTER_SLACK) return -1;
  return segmentIndex(degrees);
}

// SVG path for one segment. Corners round via a same-color round-join
// stroke; the radii shrink by half that stroke so the silhouette keeps
// the fan's true outer/inner radii.
const STROKE = 10;
const GAP = 2;

function polar(degrees: number, radius: number): [number, number] {
  "worklet";
  const radians = (degrees * Math.PI) / 180;
  return [radius * Math.cos(radians), -radius * Math.sin(radians)];
}

/** SVG `d` for segment `index` in a coordinate system whose origin is the fan center. */
export function segmentPath(index: number): string {
  "worklet";
  const span = segmentSpan();
  const a0 = FAN_START + span * index + GAP / 2;
  const a1 = FAN_START + span * (index + 1) - GAP / 2;
  const inner = FAN_INNER + STROKE / 2;
  const outer = FAN_OUTER - STROKE / 2;
  const [ix0, iy0] = polar(a0, inner);
  const [ox0, oy0] = polar(a0, outer);
  const [ox1, oy1] = polar(a1, outer);
  const [ix1, iy1] = polar(a1, inner);
  const largeArc = a1 - a0 > 180 ? 1 : 0;
  // SVG y is already down, and polar() already negates y — angles match.
  return `M ${ix0} ${iy0} L ${ox0} ${oy0} A ${outer} ${outer} 0 ${largeArc} 0 ${ox1} ${oy1} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${largeArc} 1 ${ix0} ${iy0} Z`;
}

/** Position of a segment's label/icon anchor (mid-angle, mid-radius). */
export function segmentAnchor(index: number): { dx: number; dy: number } {
  "worklet";
  const span = segmentSpan();
  const degrees = FAN_START + span * index + span / 2;
  const radius = (FAN_INNER + FAN_OUTER) / 2;
  const [dx, dy] = polar(degrees, radius);
  return { dx, dy };
}
