// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 (src/hooks/useStreamingText.ts), MIT.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Astryx derives these from its motion tokens through useTheme(). Under the
 * neutral theme `--duration-fast-min` is 95ms and `--duration-fast-max`
 * 165ms, so the tick is round(95 / 10) = 10ms and the fade outlives
 * ceil(165 / 10) = 17 ticks, capped at 12 spans.
 */
export const STREAMING_TICK_MS = 10;
export const STREAMING_MAX_FADE_SPANS = 12;

const CHARS_PER_TICK = 10;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onStoreChange: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

function usePrefersReducedMotion(): boolean {
  const getSnapshot = useCallback(() => window.matchMedia(REDUCED_MOTION).matches, []);
  return useSyncExternalStore(subscribeReducedMotion, getSnapshot, () => false);
}

/**
 * Smooths bursty streamed text into a steady character-by-character reveal.
 *
 * Returns a string that grows steadily toward `targetText`. When `isStreaming`
 * is false, returns the full `targetText` immediately. When the user prefers
 * reduced motion, the progressive reveal is skipped entirely and the full
 * `targetText` is returned immediately.
 */
export function useStreamingText(targetText: string, isStreaming: boolean): string {
  const [displayedLen, setDisplayedLen] = useState(0);
  const targetRef = useRef(targetText);
  const displayedLenRef = useRef(0);
  const lastTickRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Keep target ref in sync
  targetRef.current = targetText;

  // Reset when target clears (new message)
  const prevTargetLenRef = useRef(targetText.length);
  if (targetText.length !== prevTargetLenRef.current) {
    prevTargetLenRef.current = targetText.length;
    if (targetText.length === 0 && displayedLen !== 0) {
      displayedLenRef.current = 0;
      setDisplayedLen(0);
    }
  }

  // Snap to full text when streaming ends
  const prevIsStreamingRef = useRef(isStreaming);
  if (isStreaming !== prevIsStreamingRef.current) {
    prevIsStreamingRef.current = isStreaming;
    if (!isStreaming && targetText.length > 0) {
      displayedLenRef.current = targetText.length;
      setDisplayedLen(targetText.length);
    }
  }

  const prefersReducedMotion = usePrefersReducedMotion();

  // Animation loop
  useEffect(() => {
    if (!isStreaming || prefersReducedMotion) {
      return;
    }

    function tick(now: number) {
      const elapsed = now - lastTickRef.current;
      if (elapsed >= STREAMING_TICK_MS) {
        lastTickRef.current = now;
        const target = targetRef.current;
        const currentLen = displayedLenRef.current;

        if (currentLen < target.length) {
          const nextLen = Math.min(currentLen + CHARS_PER_TICK, target.length);

          displayedLenRef.current = nextLen;
          setDisplayedLen(nextLen);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isStreaming, prefersReducedMotion]);

  if (!isStreaming || prefersReducedMotion) {
    return targetText;
  }

  return targetText.slice(0, displayedLen);
}
