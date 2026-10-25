import type { Lang } from "../lib/i18n.ts";

const ORIGIN = "https://pinomad.si";

const copy = {
  en: {
    title: "PiNomad — the durable coding agent for your own machine",
    description:
      "PiNomad is a self-hosted coding agent built on Pi Durable. It checkpoints every model and tool call, so a crash or restart picks up where it stopped; the Mac app, the web client, and the iPhone app all attach to the same runs.",
    social:
      "Runs on your machine and checkpoints every model and tool call; the Mac app, the web client, and the iPhone app all attach to the same runs.",
    imageAlt:
      "One PiNomad run in the web client: conversations in the sidebar, the agent mid-run with thinking and tool calls",
    locale: "en_US",
    altLocale: "zh_CN",
  },
  zh: {
    title: "PiNomad — 崩溃重启也不丢进度的 coding agent",
    description:
      "PiNomad 是基于 Pi Durable 的自托管 coding agent，跑在你自己的机器上。每一步模型和工具调用都会存下检查点，崩溃或重启后从断处接着跑；Mac、Web 和 iPhone 客户端连向同一个宿主，随时接手正在跑的任务。",
    social:
      "跑在你自己的机器上，每一步模型和工具调用都存检查点；Mac、Web 和 iPhone 客户端连向同一个宿主，随时接手正在跑的任务。",
    imageAlt: "PiNomad Web 客户端运行画面：左侧是对话列表，右侧 agent 正在思考并调用工具",
    locale: "zh_CN",
    altLocale: "en_US",
  },
} as const;

export function landingHead(lang: Lang) {
  const c = copy[lang];
  const url = lang === "zh" ? `${ORIGIN}/zh/` : `${ORIGIN}/`;
  const image = `${ORIGIN}/og-image.jpg`;
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
      { property: "og:image", content: image },
      { property: "og:image:width", content: "1920" },
      { property: "og:image:height", content: "1200" },
      { property: "og:image:alt", content: c.imageAlt },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: c.title },
      { name: "twitter:description", content: c.social },
      { name: "twitter:image", content: image },
    ],
    links: [
      { rel: "canonical", href: url },
      { rel: "alternate", hrefLang: "en", href: `${ORIGIN}/` },
      { rel: "alternate", hrefLang: "zh-CN", href: `${ORIGIN}/zh/` },
      { rel: "alternate", hrefLang: "x-default", href: `${ORIGIN}/` },
    ],
  };
}
