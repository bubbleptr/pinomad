// Light, dark, or the system's choice: a per-device preference, so it lives in
// this browser's storage rather than in host settings. public/theme-boot.js
// reads the same key before the app loads so the first paint already matches.
import { useEffect, useSyncExternalStore } from "react";

export type Appearance = "light" | "dark" | "system";

/** localStorage key holding the chosen appearance. */
export const APPEARANCE_KEY = "pinomad.appearance";

const listeners = new Set<() => void>();

const parse = (raw: string | null): Appearance => (raw === "light" || raw === "dark" ? raw : "system");

/** The stored choice; storage that is unreadable or holds something else means the system's. */
export function readAppearance(): Appearance {
  try {
    return parse(localStorage.getItem(APPEARANCE_KEY));
  } catch {
    return "system";
  }
}

export function setAppearance(next: Appearance): void {
  if (next === "system") localStorage.removeItem(APPEARANCE_KEY);
  else localStorage.setItem(APPEARANCE_KEY, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === APPEARANCE_KEY || event.key === null) listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, readAppearance, () => "system");
}

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

function subscribeSystemDark(listener: () => void): () => void {
  const query = window.matchMedia(SYSTEM_DARK);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/**
 * Keeps `<html class="dark">` in step with the appearance, "system" resolved
 * against the OS. Tailwind's `dark:` variant keys off this class; the tokens
 * themselves follow color-scheme and don't need it.
 */
export function useDarkClass(): void {
  const appearance = useAppearance();
  const systemDark = useSyncExternalStore(
    subscribeSystemDark,
    () => window.matchMedia(SYSTEM_DARK).matches,
    () => false,
  );
  const dark = appearance === "dark" || (appearance === "system" && systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
}
