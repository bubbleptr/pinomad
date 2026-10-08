import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const shared = {
  environment: "node",
  pool: "forks",
  testTimeout: 60_000,
  hookTimeout: 30_000,
} as const;

// Same single-React pin as apps/web/vite.config.ts: bun nests a second copy
// under @astryxdesign/core, which breaks React 19 hooks in jsdom tests.
const requireFromWeb = createRequire(new URL("./apps/web/package.json", import.meta.url));
const webSrc = fileURLToPath(new URL("./apps/web/src", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "protocol",
          include: ["packages/protocol/test/**/*.test.ts"],
        },
      },
      {
        test: {
          ...shared,
          name: "host",
          include: ["apps/host/test/**/*.test.ts"],
        },
      },
      {
        test: {
          ...shared,
          name: "relay",
          include: ["apps/relay/test/**/*.test.ts"],
        },
      },
      {
        test: {
          ...shared,
          name: "web",
          include: ["apps/web/test/**/*.test.ts"],
        },
      },
      {
        resolve: {
          alias: {
            "@": webSrc,
            react: dirname(requireFromWeb.resolve("react/package.json")),
            "react-dom": dirname(requireFromWeb.resolve("react-dom/package.json")),
          },
        },
        test: {
          ...shared,
          name: "web-dom",
          environment: "jsdom",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          setupFiles: ["apps/web/src/test/setup.ts"],
        },
      },
    ],
  },
});
