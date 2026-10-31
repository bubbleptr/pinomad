// Route loaders for docs and blog. Each is a server function behind
// staticFunctionMiddleware: it runs while the site is prerendered, its result is
// written next to the pages as JSON, and client-side navigation fetches that
// file. There is no server at runtime.

import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { staticFunctionMiddleware } from "@tanstack/start-static-server-functions";
import type { Lang } from "./i18n.ts";
import { blog, blogPosts, changelog, legal, releases, source } from "./source.ts";

export type LegalSlug = "privacy" | "terms";

export const loadDocsPage = createServerFn({ method: "GET" })
  .middleware([staticFunctionMiddleware])
  .validator((input: { lang: Lang; slugs: string[] }) => input)
  .handler(async ({ data: { lang, slugs } }) => {
    const page = source.getPage(slugs, lang);
    if (!page) throw notFound();
    const english = source.getPage(slugs, "en");
    const chinese = source.getPage(slugs, "zh");
    return {
      path: page.path,
      url: page.url,
      title: page.data.title,
      description: page.data.description,
      // Fumadocs inherits English files into the Chinese source, so check the
      // page's actual locale instead of whether getPage returned something.
      alternates: {
        en: english?.locale === "en" ? english.url : undefined,
        zh: chinese?.locale === "zh" ? chinese.url : undefined,
      },
      pageTree: await source.serializePageTree(source.getPageTree(lang)),
    };
  });

export const loadBlogIndex = createServerFn({ method: "GET" })
  .middleware([staticFunctionMiddleware])
  .validator((lang: Lang) => lang)
  .handler(({ data: lang }) =>
    blog
      .getPages(lang)
      .flatMap((post) => {
        // The loader only types pages as PageData; the collection entry keeps the
        // blog schema (with `date`).
        const entry = blogPosts.get(post.path);
        return entry ? [{ url: post.url, title: entry.title, description: entry.description, date: entry.date }] : [];
      })
      .sort((a, b) => b.date.localeCompare(a.date)),
  );

export const loadBlogPost = createServerFn({ method: "GET" })
  .middleware([staticFunctionMiddleware])
  .validator((input: { lang: Lang; slug: string }) => input)
  .handler(({ data: { lang, slug } }) => {
    const post = blog.getPage([slug], lang);
    if (!post) throw notFound();
    const english = blog.getPage([slug], "en");
    const chinese = blog.getPage([slug], "zh");
    return {
      path: post.path,
      url: post.url,
      title: post.data.title,
      description: post.data.description,
      alternates: {
        en: english?.locale === "en" ? english.url : undefined,
        zh: chinese?.locale === "zh" ? chinese.url : undefined,
      },
    };
  });

export const loadLegalPage = createServerFn({ method: "GET" })
  .middleware([staticFunctionMiddleware])
  .validator((input: { lang: Lang; slug: LegalSlug }) => input)
  .handler(({ data: { lang, slug } }) => {
    const page = legal.getPage([slug], lang);
    if (!page) throw notFound();
    const english = legal.getPage([slug], "en");
    const chinese = legal.getPage([slug], "zh");
    return {
      path: page.path,
      url: page.url,
      title: page.data.title,
      description: page.data.description,
      alternates: {
        en: english?.locale === "en" ? english.url : undefined,
        zh: chinese?.locale === "zh" ? chinese.url : undefined,
      },
    };
  });

export const loadChangelog =createServerFn({ method: "GET" })
  .middleware([staticFunctionMiddleware])
  .validator((lang: Lang) => lang)
  .handler(({ data: lang }) =>
    changelog
      .getPages(lang)
      .flatMap((page) => {
        const entry = releases.get(page.path);
        return entry ? [{ path: page.path, version: entry.version, title: entry.title, date: entry.date }] : [];
      })
      .sort((a, b) => b.date.localeCompare(a.date)),
  );
