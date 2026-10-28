import { type RefObject, useEffect, useRef } from "react";
import type { Lang } from "@/lib/i18n.ts";
import { copy } from "./copy.tsx";
import { Closing, GetStarted, type LatestRelease } from "./get-started.tsx";
import { Agents, Anywhere, Connection, Core, Hero, Next, Subscriptions } from "./sections.tsx";
import { SiteFooter } from "./site-footer.tsx";
import { SiteHeader } from "./site-header.tsx";

export function Landing({ lang, latest }: { lang: Lang; latest?: LatestRelease }) {
  const t = copy[lang];
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  return (
    <div className="landing" ref={root}>
      <a className="skip-link" href="#main">
        {t.skip}
      </a>
      <SiteHeader lang={lang} t={t} />
      <main id="main">
        <Hero lang={lang} t={t.hero} />
        <Core lang={lang} t={t.core} durable={t.durable} />
        <Anywhere lang={lang} t={t.anywhere} />
        <Subscriptions t={t.subs} />
        <Connection t={t.connection} />
        <Agents lang={lang} t={t.agents} />
        <GetStarted t={t.start} />
        <Next t={t.next} />
        <Closing lang={lang} t={t.start} latest={latest} />
      </main>
      <SiteFooter lang={lang} t={t.footer} />
    </div>
  );
}

const revealed = ".section-head, .cell, .split > .diagram, .split > .phone, .stack, .plan, .subs, .client, .code-card, .start-end";

/**
 * Blocks that start below the first screen fade up once as they scroll in.
 * Anything on screen at load is left alone, so the first paint never animates.
 */
function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let shown = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).style.transitionDelay = `${Math.min(shown, 3) * 80}ms`;
          entry.target.classList.add("is-revealed");
          observer.unobserve(entry.target);
          shown += 1;
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    for (const block of root.current!.querySelectorAll(revealed)) {
      if (block.getBoundingClientRect().top < innerHeight) continue;
      block.classList.add("reveal");
      observer.observe(block);
    }
    return () => observer.disconnect();
  }, [root]);
}
