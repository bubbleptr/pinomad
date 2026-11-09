// Astryx CSS is @imported inside styles.css (after tailwindcss) so its
// cascade layers outrank Tailwind preflight.
import "./app/styles.css";
import { Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { useAppearance } from "./entities/appearance/appearance.ts";

function Root() {
  const appearance = useAppearance();
  useEffect(() => {
    void window.pinomadDesktop?.setAppearance?.(appearance);
  }, [appearance]);
  return (
    <Theme theme={neutralTheme} mode={appearance}>
      <App />
    </Theme>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
