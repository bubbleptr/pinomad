// Route loaders for docs and blog. Each is a server function behind
// staticFunctionMiddleware: it runs while the site is prerendered, its result is
// written next to the pages as JSON, and client-side navigation fetches that
// file. There is no server at runtime.

import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { staticFunctionMiddleware } from "@tanstack/start-static-server-functions";
import type { Lang } from "./i18n.ts";
import { blog, blogPosts, source } from "./source.ts";

export const loadDocsPage = createServerFn({ method: "GET" })
  .middleware([staticFunctionMiddleware])
  .validator((input: { lang: Lang; slugs: string[] }) => input)
  .handler(async ({ data: { lang, slugs } }) => {
    const page = source.getPage(slugs, lang);
    if (!page) throw notFound();
    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description,
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
    return { path: post.path, title: post.data.title, description: post.data.description };
  });
