import { localized, type Lang } from "./i18n.ts";

// The header links on every page, read by the one SiteHeader that landing, docs,
// blog and changelog all render. Plain strings and paths only.

export const githubUrl = "https://github.com/bubbleptr/pinomad";
export const appUrl = "https://app.pinomad.si/";

const labels = {
  en: {
    home: "PiNomad home",
    primaryNav: "Primary",
    menu: "Menu",
    docs: "Docs",
    blog: "Blog",
    changelog: "Changelog",
    signIn: "Sign in",
    openApp: "Open web app",
  },
  zh: {
    home: "PiNomad 首页",
    primaryNav: "主导航",
    menu: "菜单",
    docs: "文档",
    blog: "博客",
    changelog: "更新日志",
    signIn: "登录",
    openApp: "打开 Web 端",
  },
} as const;

export function siteNav(lang: Lang) {
  const label = labels[lang];
  return {
    home: { text: label.home, url: localized(lang, "/") },
    primaryNav: label.primaryNav,
    menu: label.menu,
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
