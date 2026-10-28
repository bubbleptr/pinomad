import { createFileRoute } from "@tanstack/react-router";
import { docsLoader, DocsRoutePage } from "@/components/docs-page.tsx";
import { pageSeoLinks } from "@/lib/seo.ts";
import { shellLinks } from "@/lib/styles.ts";

export const Route = createFileRoute("/docs/$")({
  loader: ({ params }) => docsLoader("en", params._splat),
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} — PiNomad` }, { name: "description", content: loaderData.description }] : [],
    links: loaderData ? [...shellLinks, ...pageSeoLinks(loaderData.url, loaderData.alternates)] : shellLinks,
  }),
  component: () => <DocsRoutePage lang="en" data={Route.useLoaderData()} />,
});
