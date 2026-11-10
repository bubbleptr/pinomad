import type { CSSProperties, ReactNode } from "react";
import { hostWindowChrome } from "../host-chrome.ts";

const page: CSSProperties = {
  width: "100%",
  color: "var(--color-text-primary)",
};

/**
 * The full-page shell for connecting, failure and no-host screens. On its own
 * it fills the window on the frame color; inside the app frame it is the
 * main pane (`.pigui-centered` in styles.css).
 */
export function Centered({ children }: { children: ReactNode }) {
  // These screens have no header to drag the hidden-title-bar window by.
  const reserveStrip = hostWindowChrome().reserveMacTrafficLights;
  return (
    <div className="pigui-centered flex flex-col overflow-auto" style={page}>
      {reserveStrip ? <div aria-hidden="true" className="pinomad-drag fixed inset-x-0 top-0 h-10" /> : null}
      <div className="flex flex-col items-center justify-center p-6 min-h-full shrink-0">{children}</div>
    </div>
  );
}
