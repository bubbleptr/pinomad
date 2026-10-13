/**
 * The project the picker just registered, handed to /new in memory: the picker
 * pops back to an already-mounted /new whose home state wouldn't re-read route
 * params, so the handoff is consumed by a focus effect instead.
 */
let pending: string | undefined;

export function setAddedProject(path: string): void {
  pending = path;
}

/** Returns the just-added project path exactly once; later calls see undefined. */
export function takeAddedProject(): string | undefined {
  const path = pending;
  pending = undefined;
  return path;
}
