import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      // Everything is prerendered to static files for Cloudflare Pages; there is
      // no server at runtime (docs/website.md).
      prerender: { enabled: true, crawlLinks: true, autoSubfolderIndex: true, failOnError: true },
      // Not linked from any page, so the crawler can't find it.
      pages: [{ path: "/api/search.json" }],
    }),
    react(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  clearScreen: false,
  build: {
    // Keep every asset a hashed file: data: URIs would need img-src data: in the CSP.
    assetsInlineLimit: 0,
  },
  server: {
    // The landing page uses the shared app icon from apps/web/public in place.
    fs: { allow: [here("../..")] },
  },
});
