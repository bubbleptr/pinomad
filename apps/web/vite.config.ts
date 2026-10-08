import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
// bun nests a second `react` under @astryxdesign/core; pin one copy or React 19
// throws `reading 'use'` in Astryx hooks.
const requireFromWeb = createRequire(new URL("./package.json", import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      // Pace's `@/` convention, so files copied from it keep working (ADR-0014).
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      react: dirname(requireFromWeb.resolve("react/package.json")),
      "react-dom": dirname(requireFromWeb.resolve("react-dom/package.json")),
    },
  },
  server: { host: "127.0.0.1", port: 5199, strictPort: true },
});
