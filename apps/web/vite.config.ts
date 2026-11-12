import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";
import { SANDBOX_CSP, SANDBOX_PAGE } from "../host/src/web-client.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The web bundle's shared Vite shape — also consumed by apps/desktop's
 * electron-vite renderer, which must pass the web dir explicitly: electron-vite
 * bundles config files, so this function takes `root` instead of reading
 * import.meta.url, and the plugin imports are resolved by the caller's scope.
 */
export function webViteBase(root: string): UserConfig {
  return {
    root,
    plugins: [
      react(),
      tailwindcss(),
      // The dev server sends no policy for the client, but the sandbox page
      // (ADR-0049) must get its own here too, or model HTML would run unconfined.
      {
        name: "pinomad-sandbox-csp",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.split("?")[0] === `/${SANDBOX_PAGE}`) response.setHeader("content-security-policy", SANDBOX_CSP);
            next();
          });
        },
      },
    ],
    clearScreen: false,
    resolve: {
      alias: {
        // Pace's `@/` convention, so files copied from it keep working (ADR-0014).
        "@": join(root, "src"),
        // @pierre/diffs would ship every Shiki grammar (for its no-WebAssembly
        // fallback) and two theme catalogs; these stand-ins keep a curated set
        // of grammars and its two default themes.
        "shiki/langs": join(root, "src/presentation/pierre/shiki-langs.ts"),
        "shiki/wasm": join(root, "src/presentation/pierre/shiki-wasm.ts"),
        "@pierre/highlights/themes/loader": join(root, "src/presentation/pierre/highlights-themes.ts"),
        "@pierre/theming/themes": join(root, "src/presentation/pierre/theming-themes.ts"),
      },
    },
    server: { host: "127.0.0.1", port: 5199, strictPort: true },
  };
}

export default defineConfig(webViteBase(here));
