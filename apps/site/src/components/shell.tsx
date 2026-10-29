import { useLocation } from "@tanstack/react-router";
import { defineI18nUI } from "fumadocs-ui/i18n";
import { useHomeLayout, type HomeLayoutProps } from "fumadocs-ui/layouts/home";
import { useNotebookLayout, type DocsLayoutProps } from "fumadocs-ui/layouts/notebook";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import type { ReactNode } from "react";
import { i18n, langOf, type Lang } from "@/lib/i18n.ts";
import { counterpart } from "@/lib/pages.ts";
import { SiteHeader } from "./site-header.tsx";

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
    "Theme(site menu)": "主题",
    "Toggle Theme(theme switcher)(aria-label)": "切换主题",
    "Page Not Found(404 not found page)": "页面不存在",
    "Back to Home(404 not found page)": "回到首页",
  },
});

/** Fumadocs context for docs and blog: theme, search, and translated UI strings. */
export function Shell({ lang, children }: { lang: Lang; children: ReactNode }) {
  return (
    <RootProvider i18n={ui.provider(lang)} search={{ options: { type: "static", api: "/api/search.json" } }}>
      {children}
    </RootProvider>
  );
}

// Fumadocs' own header is swapped for the one every page shares. Its language
// dropdown goes too: the header's language link takes its place (and goes to the
// counterpart page, where Fumadocs would only swap the /zh prefix).

/** For HomeLayout: blog, changelog and the 404 page. */
export const homeLayout = { i18n: false, slots: { header: HomeHeader } } satisfies Partial<HomeLayoutProps>;

/** For the notebook DocsLayout, whose sidebar sits under the header. */
export const docsLayout = {
  i18n: false,
  nav: { mode: "top" },
  // The collapse button lives in Fumadocs' header, which isn't rendered.
  sidebar: { collapsible: false },
  slots: { header: DocsHeader },
} satisfies Partial<DocsLayoutProps>;

function HomeHeader() {
  const { slots } = useHomeLayout();
  return <PageHeader tools={<SearchAndTheme slots={slots} />} />;
}

function DocsHeader() {
  const { slots } = useNotebookLayout();
  const SidebarTrigger = slots.sidebar?.trigger;
  return (
    <PageHeader
      tools={
        <>
          <SearchAndTheme slots={slots} />
          {SidebarTrigger && (
            <SidebarTrigger className="inline-flex size-9 items-center justify-center rounded-lg text-fd-muted-foreground hover:text-fd-foreground md:hidden">
              <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
              </svg>
            </SidebarTrigger>
          )}
        </>
      }
    />
  );
}

function PageHeader({ tools }: { tools: ReactNode }) {
  const pathname = useLocation({ select: (l) => l.pathname });
  const lang = langOf(pathname);
  const languageHref = counterpart(pathname, lang === "zh" ? "en" : "zh");
  return <SiteHeader lang={lang} pathname={pathname} languageHref={languageHref} tools={tools} />;
}

function SearchAndTheme({ slots }: { slots: Pick<ReturnType<typeof useHomeLayout>["slots"], "searchTrigger" | "themeSwitch"> }) {
  const { searchTrigger: Search, themeSwitch: ThemeSwitch } = slots;
  return (
    <>
      {Search && (
        <>
          <Search.full hideIfDisabled className="w-full max-w-60 rounded-full ps-2.5 max-lg:hidden" />
          <Search.sm hideIfDisabled className="p-2 lg:hidden" />
        </>
      )}
      {ThemeSwitch && <ThemeSwitch />}
    </>
  );
}
