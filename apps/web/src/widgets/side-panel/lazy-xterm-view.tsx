import { lazy } from "react";

export const LazyXtermView = lazy(() =>
  Promise.all([import("./xterm-view.tsx"), document.fonts.load('13px "Geist Mono Variable"').catch(() => [])])
    .then(([module]) => module)
    .catch(() => ({
      default: () => (
        <span className="text-xs/5 text-muted-foreground p-3">
          Couldn't load the terminal. Reload the page to try again.
        </span>
      ),
    })),
);
