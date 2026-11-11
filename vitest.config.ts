import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const shared = {
  environment: "node",
  pool: "forks",
  testTimeout: 60_000,
  hookTimeout: 30_000,
} as const;

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
          name: "client",
          include: ["packages/client/test/**/*.test.ts"],
        },
      },
      {
        test: {
          ...shared,
          name: "cli",
          include: ["apps/cli/test/**/*.test.ts"],
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
          name: "server",
          include: ["apps/server/test/**/*.test.ts"],
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
        test: {
          ...shared,
          name: "desktop",
          include: ["apps/desktop/test/**/*.test.ts"],
        },
      },
      {
        resolve: { alias: { "@": fileURLToPath(new URL("./apps/site/src", import.meta.url)) } },
        test: {
          ...shared,
          name: "site",
          include: ["apps/site/test/**/*.test.{ts,tsx}"],
        },
      },
      {
        resolve: {
          alias: { "@": webSrc },
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
