import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The web bundle's shared Vite shape — also consumed by apps/desktop's
 * electron-vite renderer, which must pass the web dir explicitly: electron-vite
 * bundles config files, so this function takes `root` instead of reading
 * import.meta.url, and the plugin imports are resolved by the caller's scope.
 */
export function webViteBase(root: string): UserConfig {
  // bun nests a second `react` under @astryxdesign/core; pin one copy or
  // React 19 throws `reading 'use'` in Astryx hooks.
  const requireFromWeb = createRequire(join(root, "package.json"));
  return {
    root,
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    resolve: {
      alias: {
        // Pace's `@/` convention, so files copied from it keep working (ADR-0014).
        "@": join(root, "src"),
        react: dirname(requireFromWeb.resolve("react/package.json")),
        "react-dom": dirname(requireFromWeb.resolve("react-dom/package.json")),
      },
    },
    server: { host: "127.0.0.1", port: 5199, strictPort: true },
  };
}

export default defineConfig(webViteBase(here));
