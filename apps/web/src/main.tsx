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
    <TooltipProvider>
      <App />
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
