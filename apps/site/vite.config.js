import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

// og:image / twitter:image need a stable absolute URL (https://pinomad.si/og-image.jpg),
// which a content-hashed asset can't give, so copy it in under a fixed name.
// shots/og-image.jpg is a pre-made 1920×1200 JPEG export of shots/en/hero.webp;
// re-export it by hand whenever the hero capture changes.
function ogImage() {
  return {
    name: "pinomad-og-image",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "og-image.jpg",
        source: readFileSync(here("shots/og-image.jpg")),
      });
    },
  };
}

// Shared brand assets are referenced in place rather than copied: the icons are
// exports of the shared app icon (AGENTS.md). The HTML writes them as `@brand/…`.
// Vite doesn't apply resolve.alias to HTML attributes, and a plain ../ URL above
// the site root works in build but is clamped to / by the browser in dev, so
// rewrite per mode: a relative path for build (Vite then hashes the file into
// dist/assets), /@fs/ for dev.
const sharedDirs = {
  "@brand/": here("../web/public"),
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
