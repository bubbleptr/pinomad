// Applies the stored appearance (src/entities/appearance/appearance.ts) before
// the app's module loads, so a forced light or dark theme doesn't flash the
// system's on first paint. A separate file because the CSP allows no inline script.
try {
  var appearance = localStorage.getItem("pinomad.appearance");
  if (appearance === "light" || appearance === "dark") {
    document.documentElement.setAttribute("data-theme", appearance);
  }
} catch (_) {
  // Storage blocked: the app falls back to the system's appearance.
}
