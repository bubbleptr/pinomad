import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

// og:image / twitter:image need a stable absolute URL (https://pinomad.si/og-image.jpg),
// which a content-hashed asset can't give. Emit the README demo screenshot under a
// fixed name at build time instead of keeping a second copy in the repo.
function ogImage() {
  return {
    name: "pinomad-og-image",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "og-image.jpg",
        source: readFileSync(here("../../docs/assets/demo.jpg")),
      });
    },
  };
}

// Shared brand assets are referenced in place rather than copied: the icons are
// exports of the shared app icon (AGENTS.md), the screenshot is the README's.
// The HTML writes them as `@brand/…` / `@docs-assets/…`. Vite doesn't apply
// resolve.alias to HTML attributes, and a plain ../ URL above the site root works
// in build but is clamped to / by the browser in dev, so rewrite per mode: a
// relative path for build (Vite then hashes the file into dist/assets), /@fs/ for dev.
const sharedDirs = {
  "@brand/": here("../web/public"),
  "@docs-assets/": here("../../docs/assets"),
};

function sharedAssets() {
  return {
    name: "pinomad-shared-assets",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        let out = html;
        for (const [prefix, dir] of Object.entries(sharedDirs)) {
          const target = ctx.server
            ? `/@fs${dir}/`
            : `${relative(dirname(ctx.filename), dir)}/`;
          out = out.replaceAll(`"${prefix}`, `"${target}`);
        }
        return out;
      },
    },
  };
}

// The illustrations and icons are shared by the English and Chinese pages, so
// they live once under partials/ and each page writes `<!-- include name.svg -->`.
// Partials carry both languages (.en / .zh spans); the page's lang picks one.
const partialsDir = here("partials");

function partials() {
  return {
    name: "pinomad-partials",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(/<!-- include ([\w./-]+) -->/g, (_, name) =>
          readFileSync(`${partialsDir}/${name}`, "utf8").trim(),
        );
      },
    },
    configureServer(server) {
      server.watcher.add(partialsDir);
      server.watcher.on("change", (file) => {
        if (file.startsWith(partialsDir)) server.ws.send({ type: "full-reload" });
      });
    },
  };
}

export default defineConfig({
  plugins: [partials(), sharedAssets(), ogImage()],
  clearScreen: false,
  build: {
    // Keep every asset (including the ~1.6 KB favicon used as the header mark) a
    // hashed file: data: URIs would need img-src data: in the CSP.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        en: here("index.html"),
        zh: here("zh/index.html"),
      },
    },
  },
  server: {
    fs: { allow: [here("../..")] },
  },
});
