// Astryx CSS is @imported inside styles.css (after tailwindcss) so its
// cascade layers outrank Tailwind preflight.
import "./app/styles.css";
import { Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { useAppearance, useDarkClass } from "./entities/appearance/appearance.ts";
import { TooltipProvider } from "./shared/ui/tooltip.tsx";

function Root() {
  const appearance = useAppearance();
  useDarkClass();
  useEffect(() => {
    void window.pinomadDesktop?.setAppearance?.(appearance);
  }, [appearance]);
  return (
    <Theme theme={neutralTheme} mode={appearance}>
      {/* Astryx tooltips opened after 200ms; Base UI's own default is 600ms. */}
      <TooltipProvider delay={200}>
        <App />
      </TooltipProvider>
    </Theme>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
