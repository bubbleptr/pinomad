import { createFileRoute } from "@tanstack/react-router";
import { Landing, landingRouteHead } from "@/landing/landing.tsx";

export const Route = createFileRoute("/zh/")({
  head: () => landingRouteHead("zh"),
  component: () => <Landing lang="zh" />,
});
