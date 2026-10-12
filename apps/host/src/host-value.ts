/** A host-side value pushed whole to every subscriber on change. */
export interface HostValue<T> {
  readonly value: T;
  subscribe(listener: (value: T) => void): () => void;
}

/** A `HostValue` that never changes — the source for a stream with no live provider. */
export function constantValue<T>(value: T): HostValue<T> {
  return {
    value,
    subscribe: () => () => {},
  };
}
