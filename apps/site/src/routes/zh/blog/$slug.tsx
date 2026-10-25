import { createFileRoute } from "@tanstack/react-router";
import { BlogPostPage, blogPostLoader } from "@/components/blog-pages.tsx";
import { shellLinks } from "@/components/shell.tsx";

export const Route = createFileRoute("/zh/blog/$slug")({
  loader: ({ params }) => blogPostLoader("zh", params.slug),
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} — PiNomad` }, { name: "description", content: loaderData.description }] : [],
    links: shellLinks,
  }),
  component: () => <BlogPostPage lang="zh" path={Route.useLoaderData().path} />,
});
