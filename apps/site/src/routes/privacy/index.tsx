import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, legalLoader } from "@/components/legal-page.tsx";
import { pageSeoLinks } from "@/lib/seo.ts";
import { shellLinks } from "@/lib/styles.ts";

export const Route = createFileRoute("/privacy/")({
  loader: () => legalLoader("en", "privacy"),
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} — PiNomad` }, { name: "description", content: loaderData.description }] : [],
    links: loaderData ? [...shellLinks, ...pageSeoLinks(loaderData.url, loaderData.alternates)] : shellLinks,
  }),
  component: () => <LegalPage lang="en" path={Route.useLoaderData().path} />,
});
