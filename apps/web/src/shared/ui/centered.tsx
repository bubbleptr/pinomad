import { VStack } from "@astryxdesign/core/Layout";
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
    <VStack className="pigui-centered" style={page} isScrollable>
      {reserveStrip ? <div aria-hidden="true" className="pinomad-drag fixed inset-x-0 top-0 h-10" /> : null}
      <VStack minHeight="100%" style={{ flexShrink: 0 }} hAlign="center" vAlign="center" padding={6}>
        {children}
      </VStack>
    </VStack>
  );
}
