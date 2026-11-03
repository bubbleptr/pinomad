// Stands in for `@pierre/theming/themes` (vite.config.ts) on the Shiki
// fallback: @pierre/diffs only calls `themes.getTheme(name).load()`, and only
// for Pierre's default light and dark themes.
const loaders: Readonly<Record<string, () => Promise<unknown>>> = {
  "pierre-light": () => import("@pierre/theme/pierre-light"),
  "pierre-dark": () => import("@pierre/theme/pierre-dark"),
};

export const themes = {
  getTheme: (name: string) => (Object.hasOwn(loaders, name) ? { load: loaders[name] } : undefined),
};
