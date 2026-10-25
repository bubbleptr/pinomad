import type { Lang } from "@/lib/i18n.ts";

// Screenshots live in apps/site/shots/<lang>/, each as a 2x original and a 1x
// copy named `<name>-<width>`; the page picks one through srcset.
const urls = import.meta.glob<string>("../../shots/**/*.webp", { query: "?url", import: "default", eager: true });

function url(lang: Lang, file: string): string {
  const value = urls[`../../shots/${lang}/${file}.webp`];
  if (value === undefined) throw new Error(`missing screenshot: shots/${lang}/${file}.webp`);
  return value;
}

export function shot(lang: Lang, name: string, small: number, large: number) {
  return { src: url(lang, name), srcSet: `${url(lang, `${name}-${small}`)} ${small}w, ${url(lang, name)} ${large}w` };
}
