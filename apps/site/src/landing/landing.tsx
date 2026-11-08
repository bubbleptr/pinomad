import { type RefObject, useEffect, useRef } from "react";
import { SiteHeader } from "@/components/site-header.tsx";
import { localized, type Lang } from "@/lib/i18n.ts";
import { otherLanguage } from "@/lib/nav.ts";
import { copy } from "./copy.tsx";
import { Closing, GetStarted, type LatestRelease } from "./get-started.tsx";
import { Agents, Anywhere, Connection, Core, Hero, Next, Subscriptions } from "./sections.tsx";
import { SiteFooter } from "./site-footer.tsx";

export function Landing({ lang, latest }: { lang: Lang; latest?: LatestRelease }) {
  const t = copy[lang];
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  useHeaderTone(root);
  return (
    <div className="landing" ref={root}>
      <a className="skip-link" href="#main">
        {t.skip}
      </a>
      <SiteHeader
        lang={lang}
        pathname={localized(lang, "/")}
        languageHref={otherLanguage[lang].href}
        // A new visitor can't sign up at the app yet, so they get the install steps.
        start={{ text: t.hero.start, href: "#quick-start" }}
      />
      <main id="main">
        {/* The page is one sky, read top to bottom: night, the blue hour, then a horizon
            that opens onto daylight. Each zone sets the colour tokens for what's in it. */}
        <div className="zone zone-night">
          <Hero lang={lang} t={t.hero} />
          <Core lang={lang} t={t.core} durable={t.durable} />
        </div>
        <div className="zone zone-abyss">
          <Anywhere lang={lang} t={t.anywhere} />
          <Subscriptions t={t.subs} />
          <Connection t={t.connection} />
          <Agents lang={lang} t={t.agents} />
        </div>
        <div className="horizon" aria-hidden="true" />
        <div className="zone zone-dawn">
          <GetStarted t={t.start} />
          <Next t={t.next} />
          <Closing lang={lang} t={t.start} latest={latest} />
        </div>
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

/** Which header tone each zone calls for; the horizon turns from blue to mist halfway. */
const tones: [selector: string, tone: string][] = [
  [".zone-abyss", "abyss"],
  [".horizon", "horizon"],
  [".zone-dawn", "dawn"],
  [".site-footer", "dawn"],
];

/**
 * Sets the sticky header's data-tone from the zone behind its middle line, so the bar
 * matches what it floats over. Over the night zone the attribute is removed and the
 * stylesheet's default applies.
 */
function useHeaderTone(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const header = root.current!.querySelector<HTMLElement>(".site-header")!;
    const zones = tones.map(([selector, tone]) => [root.current!.querySelector<HTMLElement>(selector)!, tone] as const);
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = header.offsetHeight / 2;
      let tone: string | undefined;
      for (const [zone, name] of zones) {
        const { top, bottom } = zone.getBoundingClientRect();
        if (top > line || bottom <= line) continue;
        tone = name === "horizon" ? (line - top < (bottom - top) / 2 ? "abyss" : "dawn") : name;
      }
      if (tone) header.dataset.tone = tone;
      else delete header.dataset.tone;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
    };
  }, [root]);
}
