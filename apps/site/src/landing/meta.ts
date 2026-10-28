import type { Lang } from "../lib/i18n.ts";

const ORIGIN = "https://pinomad.si";
const REPOSITORY = "https://github.com/bubbleptr/pinomad";

const copy = {
  en: {
    title: "PiNomad — open-source, self-hosted coding agent that goes where you go",
    description:
      "PiNomad is an open-source, self-hosted coding agent. It runs on your own Mac or Linux machine, and you follow and steer it from the Mac app, the browser, or your iPhone. Built on Pi Durable, so a crash or restart resumes the run.",
    social:
      "Run the coding agent on your own machine and steer it from the Mac app, the browser, or your iPhone. Every model and tool call is checkpointed.",
    locale: "en_US",
    altLocale: "zh_CN",
  },
  zh: {
    title: "PiNomad — 开源自托管 coding agent，在哪都能接手",
    description:
      "PiNomad 是开源、自托管的 coding agent，跑在你的 Mac 或 Linux 上，Mac App、浏览器、iPhone 随时接手。基于 Pi Durable，崩溃重启也从断处接着跑。",
    social: "跑在你机器上、在哪都能接手的开源 coding agent，崩溃重启也从断处接着跑。",
    locale: "zh_CN",
    altLocale: "en_US",
  },
} as const;

/**
 * Structured data for the product landing pages. TanStack Router renders a
 * `script:ld+json` entry as a data block, not executable JavaScript; csp.ts
 * skips non-JS script types when collecting hashes.
 */
function softwareApplication(lang: Lang, softwareVersion?: string) {
  const url = lang === "zh" ? `${ORIGIN}/zh/` : `${ORIGIN}/`;
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "PiNomad",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux",
    license: "https://www.apache.org/licenses/LICENSE-2.0",
    codeRepository: REPOSITORY,
    url,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    ...(softwareVersion ? { softwareVersion } : {}),
  };
}

export function landingHead(lang: Lang, softwareVersion?: string) {
  const c = copy[lang];
  const url = lang === "zh" ? `${ORIGIN}/zh/` : `${ORIGIN}/`;
  return {
    meta: [
      { title: c.title },
      { name: "description", content: c.description },
      { name: "theme-color", content: "#0f1011" },
      { name: "color-scheme", content: "dark" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "PiNomad" },
      { property: "og:locale", content: c.locale },
      { property: "og:locale:alternate", content: c.altLocale },
      { property: "og:url", content: url },
      { property: "og:title", content: c.title },
      { property: "og:description", content: c.social },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: c.title },
      { name: "twitter:description", content: c.social },
      { "script:ld+json": softwareApplication(lang, softwareVersion) },
    ],
    links: [
      { rel: "canonical", href: url },
      { rel: "alternate", hrefLang: "en", href: `${ORIGIN}/` },
      { rel: "alternate", hrefLang: "zh-CN", href: `${ORIGIN}/zh/` },
      { rel: "alternate", hrefLang: "x-default", href: `${ORIGIN}/` },
    ],
  };
}
