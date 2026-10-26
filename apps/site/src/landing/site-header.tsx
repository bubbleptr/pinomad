import { localized, type Lang } from "@/lib/i18n.ts";
import { githubUrl, otherLanguage, siteNav } from "@/lib/nav.ts";
import favicon from "../../../web/public/favicon.svg?url";
import type { LandingCopy } from "./copy.tsx";
import { GitHubIcon } from "./icons.tsx";

/** A plain sticky bar: brand and page links on the left; language, GitHub and the app on the right. */
export function SiteHeader({ lang, t }: { lang: Lang; t: LandingCopy }) {
  const nav = siteNav(lang);
  const other = otherLanguage[lang];
  return (
    <header className="site-header">
      <div className="header-bar">
        <a className="brand" href={localized(lang, "/")} aria-label={t.home}>
          <img src={favicon} alt="" width="22" height="22" />
          <span>PiNomad</span>
        </a>
        <nav className="header-nav" aria-label={t.primaryNav}>
          {nav.links.map((link) => (
            <a key={link.url} href={link.url}>
              {link.text}
            </a>
          ))}
        </nav>
        <div className="header-actions">
          <a href={other.href} hrefLang={other.hrefLang} lang={other.hrefLang}>
            {other.text}
          </a>
          <a className="icon-link" href={githubUrl} aria-label="GitHub">
            <GitHubIcon />
          </a>
          <a className="app-link" href={nav.app.url}>
            <span className="when-signed-out">{nav.app.signedOut}</span>
            <span className="when-signed-in">{nav.app.signedIn}</span>
          </a>
        </div>
      </div>
    </header>
  );
}
