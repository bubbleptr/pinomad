import { createFileRoute } from "@tanstack/react-router";
import { Landing, landingRouteHead } from "@/landing/landing.tsx";
import { loadChangelog } from "@/lib/content-data.ts";

export const Route = createFileRoute("/zh/")({
  loader: async () => (await loadChangelog({ data: "zh" }))[0],
  head: () => landingRouteHead("zh"),
  component: () => <Landing lang="zh" latest={Route.useLoaderData()} />,
});
