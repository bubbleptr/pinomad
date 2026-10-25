import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "@/components/not-found.tsx";

// Prerendered, then moved to /zh/404.html by scripts/not-found.ts.
export const Route = createFileRoute("/zh/404")({
  component: () => <NotFound lang="zh" />,
});
