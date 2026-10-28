import { createFileRoute } from "@tanstack/react-router";
import { BlogIndexPage } from "@/components/blog-pages.tsx";
import { loadBlogIndex } from "@/lib/content-data.ts";
import { pageSeoLinks } from "@/lib/seo.ts";
import { shellLinks } from "@/lib/styles.ts";

export const Route = createFileRoute("/zh/blog/")({
  loader: () => loadBlogIndex({ data: "zh" }),
  head: () => ({
    meta: [{ title: "博客 — PiNomad" }],
    links: [...shellLinks, ...pageSeoLinks("/zh/blog/", { en: "/blog/", zh: "/zh/blog/" })],
  }),
  component: () => <BlogIndexPage lang="zh" posts={Route.useLoaderData()} />,
});
