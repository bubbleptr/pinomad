import type { Lang } from "../lib/i18n.ts";

const ORIGIN = "https://pinomad.si";
const REPOSITORY = "https://github.com/bubbleptr/pinomad";

const copy = {
  en: {
    title: "PiNomad — the durable coding agent for your own machine",
    description:
      "PiNomad is a self-hosted coding agent built on Pi Durable. It checkpoints every model and tool call, so a crash or restart picks up where it stopped; the Mac app, the web client, and the iPhone app all attach to the same runs.",
    social:
      "Runs on your machine and checkpoints every model and tool call; the Mac app, the web client, and the iPhone app all attach to the same runs.",
    locale: "en_US",
    altLocale: "zh_CN",
  },
  zh: {
    title: "PiNomad — 崩溃重启也不丢进度的 coding agent",
    description:
      "PiNomad 是基于 Pi Durable 的自托管 coding agent，跑在你自己的机器上。每一步模型和工具调用都会存下检查点，崩溃或重启后从断处接着跑；Mac、Web 和 iPhone 客户端连向同一个宿主，随时接手正在跑的任务。",
    social:
      "跑在你自己的机器上，每一步模型和工具调用都存检查点；Mac、Web 和 iPhone 客户端连向同一个宿主，随时接手正在跑的任务。",
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
