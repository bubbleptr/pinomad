import { useLocation, useRouter } from "@tanstack/react-router";
import { defineI18nUI } from "fumadocs-ui/i18n";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import type { ReactNode } from "react";
import { i18n, localized, type Lang } from "@/lib/i18n.ts";
import { githubUrl, siteNav } from "@/lib/nav.ts";
import { counterpart } from "@/lib/pages.ts";
import { GitHubIcon } from "@/landing/icons.tsx";
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
    "Choose a language(language switcher)(aria-label)": "选择语言",
    "Language(language switcher)": "语言",
    "Theme(site menu)": "主题",
    "Toggle Theme(theme switcher)(aria-label)": "切换主题",
    "Page Not Found(404 not found page)": "页面不存在",
    "Back to Home(404 not found page)": "回到首页",
  },
});

/** Fumadocs context for docs and blog: theme, search, and translated UI strings. */
export function Shell({ lang, children }: { lang: Lang; children: ReactNode }) {
  const router = useRouter();
  const pathname = useLocation({ select: (l) => l.pathname });
  // Fumadocs' own switch swaps the /zh prefix, which lands on a missing page
  // when this one has no version in the other language.
  const i18nProps = {
    ...ui.provider(lang),
    onLocaleChange: (target: string) => router.navigate({ href: counterpart(pathname, target === "zh" ? "zh" : "en") }),
  };
  return (
    <RootProvider i18n={i18nProps} search={{ options: { type: "static", api: "/api/search.json" } }}>
      {children}
    </RootProvider>
  );
}

export function baseOptions(lang: Lang): BaseLayoutProps {
  const nav = siteNav(lang);
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
    // GitHub and the app link sit at the far end, as on the landing header; listing the
    // icon here instead of passing githubUrl keeps the app link last.
    links: [
      ...nav.links.map((link) => ({ ...link, active: "nested-url" as const })),
      { type: "icon", label: "GitHub", icon: <GitHubIcon />, text: "GitHub", url: githubUrl, external: true },
      {
        type: "button",
        secondary: true,
        text: (
          <>
            <span className="when-signed-out">{nav.app.signedOut}</span>
            <span className="when-signed-in">{nav.app.signedIn}</span>
          </>
        ),
        url: nav.app.url,
        external: true,
      },
    ],
  };
}
