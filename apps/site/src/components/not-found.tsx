import { HomeLayout } from "fumadocs-ui/layouts/home";
import { localized, type Lang } from "@/lib/i18n.ts";
import appCss from "@/styles/app.css?url";
import { homeLayout, Shell } from "./shell.tsx";

const copy = {
  en: {
    title: "Page not found",
    lead: "This page doesn't exist, or it has moved.",
    home: "Home",
    docs: "Docs",
  },
  zh: {
    title: "页面不存在",
    lead: "这个页面不存在，或者已经搬走了。",
    home: "首页",
    docs: "文档",
  },
} as const;

/**
 * Rendered for any path the router can't serve, and prerendered on its own as
 * 404.html / zh/404.html (without client scripts) for Cloudflare Pages.
 */
export function NotFound({ lang }: { lang: Lang }) {
  const c = copy[lang];
  return (
    <Shell lang={lang}>
      {/* Rendered for any route, so it brings its own head entries rather than
          relying on the matched route's. */}
      <title>{`${c.title} — PiNomad`}</title>
      <meta name="robots" content="noindex" />
      <link rel="stylesheet" href={appCss} precedence="default" />
      <HomeLayout {...homeLayout}>
        <div className="mx-auto flex w-full max-w-3xl flex-col items-start px-4 py-24">
          <p className="font-mono text-sm text-fd-muted-foreground">404</p>
          <h1 className="mt-2 text-3xl font-semibold">{c.title}</h1>
          <p className="mt-3 text-fd-muted-foreground">{c.lead}</p>
          <div className="mt-8 flex gap-6 text-sm font-medium">
            <a href={localized(lang, "/")} className="underline underline-offset-4">
              {c.home}
            </a>
            <a href={localized(lang, "/docs/")} className="underline underline-offset-4">
              {c.docs}
            </a>
          </div>
        </div>
      </HomeLayout>
    </Shell>
  );
}
