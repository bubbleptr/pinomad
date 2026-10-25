import { createFileRoute } from "@tanstack/react-router";
import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source.ts";

const search = createFromSource(source);

// Prerendered once into a static index; the docs search box downloads it and
// searches in the browser.
export const Route = createFileRoute("/api/search.json")({
  server: {
    handlers: {
      GET: () => search.staticGET(),
    },
  },
});
