import { createFileRoute } from "@tanstack/react-router";
import { BlogPostPage, blogPostLoader } from "@/components/blog-pages.tsx";
import { pageSeoLinks } from "@/lib/seo.ts";
import { shellLinks } from "@/lib/styles.ts";

export const Route = createFileRoute("/blog/$slug")({
  loader: ({ params }) => blogPostLoader("en", params.slug),
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} — PiNomad` }, { name: "description", content: loaderData.description }] : [],
    links: loaderData ? [...shellLinks, ...pageSeoLinks(loaderData.url, loaderData.alternates)] : shellLinks,
  }),
  component: () => <BlogPostPage lang="en" path={Route.useLoaderData().path} />,
});
