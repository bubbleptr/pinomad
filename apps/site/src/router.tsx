import { createRouter, useLocation } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { langOf } from "./lib/i18n.ts";
import { routeTree } from "./routeTree.gen";

// The default 404 is only reached by client-side navigation. Keeping it out of
// the entry means the docs shell (and its styles) aren't preloaded on every
// page; the chunk loads when a missing route actually renders.
const NotFound = lazy(() => import("./components/not-found.tsx").then((module) => ({ default: module.NotFound })));

function RouteNotFound() {
  return (
    <Suspense fallback={null}>
      <NotFound lang={langOf(useLocation({ select: (l) => l.pathname }))} />
    </Suspense>
  );
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
