import { createFileRoute } from "@tanstack/react-router";
import { ChangelogPage, preloadChangelog } from "@/components/changelog-page.tsx";
import { shellLinks } from "@/components/shell.tsx";
import { loadChangelog } from "@/lib/content-data.ts";

export const Route = createFileRoute("/zh/changelog/")({
  loader: async () => {
    const entries = await loadChangelog({ data: "zh" });
    await preloadChangelog(entries);
    return entries;
  },
  head: () => ({ meta: [{ title: "更新日志 — PiNomad" }], links: shellLinks }),
  component: () => <ChangelogPage lang="zh" entries={Route.useLoaderData()} />,
});
