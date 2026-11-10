import "../src/app/styles.css";
import "./preview.css";
import { Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import type { Preview } from "@storybook/react-vite";
import { useEffect } from "react";

type Mode = "system" | "light" | "dark";

/** The class `dark:` styles follow, from the toolbar's mode (the app's useDarkClass reads its own setting). */
function DarkClass({ mode }: { mode: Mode }) {
  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", mode === "dark" || (mode === "system" && system.matches));
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [mode]);
  return null;
}

const preview: Preview = {
  globalTypes: {
    mode: {
      description: "Astryx color mode",
      toolbar: {
        title: "Mode",
        icon: "mirror",
        items: [
          { value: "system", title: "System" },
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { mode: "system" },
  decorators: [
    // Theme tokens are scoped to the Theme element, so the canvas surface is
    // painted inside it; Storybook's own body stays unthemed.
    (Story, { globals, parameters }) => (
      <Theme theme={neutralTheme} mode={globals.mode as Mode}>
        <DarkClass mode={globals.mode as Mode} />
        <div className="sb-pinomad-canvas">
          <div className="sb-pinomad-column" data-width={parameters.canvasWidth ?? "column"}>
            <Story />
          </div>
        </div>
      </Theme>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    canvasWidth: "column",
    // FSD layers, bottom up.
    options: { storySort: { order: ["Shared", "Entities", "Presentation", "Widgets"] } },
  },
};

export default preview;
