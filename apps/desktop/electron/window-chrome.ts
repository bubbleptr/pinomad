/**
 * Native window chrome per OS — copied from Pace's electron/window-chrome.ts
 * minus the vibrancy path: PiNomad's UI paints an opaque body color, so a
 * transparent vibrated webContents would cost rendering and show nothing.
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
    return { titleBarStyle: "hidden", trafficLightPosition: { x: 16, y: 13 } };
  }
  if (platform === "linux") {
    return { frame: true };
  }
  return { titleBarStyle: "hidden" };
}
