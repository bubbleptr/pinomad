// The question card's pager: native scroll-snap paging (finger and trackpad
// swipes are the browser's own), with the pager as tall as the page in view.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const JUMP_MS = 280;

export const prefersReducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export type QuestionPager = {
  ref: RefObject<HTMLDivElement | null>;
  /** The page in view — or, during a `go`, the page it is heading to. */
  index: number;
  go: (next: number) => void;
  onScroll: () => void;
};

/**
 * Mid-swipe the height blends the two pages' heights by scroll progress, so
 * the card resizes with the finger. `go` to a neighbour slides (smooth
 * scroll, same blend); a farther jump cuts straight to the page and eases the
 * height, so it never sweeps through the pages in between. A page whose own
 * content changes (Other's field opening) eases too — but nothing animates
 * on first paint, when the web font landing reflows the pages.
 */
export function useQuestionPager(count: number): QuestionPager {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const indexRef = useRef(index);
  indexRef.current = index;
  // A far jump: scroll events during it must not touch the height or index.
  const jumping = useRef(false);
  // While `go` slides to a page the index already names it; rounding the
  // scroll position mid-slide would flip it back and forth (Back blinking).
  const settling = useRef<number | null>(null);
  const settled = useRef(false);
  const idle = useRef<number | undefined>(undefined);

  const pageHeight = useCallback((at: number): number => (ref.current?.children[at] as HTMLElement | undefined)?.offsetHeight ?? 0, []);

  const easeHeightTo = useCallback((el: HTMLDivElement, target: number): void => {
    if (prefersReducedMotion() || Math.abs(el.offsetHeight - target) < 1) {
      el.style.transition = "";
      el.style.height = `${target}px`;
      return;
    }
    el.style.height = `${el.offsetHeight}px`;
    el.style.transition = `height ${JUMP_MS}ms ${EASE}`;
    el.style.height = `${target}px`;
  }, []);

  const fit = useCallback(
    (ease = false): void => {
      const el = ref.current;
      if (el === null || el.clientWidth === 0 || jumping.current) return;
      const position = Math.min(count - 1, Math.max(0, el.scrollLeft / el.clientWidth));
      const from = Math.floor(position);
      const a = pageHeight(from);
      const b = pageHeight(Math.min(from + 1, count - 1));
      const target = a + (b - a) * (position - from);
      if (ease && settled.current && position === from) {
        easeHeightTo(el, target);
        return;
      }
      el.style.transition = "";
      el.style.height = `${target}px`;
    },
    [count, pageHeight, easeHeightTo],
  );

  // Where a scroll comes to rest is the page — even when a swipe cut a slide short.
  const settle = useCallback((): void => {
    const el = ref.current;
    settling.current = null;
    if (el !== null && !jumping.current) setIndex(Math.min(count - 1, Math.max(0, Math.round(el.scrollLeft / Math.max(el.clientWidth, 1)))));
  }, [count]);

  const onScroll = useCallback((): void => {
    const el = ref.current;
    if (el === null || el.clientWidth === 0) return;
    // `scrollend` settles the page; this idle timer covers browsers without it.
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(settle, 150);
    // The pager only pages sideways; overflow-y: hidden still lets focus scroll it down.
    if (el.scrollTop !== 0) el.scrollTop = 0;
    fit();
    const position = el.scrollLeft / el.clientWidth;
    if (settling.current !== null) {
      if (Math.abs(position - settling.current) > 0.01) return;
      settling.current = null;
    }
    if (!jumping.current) setIndex(Math.min(count - 1, Math.max(0, Math.round(position))));
  }, [count, fit, settle]);

  const go = useCallback(
    (next: number): void => {
      const el = ref.current;
      if (el === null) return;
      const clamped = Math.min(count - 1, Math.max(0, next));
      const distance = Math.abs(clamped - indexRef.current);
      if (distance <= 1 || prefersReducedMotion()) {
        if (distance > 0 && !prefersReducedMotion()) settling.current = clamped;
        el.scrollTo({ left: clamped * el.clientWidth, behavior: prefersReducedMotion() ? "instant" : "smooth" });
        setIndex(clamped);
        return;
      }
      const direction = Math.sign(clamped - indexRef.current);
      jumping.current = true;
      el.style.height = `${el.offsetHeight}px`;
      el.scrollTo({ left: clamped * el.clientWidth, behavior: "instant" });
      setIndex(clamped);
      easeHeightTo(el, pageHeight(clamped));
      // The new page arrives with a short nudge from its side — on its content,
      // inside the clipped page, so the nudge never widens the scroll area.
      (el.children[clamped]?.firstElementChild as HTMLElement | null | undefined)?.animate(
        [
          { opacity: 0, transform: `translateX(${direction * 24}px)` },
          { opacity: 1, transform: "none" },
        ],
        { duration: 220, easing: EASE },
      );
      window.setTimeout(() => {
        jumping.current = false;
      }, JUMP_MS);
    },
    [count, pageHeight, easeHeightTo],
  );

  useLayoutEffect(() => fit(), [fit]);

  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() => {
        if (live) settled.current = true;
      }),
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      // Keep the shown page aligned when the column width changes — only then,
      // or it would yank a swipe in progress.
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        el.scrollTo({ left: indexRef.current * width, behavior: "instant" });
        fit();
        return;
      }
      fit(true);
    });
    // Pages only: the pager's own height is what this sets.
    for (const page of el.children) observer.observe(page);
    el.addEventListener("scrollend", settle);
    return () => {
      observer.disconnect();
      el.removeEventListener("scrollend", settle);
      window.clearTimeout(idle.current);
    };
  }, [fit, settle]);

  return { ref, index, go, onScroll };
}
