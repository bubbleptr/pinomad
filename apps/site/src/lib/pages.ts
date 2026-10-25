import { localized, type Lang } from "./i18n.ts";
import { blog, source } from "./source.ts";

function unprefixed(pathname: string): string {
  if (pathname === "/zh" || pathname === "/zh/") return "/";
  return pathname.startsWith("/zh/") ? pathname.slice(3) : pathname;
}

/**
 * Where the language switch should go from `pathname`: the same page in
 * `target`, or that language's section index when the page has no version
 * there. The Chinese site falls back to English pages, so only zh → en can
 * miss (a page written only in Chinese).
 */
export function counterpart(pathname: string, target: Lang): string {
  const path = unprefixed(pathname);
  const [section, ...rest] = path.split("/").filter(Boolean);
  if (section === "docs" && !source.getPage(rest, target)) return localized(target, "/docs/");
  if (section === "blog" && rest.length > 0 && !blog.getPage(rest, target)) return localized(target, "/blog/");
  return localized(target, path);
}
