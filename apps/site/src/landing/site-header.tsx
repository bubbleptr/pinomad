import { useEffect, useState } from "react";
import { localized, type Lang } from "@/lib/i18n.ts";
import { githubUrl, otherLanguage, siteNav } from "@/lib/nav.ts";
import favicon from "../../../web/public/favicon.svg?url";
import type { LandingCopy } from "./copy.tsx";
import { StarIcon } from "./icons.tsx";

/** Sticks once the page has hydrated and floats a frosted pill once the page moves. */
export function SiteHeader({ lang, t }: { lang: Lang; t: LandingCopy }) {
  const nav = siteNav(lang);
  const other = otherLanguage[lang];
  const [sticky, setSticky] = useState(false);
  const [floating, setFloating] = useState(false);

  useEffect(() => {
    let frame = 0;
    function update() {
      frame = 0;
      // Float past 24px, settle only under 8px, so a nudge or rubber-band near
      // the top can't flip it back and forth.
      if (scrollY > 24) setFloating(true);
      else if (scrollY < 8) setFloating(false);
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    // Both land in one render, so a reload mid-page shows the pill already in
    // place instead of animating it in.
    update();
    setSticky(true);
    addEventListener("scroll", schedule, { passive: true });
    return () => {
      removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header className={floating ? "site-header is-floating" : "site-header"} data-sticky={sticky ? "" : undefined}>
      <div className="header-bar">
        <a className="brand" href={localized(lang, "/")} aria-label={t.home}>
          <img src={favicon} alt="" width="22" height="22" />
          <span>PiNomad</span>
        </a>
        <nav className="header-nav" aria-label={t.primaryNav}>
          {nav.links.map((link) => (
            <a key={link.url} className="nav-optional" href={link.url}>
              {link.text}
            </a>
          ))}
          <a className="nav-app" href={nav.app.url}>
            <span className="when-signed-out">{nav.app.signedOut}</span>
            <span className="when-signed-in">{nav.app.signedIn}</span>
          </a>
        </nav>
        <div className="header-actions">
          <a href={other.href} hrefLang={other.hrefLang} lang={other.hrefLang}>
            {other.text}
          </a>
          <a className="star-link" href={githubUrl} aria-label="Star on GitHub">
            <StarIcon />
            <span className="star-label">
              Star<span className="star-text"> on GitHub</span>
            </span>
          </a>
        </div>
      </div>
    </header>
  );
}
