import { VStack } from "@astryxdesign/core/Layout";
import type { CSSProperties, ReactNode } from "react";
import { hostWindowChrome } from "../host-chrome.ts";

const page: CSSProperties = {
  height: "100dvh",
  width: "100%",
  backgroundColor: "var(--color-background-body)",
  color: "var(--color-text-primary)",
};

/** The full-page shell for connecting, failure and no-host screens. */
export function Centered({ children }: { children: ReactNode }) {
  // These screens have no header to drag the hidden-title-bar window by.
  const reserveStrip = hostWindowChrome().reserveMacTrafficLights;
  return (
    <VStack style={page} isScrollable>
      {reserveStrip ? <div aria-hidden="true" className="pinomad-drag fixed inset-x-0 top-0 h-10" /> : null}
      <VStack minHeight="100%" style={{ flexShrink: 0 }} hAlign="center" vAlign="center" padding={6}>
        {children}
      </VStack>
    </VStack>
  );
}
