import { createFileRoute } from "@tanstack/react-router";
import { BlogIndexPage } from "@/components/blog-pages.tsx";
import { loadBlogIndex } from "@/lib/content-data.ts";
import { pageSeoLinks } from "@/lib/seo.ts";
import { shellLinks } from "@/lib/styles.ts";

export const Route = createFileRoute("/blog/")({
  loader: () => loadBlogIndex({ data: "en" }),
  head: () => ({
    meta: [{ title: "Blog — PiNomad" }],
    links: [...shellLinks, ...pageSeoLinks("/blog/", { en: "/blog/", zh: "/zh/blog/" })],
  }),
  component: () => <BlogIndexPage lang="en" posts={Route.useLoaderData()} />,
});
