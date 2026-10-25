import { createFileRoute } from "@tanstack/react-router";
import { BlogIndexPage } from "@/components/blog-pages.tsx";
import { shellLinks } from "@/components/shell.tsx";
import { loadBlogIndex } from "@/lib/content-data.ts";

export const Route = createFileRoute("/zh/blog/")({
  loader: () => loadBlogIndex({ data: "zh" }),
  head: () => ({ meta: [{ title: "博客 — PiNomad" }], links: shellLinks }),
  component: () => <BlogIndexPage lang="zh" posts={Route.useLoaderData()} />,
});
