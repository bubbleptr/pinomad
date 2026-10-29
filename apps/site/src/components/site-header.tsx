import { useId, type MouseEvent, type ReactNode } from "react";
import type { Lang } from "@/lib/i18n.ts";
import { githubUrl, otherLanguage, siteNav } from "@/lib/nav.ts";
import { GitHubIcon } from "@/landing/icons.tsx";
import favicon from "../../../web/public/favicon.svg?url";

/**
 * The bar at the top of every page: brand and section links on the left; language,
 * GitHub and the app on the right. Landing renders it directly; docs, blog and
 * changelog hand it to Fumadocs as the layout's header slot. Its classes are plain
 * CSS (site-header.css) so it looks the same under either stylesheet.
 *
 * On phones the links collapse into a menu. The menu is a native popover, so it
 * opens without client scripts (the prerendered 404 pages ship none).
 */
export function SiteHeader({
  lang,
  pathname,
  languageHref,
  start,
  tools,
}: {
  lang: Lang;
  /** Marks the section link the page belongs to. */
  pathname: string;
  /** The same page in the other language. */
  languageHref: string;
  /** What a visitor who doesn't use the web app is offered; signing in at the app by default. */
  start?: { text: string; href: string };
  /** Controls only pages with Fumadocs have: search, theme, the docs sidebar. */
  tools?: ReactNode;
}) {
  const nav = siteNav(lang);
  const other = otherLanguage[lang];
  const menuId = useId();
  const signedOut = start ?? { text: nav.app.signedOut, href: nav.app.url };
  const links = nav.links.map((link) => (
    <a key={link.url} href={link.url} aria-current={pathname.startsWith(link.url) ? "page" : undefined}>
      {link.text}
    </a>
  ));
  const actions = (
    <>
      <a className="header-link" href={languageHref} hrefLang={other.hrefLang} lang={other.hrefLang}>
        {other.text}
      </a>
      <a className="header-link header-icon" href={githubUrl} aria-label="GitHub">
        <GitHubIcon />
      </a>
      {/* A returning visitor who uses the web app goes back to it instead. */}
      <a className="app-link when-signed-out" href={signedOut.href}>
        {signedOut.text}
      </a>
      <a className="app-link when-signed-in" href={nav.app.url}>
        {nav.app.signedIn}
      </a>
    </>
  );
  return (
    <header className="site-header">
      <div className="header-bar">
        <a className="brand" href={nav.home.url} aria-label={nav.home.text}>
          <img src={favicon} alt="" width="22" height="22" />
          <span>PiNomad</span>
        </a>
        <nav className="header-nav" aria-label={nav.primaryNav}>
          {links}
        </nav>
        <div className="header-end">
          {tools}
          <div className="header-actions">{actions}</div>
          <button type="button" className="menu-button" popoverTarget={menuId} aria-label={nav.menu}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M2.5 5h11M2.5 11h11" />
            </svg>
          </button>
        </div>
      </div>
      <div className="site-menu" id={menuId} popover="auto" onClick={closeOnFollow}>
        <nav className="site-menu-links" aria-label={nav.primaryNav}>
          {links}
        </nav>
        <div className="site-menu-actions">{actions}</div>
      </div>
    </header>
  );
}

// Following an in-page link (#quick-start) leaves the page where it is, so the menu
// would stay over it.
function closeOnFollow(event: MouseEvent<HTMLDivElement>) {
  if ((event.target as Element).closest("a")) event.currentTarget.hidePopover();
}
