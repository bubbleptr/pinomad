import type { Lang } from "@/lib/i18n.ts";
import landingCss from "./landing.css?url";
import { landingHead } from "./meta.ts";

/**
 * Head tags for the landing routes. Kept out of landing.tsx so route configs
 * don't pull the whole landing bundle into every page's preload graph.
 */
export function landingRouteHead(lang: Lang, softwareVersion?: string) {
  const head = landingHead(lang, softwareVersion);
  return { ...head, links: [...head.links, { rel: "stylesheet", href: landingCss }] };
}
