import { type RefObject, useEffect, useState } from "react";

/**
 * Seconds a mock has been on screen: paused while it's scrolled away, and 0 for
 * good under reduced motion, which is also the prerendered value.
 */
export function useClock(ref: RefObject<HTMLElement | null>) {
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      clearInterval(timer);
      if (entry?.isIntersecting) timer = setInterval(() => setClock((seconds) => seconds + 1), 1000);
    });
    observer.observe(ref.current!);
    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, [ref]);
  return clock;
}
