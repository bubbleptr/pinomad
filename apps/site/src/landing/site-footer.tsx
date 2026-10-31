import { localized, type Lang } from "@/lib/i18n.ts";
import { githubUrl, otherLanguage, siteNav } from "@/lib/nav.ts";
import favicon from "../../../web/public/favicon.svg?url";
import type { LandingCopy } from "./copy.tsx";

export function SiteFooter({ lang, t }: { lang: Lang; t: LandingCopy["footer"] }) {
  const other = otherLanguage[lang];
  // siteNav order is docs, blog, changelog; the footer shows the last two.
  const [, blog, changelog] = siteNav(lang).links;
  return (
    <footer className="site-footer">
      <div className="wrap">
        <p className="footer-sign">
          <img src={favicon} alt="" width="20" height="20" />
          {t.sign}
        </p>
        <nav aria-label={t.nav}>
          <ul>
            <li>
              <a href={githubUrl}>GitHub</a>
            </li>
            <li>
              <a href={localized(lang, "/docs/")}>{t.docs}</a>
            </li>
            <li>
              <a href={blog.url}>{blog.text}</a>
            </li>
            <li>
              <a href={changelog.url}>{changelog.text}</a>
            </li>
            <li>
              <a href={`${githubUrl}/blob/main/LICENSE`}>{t.license}</a>
            </li>
            <li>
              <a href={localized(lang, "/privacy/")}>{t.privacy}</a>
            </li>
            <li>
              <a href={localized(lang, "/terms/")}>{t.terms}</a>
            </li>
            <li>
              <a href={other.href} hrefLang={other.hrefLang} lang={other.hrefLang}>
                {other.text}
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
