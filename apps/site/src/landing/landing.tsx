import { useEffect } from "react";
import type { Lang } from "@/lib/i18n.ts";
import en from "./en.html?raw";
import { initLanding } from "./interactions.js";
import landingCss from "./landing.css?url";
import { landingHead } from "./meta.ts";
import zh from "./zh.html?raw";

// The landing page is hand-written HTML (one file per language), carried over
// as-is. Illustrations shared by both languages live once under partials/ and
// are written `<!-- include name.svg -->`; screenshots and the shared app icon
// are referenced by path and resolved to hashed asset URLs here.
const partials = import.meta.glob<string>("../../partials/*", { query: "?raw", import: "default", eager: true });
const assets = import.meta.glob<string>(["../../shots/**/*.webp", "../../../web/public/favicon.svg"], {
  query: "?url",
  import: "default",
  eager: true,
});

function lookup<T>(table: Record<string, T>, key: string): T {
  const value = table[key];
  if (value === undefined) throw new Error(`landing page references a missing file: ${key}`);
  return value;
}

function resolve(html: string): string {
  return html
    .replace(/<!-- include ([\w./-]+) -->/g, (_, name: string) => lookup(partials, `../../partials/${name}`).trim())
    .replace(/(?:\.\.?\/)shots\/([\w/.-]+)/g, (_, path: string) => lookup(assets, `../../shots/${path}`))
    .replace(/@brand\/([\w.-]+)/g, (_, name: string) => lookup(assets, `../../../web/public/${name}`));
}

const pages: Record<Lang, string> = { en: resolve(en), zh: resolve(zh) };

export function landingRouteHead(lang: Lang) {
  const head = landingHead(lang);
  return { ...head, links: [...head.links, { rel: "stylesheet", href: landingCss }] };
}

export function Landing({ lang }: { lang: Lang }) {
  useEffect(() => {
    initLanding();
  }, []);
  return <div className="landing" dangerouslySetInnerHTML={{ __html: pages[lang] }} />;
}
