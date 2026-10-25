import { createFileRoute } from "@tanstack/react-router";
import { BlogPostPage, blogPostLoader } from "@/components/blog-pages.tsx";
import { shellLinks } from "@/components/shell.tsx";

export const Route = createFileRoute("/blog/$slug")({
  loader: ({ params }) => blogPostLoader("en", params.slug),
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} — PiNomad` }, { name: "description", content: loaderData.description }] : [],
    links: shellLinks,
  }),
  component: () => <BlogPostPage lang="en" path={Route.useLoaderData().path} />,
});
