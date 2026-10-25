import { type RefObject, useEffect, useRef } from "react";
import type { Lang } from "@/lib/i18n.ts";
import { copy } from "./copy.tsx";
import { Durable } from "./durable.tsx";
import landingCss from "./landing.css?url";
import { landingHead } from "./meta.ts";
import { QuickStart } from "./quick-start.tsx";
import { Anywhere, Clients, Closing, Features, Hero } from "./sections.tsx";
import { SiteFooter } from "./site-footer.tsx";
import { SiteHeader } from "./site-header.tsx";

export function landingRouteHead(lang: Lang) {
  const head = landingHead(lang);
  return { ...head, links: [...head.links, { rel: "stylesheet", href: landingCss }] };
}

export function Landing({ lang }: { lang: Lang }) {
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
        <Anywhere t={t.anywhere} />
        <Durable t={t.durable} />
        <Features lang={lang} t={t.features} />
        <Clients t={t.clients} />
        <QuickStart t={t.quickStart} />
        <Closing t={t.closing} />
      </main>
      <SiteFooter lang={lang} t={t.footer} />
    </div>
  );
}

const revealed = ".section-head, .shot-phone, .panel, .feature-row > *, .more, .client, .code-card, .closing .wrap";

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
