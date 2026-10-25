import { createFileRoute } from "@tanstack/react-router";
import { ChangelogPage, preloadChangelog } from "@/components/changelog-page.tsx";
import { shellLinks } from "@/components/shell.tsx";
import { loadChangelog } from "@/lib/content-data.ts";

export const Route = createFileRoute("/changelog/")({
  loader: async () => {
    const entries = await loadChangelog({ data: "en" });
    await preloadChangelog(entries);
    return entries;
  },
  head: () => ({ meta: [{ title: "Changelog — PiNomad" }], links: shellLinks }),
  component: () => <ChangelogPage lang="en" entries={Route.useLoaderData()} />,
});
