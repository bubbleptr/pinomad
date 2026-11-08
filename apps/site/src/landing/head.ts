import type { Lang } from "@/lib/i18n.ts";
import serifFont from "../styles/fonts/GeistSerifVF.woff2?url";
import landingCss from "./landing.css?url";
import { landingHead } from "./meta.ts";

/**
 * Head tags for the landing routes. Kept out of landing.tsx so route configs
 * don't pull the whole landing bundle into every page's preload graph.
 */
export function landingRouteHead(lang: Lang, softwareVersion?: string) {
  const head = landingHead(lang, softwareVersion);
  return {
    ...head,
    links: [
      ...head.links,
      // The headline face: preloaded so the first screen doesn't reflow when it swaps in.
      { rel: "preload", href: serifFont, as: "font", type: "font/woff2", crossOrigin: "anonymous" as const },
      { rel: "stylesheet", href: landingCss },
    ],
  };
}
