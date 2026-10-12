// The press-and-hold wheel on the send button: while a run is busy, holding
// send opens option bubbles fanned out up-left; releasing over one submits
// with that mode. Positions are offsets from the send button's center in
// points, y down — Follow-up sits above, Steer up-left.
export type WheelMode = "steer" | "followUp";

export interface WheelOption {
  readonly mode: WheelMode;
  readonly label: string;
  readonly dx: number;
  readonly dy: number;
}

export const WHEEL_OPTIONS: readonly WheelOption[] = [
  { mode: "followUp", label: "Follow-up", dx: -8, dy: -84 },
  { mode: "steer", label: "Steer", dx: -70, dy: -50 },
];

// Wider than the 56pt bubble so the drag doesn't demand precision.
const HIT_RADIUS = 36;

/** Index of the option whose center is within the hit radius, else -1. */
export function wheelHit(dx: number, dy: number): number {
  "worklet";
  for (let i = 0; i < WHEEL_OPTIONS.length; i++) {
    const option = WHEEL_OPTIONS[i];
    const ox = dx - option.dx;
    const oy = dy - option.dy;
    if (ox * ox + oy * oy <= HIT_RADIUS * HIT_RADIUS) return i;
  }
  return -1;
}
