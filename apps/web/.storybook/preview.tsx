import "../src/app/styles.css";
import "./preview.css";
import type { Preview } from "@storybook/react-vite";
import { useEffect } from "react";

type Mode = "system" | "light" | "dark";

/** The `dark` class on <html> from the toolbar's mode; the tokens' color-scheme and `dark:` styles both follow it (the app's useDarkClass reads its own setting). */
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
      description: "Color mode",
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
    (Story, { globals, parameters }) => (
      <>
        <DarkClass mode={globals.mode as Mode} />
        <div className="sb-pinomad-canvas">
          <div className="sb-pinomad-column" data-width={parameters.canvasWidth ?? "column"}>
            <Story />
          </div>
        </div>
      </>
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
