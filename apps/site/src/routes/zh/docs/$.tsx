import { createFileRoute } from "@tanstack/react-router";
import { docsLoader, DocsRoutePage } from "@/components/docs-page.tsx";
import { shellLinks } from "@/components/shell.tsx";

export const Route = createFileRoute("/zh/docs/$")({
  loader: ({ params }) => docsLoader("zh", params._splat),
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} — PiNomad` }, { name: "description", content: loaderData.description }] : [],
    links: shellLinks,
  }),
  component: () => <DocsRoutePage lang="zh" data={Route.useLoaderData()} />,
});
