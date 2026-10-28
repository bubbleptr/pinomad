import type { Lang } from "../lib/i18n.ts";

const ORIGIN = "https://pinomad.si";

const copy = {
  en: {
    title: "PiNomad — open-source, self-hosted coding agent you can steer from anywhere",
    description:
      "PiNomad is an open-source, self-hosted coding agent. It runs on your own Mac or Linux machine, and you follow and steer it from the Mac app, the browser, or your iPhone. Built on Pi Durable, so a crash or restart resumes the run.",
    social:
      "Run the coding agent on your own machine and steer it from the Mac app, the browser, or your iPhone. Every model and tool call is checkpointed.",
    locale: "en_US",
    altLocale: "zh_CN",
  },
  zh: {
    title: "PiNomad — 开源自托管的 coding agent，人在哪都能接手",
    description:
      "PiNomad 是开源、自托管的 coding agent，跑在你自己的 Mac 或 Linux 上，用 Mac App、浏览器或 iPhone 随时查看和接手正在跑的任务。基于 Pi Durable，每次模型和工具调用都存检查点，崩溃重启后从断处接着跑。",
    social:
      "coding agent 跑在你自己的机器上，用 Mac App、浏览器或 iPhone 随时接手；每次模型和工具调用都存检查点。",
    locale: "zh_CN",
    altLocale: "en_US",
  },
} as const;

export function landingHead(lang: Lang) {
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
    ],
    links: [
      { rel: "canonical", href: url },
      { rel: "alternate", hrefLang: "en", href: `${ORIGIN}/` },
      { rel: "alternate", hrefLang: "zh-CN", href: `${ORIGIN}/zh/` },
      { rel: "alternate", hrefLang: "x-default", href: `${ORIGIN}/` },
    ],
  };
}
