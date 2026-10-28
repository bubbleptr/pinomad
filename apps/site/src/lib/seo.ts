import type { Lang } from "./i18n.ts";

export const siteOrigin = "https://pinomad.si";

export type PageAlternates = Partial<Record<Lang, string>>;

export type PageLink = { rel: string; href: string; hrefLang?: string };

function withTrailingSlash(path: string): string {
  if (path === "/") return "/";
  return path.endsWith("/") ? path : `${path}/`;
}

function absolute(path: string): string {
  return `${siteOrigin}${withTrailingSlash(path)}`;
}

/**
 * Canonical and hreflang links for a page. `alternates` only lists languages
 * that actually have the page, so a Chinese-only page never points at an
 * English page that was never built.
 */
export function pageSeoLinks(path: string, alternates: PageAlternates): PageLink[] {
  const links: PageLink[] = [{ rel: "canonical", href: absolute(path) }];
  if (alternates.en) links.push({ rel: "alternate", hrefLang: "en", href: absolute(alternates.en) });
  if (alternates.zh) links.push({ rel: "alternate", hrefLang: "zh-CN", href: absolute(alternates.zh) });
  if (alternates.en && alternates.zh) {
    links.push({ rel: "alternate", hrefLang: "x-default", href: absolute(alternates.en) });
  }
  return links;
}
