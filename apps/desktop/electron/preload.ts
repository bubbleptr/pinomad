// Sandboxed preload: no ipcRenderer here — this PR has no invoke channel, so
// the preload's only job is telling the renderer which platform owns the
// window (the renderer has no Node `process`). Copied from Pace's pattern.
function markHostDocument(): void {
  const root = document.documentElement;
  if (!root) {
    // HTTP dev pages can run the preload before the HTML root is parsed.
    return;
  }
  root.dataset.pinomadPlatform = process.platform;
}

markHostDocument();
window.addEventListener("DOMContentLoaded", markHostDocument, { once: true });
