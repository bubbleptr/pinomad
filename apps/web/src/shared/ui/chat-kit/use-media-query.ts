// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/hooks/useMediaQuery.ts (MIT).

import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string, serverDefault = false): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    return window.matchMedia(query).matches;
  }, [query]);

  const getServerSnapshot = useCallback(() => serverDefault, [serverDefault]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
