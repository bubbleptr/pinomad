// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/hooks/useMediaQuery.ts (MIT).

import { useCallback, useSyncExternalStore } from "react";

/** Whether a CSS media query matches, re-rendering when it flips. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const matches = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, matches);
}
