import { defineConfig } from "vitest/config";

const shared = {
  environment: "node",
  pool: "forks",
  testTimeout: 60_000,
  hookTimeout: 30_000,
} as const;

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
          name: "web",
          include: ["apps/web/test/**/*.test.ts"],
        },
      },
    ],
  },
});
