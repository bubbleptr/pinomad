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

/** A `HostValue` that republishes only when `equal` reports a real change. */
export class Published<T> implements HostValue<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly #equal: (a: T, b: T) => boolean;
  #value: T;

  constructor(value: T, equal: (a: T, b: T) => boolean) {
    this.#value = value;
    this.#equal = equal;
  }

  get value(): T {
    return this.#value;
  }

  subscribe(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  set(next: T): void {
    if (this.#equal(this.#value, next)) return;
    this.#value = next;
    for (const listener of this.#listeners) listener(next);
  }
}

/** Element-wise list equality. */
export const sameList = <T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean =>
  a.length === b.length && a.every((entry, index) => same(entry, b[index]!));
