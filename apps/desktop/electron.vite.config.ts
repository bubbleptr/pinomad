import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import { webViteBase } from "../web/vite.config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../web");

// electron-vite 5 types `build` for Vite 6+ (BuildEnvironmentOptions, which
// drops rollupOptions); the repo pins Vite 5, where the runtime still reads
// build.rollupOptions.input — so each build block is a real Vite 5 shape,
// cast past electron-vite's narrower declaration.

// webViteBase supplies the plugins and the single-React pin; the bundle must
// never drift from what browsers get. Only the port and output differ.
const renderer = webViteBase(webRoot);

export default defineConfig({
  // Main and preload emit CommonJS: ESM named imports from the "electron"
  // builtin do not resolve (the ESM loader gives it only a default export),
  // and a sandboxed preload must be CJS regardless.
  main: {
    build: {
      rollupOptions: {
        input: resolve(here, "electron/main.ts"),
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    } as never,
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(here, "electron/preload.ts"),
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    } as never,
  },
  renderer: {
    ...renderer,
    root: webRoot,
    // Keep off web's dev port so `bun run web` and `bun run desktop` coexist.
    server: { host: "127.0.0.1", port: 5299, strictPort: true },
    build: {
      outDir: resolve(here, "out/renderer"),
      emptyOutDir: true,
      rollupOptions: { input: resolve(webRoot, "index.html") },
    } as never,
  },
});
