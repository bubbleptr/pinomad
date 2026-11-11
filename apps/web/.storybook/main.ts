import type { StorybookConfig } from "@storybook/react-vite";

// The react-vite builder loads apps/web/vite.config.ts, so the aliases
// (`@/` among them) and the Tailwind plugin come along unchanged.
const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-docs"],
  core: { disableTelemetry: true },
};

export default config;
