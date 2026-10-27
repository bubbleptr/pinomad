import { useSyncExternalStore } from "react";

const canUseDOM = typeof window !== "undefined" && typeof document !== "undefined";

function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function untilTomorrow(now: number): number {
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  return Math.max(1, tomorrow.getTime() - now);
}

const listeners = new Set<() => void>();
let today = startOfToday(Date.now());
let timer: number | undefined;

function refresh(): void {
  const next = startOfToday(Date.now());
  if (next !== today) {
    today = next;
    for (const listener of listeners) listener();
  }
  schedule();
}

function schedule(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (!canUseDOM || listeners.size === 0) return;
  timer = window.setTimeout(refresh, untilTomorrow(Date.now()));
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") refresh();
}

function subscribe(listener: () => void): () => void {
  if (!canUseDOM) return () => {};
  listeners.add(listener);
  if (listeners.size === 1) {
    // The store may have been created before a test or a sleep crossed
    // midnight; the first subscriber always re-reads the calendar day.
    today = startOfToday(Date.now());
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

function getSnapshot(): number {
  return today;
}

function getServerSnapshot(): number {
  return today;
}

/**
 * The local start of today, shared by the whole transcript. One timer wakes
 * at local midnight, and a visible tab rechecks the day after a suspend.
 * Components re-render only when the day actually changes.
 */
export function useToday(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
