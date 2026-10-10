/**
 * Renderer-side insets for the native window chrome — adapted from Pace's
 * shared/host-chrome.ts, trimmed to what this UI needs.
 *
 * The Electron preload sets `data-pinomad-platform` before page scripts run.
 * Missing or unknown platforms reserve no macOS traffic-light gutter: a normal
 * browser has no traffic lights to clear.
 */

/** The traffic-light cluster at {x:16, y:13} spans roughly 72px; add margin. */
export const macChromeSafeLeft = "92px";

export type HostPlatform = "darwin" | "other";

export type HostChrome = {
  platform: HostPlatform;
  /** True when the top-left band must clear the macOS traffic lights. */
  reserveMacTrafficLights: boolean;
  safeLeft: string;
};

export function readHostPlatform(platform?: string): HostPlatform {
  const value =
    platform ??
    (typeof document === "undefined" ? undefined : document.documentElement?.dataset.pinomadPlatform);
  return value === "darwin" ? "darwin" : "other";
}

export function hostWindowChrome(platform: HostPlatform = readHostPlatform()): HostChrome {
  if (platform === "darwin") {
    return { platform, reserveMacTrafficLights: true, safeLeft: macChromeSafeLeft };
  }
  return { platform, reserveMacTrafficLights: false, safeLeft: "0px" };
}
