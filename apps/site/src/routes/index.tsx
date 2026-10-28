import { createFileRoute } from "@tanstack/react-router";
import { landingRouteHead } from "@/landing/head.ts";
import { Landing } from "@/landing/landing.tsx";
import { loadChangelog } from "@/lib/content-data.ts";

export const Route = createFileRoute("/")({
  loader: async () => (await loadChangelog({ data: "en" }))[0],
  head: ({ loaderData }) => landingRouteHead("en", loaderData?.version),
  component: () => <Landing lang="en" latest={Route.useLoaderData()} />,
});
