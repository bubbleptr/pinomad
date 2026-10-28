import { createFileRoute } from "@tanstack/react-router";
import { landingRouteHead } from "@/landing/head.ts";
import { Landing } from "@/landing/landing.tsx";
import { loadChangelog } from "@/lib/content-data.ts";

export const Route = createFileRoute("/zh/")({
  loader: async () => (await loadChangelog({ data: "zh" }))[0],
  head: ({ loaderData }) => landingRouteHead("zh", loaderData?.version),
  component: () => <Landing lang="zh" latest={Route.useLoaderData()} />,
});
