import { createFileRoute } from "@tanstack/react-router";
import { ChangelogPage, preloadChangelog } from "@/components/changelog-page.tsx";
import { loadChangelog } from "@/lib/content-data.ts";
import { pageSeoLinks } from "@/lib/seo.ts";
import { shellLinks } from "@/lib/styles.ts";

export const Route = createFileRoute("/changelog/")({
  loader: async () => {
    const entries = await loadChangelog({ data: "en" });
    await preloadChangelog(entries);
    return entries;
  },
  head: () => ({
    meta: [{ title: "Changelog — PiNomad" }],
    links: [...shellLinks, ...pageSeoLinks("/changelog/", { en: "/changelog/", zh: "/zh/changelog/" })],
  }),
  component: () => <ChangelogPage lang="en" entries={Route.useLoaderData()} />,
});
