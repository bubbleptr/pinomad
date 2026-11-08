// xterm is heavy and only a surface that shows a screen needs it. One lazy
// loader serves terminals and background-process output alike, so the code
// face is measured only after it loaded.
import { Text } from "@astryxdesign/core/Text";
import { lazy } from "react";

export const LazyXtermView = lazy(() =>
  Promise.all([import("./xterm-view.tsx"), document.fonts.load('13px "Geist Mono Variable"').catch(() => [])])
    .then(([module]) => module)
    .catch(() => ({
      default: () => (
        <Text type="supporting" className="p-3">
          Couldn't load the terminal. Reload the page to try again.
        </Text>
      ),
    })),
);
