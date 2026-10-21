/**
 * Native window chrome per OS — copied from Pace's electron/window-chrome.ts.
 * On macOS the window is transparent with under-window vibrancy so the
 * sidebar reads as glass; the renderer keeps the main pane opaque (see the
 * data-pinomad-vibrancy rules in apps/web/src/app/styles.css).
 */
export type WindowChromeOptions = {
  frame?: boolean;
  titleBarStyle?: "hidden";
  trafficLightPosition?: { x: number; y: number };
  transparent?: boolean;
  vibrancy?: "under-window";
  visualEffectState?: "followWindow";
  backgroundColor?: string;
};

export function platformWindowChrome(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform === "darwin") {
    // The 40px header hosts the traffic lights; the web side reserves the
    // left inset (see apps/web/src/shared/host-chrome.ts).
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 16, y: 13 },
      // Transparent web contents are required for vibrancy to show through
      // CSS; the `sidebar` material is too dense to read as glass.
      transparent: true,
      vibrancy: "under-window",
      visualEffectState: "followWindow",
      backgroundColor: "#00000000",
    };
  }
  if (platform === "linux") {
    return { frame: true };
  }
  return { titleBarStyle: "hidden" };
}
