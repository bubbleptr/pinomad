// Applies the stored appearance (src/entities/appearance/appearance.ts) before
// the app's module loads, so a forced light or dark theme doesn't flash the
// system's on first paint. A separate file because the CSP allows no inline script.
var appearance = null;
try {
  appearance = localStorage.getItem("pinomad.appearance");
} catch (_) {
  // Storage blocked: the app falls back to the system's appearance.
}
// The class the tokens' color-scheme and Tailwind's `dark:` variant follow;
// useDarkClass keeps it current.
document.documentElement.classList.toggle(
  "dark",
  appearance === "dark" || (appearance !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches),
);
