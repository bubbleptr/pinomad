/**
 * Native window chrome per OS — adapted from Pace's electron/window-chrome.ts.
 * The window is opaque everywhere: the renderer paints the frame color behind
 * the sidebar and the inset panes (no macOS vibrancy).
 */
export type WindowChromeOptions = {
  frame?: boolean;
  titleBarStyle?: "hidden";
  trafficLightPosition?: { x: number; y: number };
};

export function platformWindowChrome(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform === "darwin") {
    // The 40px header hosts the traffic lights; the web side reserves the
    // left inset (see apps/web/src/shared/host-chrome.ts).
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 16, y: 13 },
    };
  }
  if (platform === "linux") {
    return { frame: true };
  }
  return { titleBarStyle: "hidden" };
}
