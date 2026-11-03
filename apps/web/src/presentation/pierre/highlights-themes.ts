// Stands in for `@pierre/highlights/themes/loader` (vite.config.ts): the diff
// renderer only asks for Pierre's default light and dark themes, so the build
// ships those two instead of the whole Zed theme catalog.
export const themes = {
  "pierre-light": () => import("@pierre/highlights/themes/pierre-light"),
  "pierre-dark": () => import("@pierre/highlights/themes/pierre-dark"),
};
