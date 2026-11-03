// Stands in for `shiki/wasm` (vite.config.ts): the diff renderer uses the
// Highlights or JavaScript engines, never Shiki's Oniguruma WASM.
export default function wasm(): never {
  throw new Error("shiki-wasm is not bundled");
}
