/// <reference types="vite/client" />
import { composeStories, setProjectAnnotations } from "@storybook/react-vite";
import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import preview from "../../.storybook/preview.tsx";

// Every story renders under the real preview decorators, so a prop change
// that breaks a story fails `bun run test` instead of rotting silently.
setProjectAnnotations(preview);

type StoryModule = Parameters<typeof composeStories>[0];
const modules = import.meta.glob<StoryModule>("../**/*.stories.tsx", { eager: true });

describe.each(Object.entries(modules))("%s", (_path, module) => {
  const stories = composeStories(module) as Record<string, ComponentType>;
  it.each(Object.entries(stories))("%s renders", (_name, Story) => {
    const { container } = render(<Story />);
    expect(container.querySelector(".sb-pinomad-column")?.childElementCount).toBeGreaterThan(0);
  });
});
