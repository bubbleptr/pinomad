import { localized, type Lang } from "./i18n.ts";

// The header links on every page: the landing header and the Fumadocs header
// (docs, blog, changelog) both read them from here, so the two can't drift.
// Plain strings and paths only; each header wraps them in its own markup.

export const githubUrl = "https://github.com/bubbleptr/pinomad";
export const appUrl = "https://app.pinomad.si/";

const labels = {
  en: { docs: "Docs", blog: "Blog", changelog: "Changelog", signIn: "Sign in", openApp: "Open web app" },
  zh: { docs: "文档", blog: "博客", changelog: "更新日志", signIn: "登录", openApp: "打开 Web 端" },
} as const;

export function siteNav(lang: Lang) {
  const label = labels[lang];
  return {
    links: [
      { text: label.docs, url: localized(lang, "/docs/") },
      { text: label.blog, url: localized(lang, "/blog/") },
      { text: label.changelog, url: localized(lang, "/changelog/") },
    ],
    // The app link reads "Sign in" until public/app-hint.js marks a visitor who uses the web app.
    app: { url: appUrl, signedOut: label.signIn, signedIn: label.openApp },
  };
}

/** The link to the same page in the other language, labelled in that language. */
export const otherLanguage = {
  en: { text: "中文", href: "/zh/", hrefLang: "zh-CN" },
  zh: { text: "English", href: "/", hrefLang: "en" },
} as const satisfies Record<Lang, { text: string; href: string; hrefLang: string }>;
