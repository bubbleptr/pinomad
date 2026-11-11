import { useEffect } from "react";
import { SiteHeader } from "@/components/site-header.tsx";
import { localized, type Lang } from "@/lib/i18n.ts";
import { otherLanguage } from "@/lib/nav.ts";
import { copy } from "./copy.tsx";
import { Closing, GetStarted, type LatestRelease } from "./get-started.tsx";
import { Agents, Anywhere, Connection, Core, Hero, Next } from "./sections.tsx";
import { SiteFooter } from "./site-footer.tsx";

export function Landing({ lang, latest }: { lang: Lang; latest?: LatestRelease }) {
  const t = copy[lang];
  useIntroOnce();
  return (
    <div className="landing">
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
        {/* Mist, then one stretch of blue for reaching the host from anywhere, then mist
            again. Each zone sets the colour tokens for what's in it. */}
        <div className="zone zone-light">
          <Hero lang={lang} t={t.hero} />
          <Core lang={lang} t={t.core} durable={t.durable} />
        </div>
        <div className="zone zone-abyss">
          <Anywhere lang={lang} t={t.anywhere} />
          <Connection t={t.connection} />
        </div>
        <div className="zone zone-light">
          <Agents lang={lang} t={t.agents} />
          <GetStarted t={t.start} />
          <Next t={t.next} />
          <Closing lang={lang} t={t.start} latest={latest} />
        </div>
      </main>
      <SiteFooter lang={lang} t={t.footer} />
    </div>
  );
}

/**
 * The first screen's entrance (page.css) plays on every full load. Once it has
 * finished (or isn't running: reduced motion, or it ended before hydration) the page
 * is marked seen, so a client-side return from the docs or blog doesn't play it again.
 */
function useIntroOnce() {
  useEffect(() => {
    let live = true;
    const entering = document
      .getAnimations()
      .filter((animation) => animation instanceof CSSAnimation && animation.animationName.startsWith("intro-"));
    void Promise.allSettled(entering.map((animation) => animation.finished)).then(() => {
      if (live) document.documentElement.setAttribute("data-intro-seen", "");
    });
    return () => {
      live = false;
    };
  }, []);
}
