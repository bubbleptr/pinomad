import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "@/components/not-found.tsx";

// Prerendered, then moved to /404.html by scripts/not-found.ts.
export const Route = createFileRoute("/404")({
  component: () => <NotFound lang="en" />,
});
