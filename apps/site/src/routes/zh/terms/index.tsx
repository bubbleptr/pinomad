import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, legalLoader } from "@/components/legal-page.tsx";
import { pageSeoLinks } from "@/lib/seo.ts";
import { shellLinks } from "@/lib/styles.ts";

export const Route = createFileRoute("/zh/terms/")({
  loader: () => legalLoader("zh", "terms"),
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} — PiNomad` }, { name: "description", content: loaderData.description }] : [],
    links: loaderData ? [...shellLinks, ...pageSeoLinks(loaderData.url, loaderData.alternates)] : shellLinks,
  }),
  component: () => <LegalPage lang="zh" path={Route.useLoaderData().path} />,
});
