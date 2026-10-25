import { createRouter, useLocation } from "@tanstack/react-router";
import { NotFound } from "./components/not-found.tsx";
import { langOf } from "./lib/i18n.ts";
import { routeTree } from "./routeTree.gen";

function RouteNotFound() {
  return <NotFound lang={langOf(useLocation({ select: (l) => l.pathname }))} />;
}

export function getRouter() {
  return createRouter({
    routeTree,
    // Pages are prerendered as <path>/index.html, which Cloudflare Pages serves at
    // <path>/ and redirects to from <path>; keep links on the canonical form.
    trailingSlash: "always",
    defaultPreload: "intent",
    defaultNotFoundComponent: RouteNotFound,
  });
}
