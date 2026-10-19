// The label the desktop app registers on a host's device list. A UA-derived
// name would call it "Mac Chrome", indistinguishable from a browser tab on
// the same machine — the OS family plus the hostname tell them apart.

const PLATFORM_LABEL: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Mac",
  win32: "Windows",
  linux: "Linux",
};

export function desktopDeviceName(platform: NodeJS.Platform, hostname: string): string {
  const os = PLATFORM_LABEL[platform];
  const base = os === undefined ? "Desktop" : `${os} Desktop`;
  return hostname === "" ? base : `${base} (${hostname})`;
}
