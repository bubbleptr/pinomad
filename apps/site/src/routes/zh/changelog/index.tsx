import { createFileRoute } from "@tanstack/react-router";
import { ChangelogPage, preloadChangelog } from "@/components/changelog-page.tsx";
import { loadChangelog } from "@/lib/content-data.ts";
import { pageSeoLinks } from "@/lib/seo.ts";
import { shellLinks } from "@/lib/styles.ts";

export const Route = createFileRoute("/zh/changelog/")({
  loader: async () => {
    const entries = await loadChangelog({ data: "zh" });
    await preloadChangelog(entries);
    return entries;
  },
  head: () => ({
    meta: [{ title: "更新日志 — PiNomad" }],
    links: [...shellLinks, ...pageSeoLinks("/zh/changelog/", { en: "/changelog/", zh: "/zh/changelog/" })],
  }),
  component: () => <ChangelogPage lang="zh" entries={Route.useLoaderData()} />,
});
