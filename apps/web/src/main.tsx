import "./app/styles.css";
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
    // Tooltips open after 200ms, as they did before ADR-0048; Base UI's own
    // default is 600ms.
    <TooltipProvider delay={200}>
      <App />
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
