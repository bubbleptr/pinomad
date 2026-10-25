import { createFileRoute } from "@tanstack/react-router";
import { BlogIndexPage } from "@/components/blog-pages.tsx";
import { shellLinks } from "@/components/shell.tsx";
import { loadBlogIndex } from "@/lib/content-data.ts";

export const Route = createFileRoute("/blog/")({
  loader: () => loadBlogIndex({ data: "en" }),
  head: () => ({ meta: [{ title: "Blog — PiNomad" }], links: shellLinks }),
  component: () => <BlogIndexPage lang="en" posts={Route.useLoaderData()} />,
});
