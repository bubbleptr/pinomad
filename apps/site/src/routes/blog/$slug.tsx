import { createFileRoute } from "@tanstack/react-router";
import { BlogPostPage, preloadPost } from "@/components/blog-pages.tsx";
import { shellLinks } from "@/components/shell.tsx";
import { loadBlogPost } from "@/lib/content-data.ts";

export const Route = createFileRoute("/blog/$slug")({
  loader: async ({ params }) => {
    const data = await loadBlogPost({ data: { lang: "en", slug: params.slug } });
    await preloadPost(data.path);
    return data;
  },
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} — PiNomad` }, { name: "description", content: loaderData.description }] : [],
    links: shellLinks,
  }),
  component: () => <BlogPostPage lang="en" path={Route.useLoaderData().path} />,
});
