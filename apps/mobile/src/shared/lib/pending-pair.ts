/**
 * The pairing offer the user just confirmed on the /pair screen, handed to the
 * index screen in memory: the one-time secret must not sit in route params or
 * navigation history once the user has confirmed.
 */
export type PendingPair = { url: string; hostKey: string; secret: string };

let pending: PendingPair | undefined;

export function setPendingPair(pair: PendingPair): void {
  pending = pair;
}

/** Returns the confirmed pairing exactly once; later calls see undefined. */
export function takePendingPair(): PendingPair | undefined {
  const pair = pending;
  pending = undefined;
  return pair;
}
