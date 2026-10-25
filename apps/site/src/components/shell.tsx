import { defineI18nUI } from "fumadocs-ui/i18n";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import type { ReactNode } from "react";
import { i18n, localized, type Lang } from "@/lib/i18n.ts";
import appCss from "@/styles/app.css?url";
import favicon from "../../../web/public/favicon.svg?url";

const ui = defineI18nUI(i18n, {
  en: { displayName: "English" },
  zh: {
    displayName: "中文",
    "Search(search trigger)": "搜索",
    "Search(search dialog)": "搜索文档",
    "No results found(search dialog)": "没有找到结果",
    "On this page(table of contents)": "本页内容",
    "No Headings(table of contents)": "没有标题",
    "Previous Page(pagination)": "上一页",
    "Next Page(pagination)": "下一页",
    "Edit on GitHub(edit page)": "在 GitHub 上编辑",
    "Choose a language(language switcher)": "选择语言",
    "Language(language switcher)": "语言",
    "Theme(site menu)": "主题",
    "Toggle Theme(theme switcher)(aria-label)": "切换主题",
    "Page Not Found(404 not found page)": "页面不存在",
    "Back to Home(404 not found page)": "回到首页",
  },
});

const appLabel = {
  en: { signedOut: "Sign in", signedIn: "Open web app" },
  zh: { signedOut: "登录", signedIn: "打开 Web 端" },
} as const;

/** Stylesheet for every docs and blog page; the landing page brings its own. */
export const shellLinks = [{ rel: "stylesheet", href: appCss }];

/** Fumadocs context for docs and blog: theme, search, and translated UI strings. */
export function Shell({ lang, children }: { lang: Lang; children: ReactNode }) {
  return (
    <RootProvider i18n={ui.provider(lang)} search={{ options: { type: "static", api: "/api/search.json" } }}>
      {children}
    </RootProvider>
  );
}

export function baseOptions(lang: Lang): BaseLayoutProps {
  const label = appLabel[lang];
  return {
    i18n,
    nav: {
      title: (
        <>
          <img src={favicon} alt="" width={22} height={22} />
          <span>PiNomad</span>
        </>
      ),
      url: localized(lang, "/"),
    },
    githubUrl: "https://github.com/bubbleptr/pinomad",
    links: [
      { text: lang === "zh" ? "文档" : "Docs", url: localized(lang, "/docs/"), active: "nested-url" },
      { text: lang === "zh" ? "博客" : "Blog", url: localized(lang, "/blog/"), active: "nested-url" },
      {
        text: (
          <>
            <span className="when-signed-out">{label.signedOut}</span>
            <span className="when-signed-in">{label.signedIn}</span>
          </>
        ),
        url: "https://app.pinomad.si/",
        external: true,
      },
    ],
  };
}
