import { createFileRoute } from "@tanstack/react-router";
import { Landing, landingRouteHead } from "@/landing/landing.tsx";

export const Route = createFileRoute("/")({
  head: () => landingRouteHead("en"),
  component: () => <Landing lang="en" />,
});
