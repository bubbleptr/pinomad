import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    // Pages are prerendered as <path>/index.html, which Cloudflare Pages serves at
    // <path>/ and redirects to from <path>; keep links on the canonical form.
    trailingSlash: "always",
    defaultPreload: "intent",
  });
}
