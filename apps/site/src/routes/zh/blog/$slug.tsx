import { createFileRoute } from "@tanstack/react-router";
import { BlogPostPage, preloadPost } from "@/components/blog-pages.tsx";
import { shellLinks } from "@/components/shell.tsx";
import { loadBlogPost } from "@/lib/content-data.ts";

export const Route = createFileRoute("/zh/blog/$slug")({
  loader: async ({ params }) => {
    const data = await loadBlogPost({ data: { lang: "zh", slug: params.slug } });
    await preloadPost(data.path);
    return data;
  },
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} — PiNomad` }, { name: "description", content: loaderData.description }] : [],
    links: shellLinks,
  }),
  component: () => <BlogPostPage lang="zh" path={Route.useLoaderData().path} />,
});
