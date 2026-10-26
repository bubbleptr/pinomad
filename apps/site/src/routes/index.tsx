import { createFileRoute } from "@tanstack/react-router";
import { Landing, landingRouteHead } from "@/landing/landing.tsx";
import { loadChangelog } from "@/lib/content-data.ts";

export const Route = createFileRoute("/")({
  loader: async () => (await loadChangelog({ data: "en" }))[0],
  head: () => landingRouteHead("en"),
  component: () => <Landing lang="en" latest={Route.useLoaderData()} />,
});
