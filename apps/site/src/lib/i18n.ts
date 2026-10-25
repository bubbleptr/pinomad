import { defineI18n } from "fumadocs-core/i18n";

export type Lang = "en" | "zh";

// English has no prefix and Chinese lives under /zh/, as the landing page always has.
// Files are `page.mdx` / `page.zh.mdx`; a page without a Chinese file falls back to English.
export const i18n = defineI18n<Lang>({
  languages: ["en", "zh"],
  defaultLanguage: "en",
  hideLocale: "default-locale",
  parser: "dot",
});

export const htmlLang: Record<Lang, string> = { en: "en", zh: "zh-CN" };

export function langOf(pathname: string): Lang {
  return pathname === "/zh" || pathname.startsWith("/zh/") ? "zh" : "en";
}

/** `path` starts with a slash and is the English path. */
export function localized(lang: Lang, path: string): string {
  return lang === "en" ? path : `/zh${path}`;
}
