import type { ReactNode } from "react";
import type { Lang } from "@/lib/i18n.ts";

// Every word on the landing page, once per language. Both languages share one
// shape, so a section added to one and missed in the other fails the typecheck.
// What ships today is written as a feature; what's planned stays in `next`,
// labelled as planned and linked to its issue (#364 has the selling points).

type Link = { text: string; href: string };

/** Provider marks drawn by page.css as `.sub-logo.is-<name>` masks. */
export type SubLogo = "claude" | "openai" | "copilot" | "grok" | "kimi" | "ollama";

export interface LandingCopy {
  skip: string;
  home: string;
  primaryNav: string;
  hero: {
    title: ReactNode;
    lead: string;
    start: string;
    github: string;
    modelsLabel: string;
    models: string[];
    modelsMore: string;
    shotAlt: string;
  };
  anywhere: {
    eyebrow: string;
    title: string;
    lead: string;
    clients: string[];
    shotAlt: string;
  };
  core: {
    eyebrow: string;
    title: string;
    allFeatures: string;
  };
  subs: {
    eyebrow: string;
    title: string;
    plans: { logo: SubLogo; name: string; note: string }[];
  };
  durable: {
    title: string;
    body: string;
    description: string;
    plain: string;
    durable: string;
    steps: { tool: string; detail: string }[];
  };
  agents: {
    eyebrow: string;
    title: string;
    lead: string;
    roles: { name: string; job: string }[];
    blog: string;
    shotAlt: string;
    diagram: { label: string };
  };
  connection: {
    eyebrow: string;
    title: string;
    lead: string;
    chips: { name: string; text: string }[];
    more: Link;
    diagram: { label: string; host: string; relay: string };
  };
  next: {
    eyebrow: string;
    title: string;
    lead: string;
    items: { title: string; body: string; link: Link }[];
    diagram: { label: string; host: string; machines: string[] };
  };
  start: {
    eyebrow: string;
    title: string;
    lead: string;
    notes: ReactNode[];
    terminal: string;
    copy: string;
    copied: string;
    copyFailed: string;
    hostComment: string;
    linkComment: string;
    clientsTitle: string;
    clients: { name: string; body: ReactNode; tag?: string }[];
    latest: (version: string, date: string) => string;
    changelog: string;
    star: string;
    starNote: string;
  };
  footer: { sign: string; nav: string; docs: string; license: string };
}

const models = ["Anthropic", "OpenAI", "Google", "DeepSeek", "xAI", "Mistral"];
const issue = (n: number) => `https://github.com/bubbleptr/pinomad/issues/${n}`;
const adr4 = "https://github.com/bubbleptr/pinomad/blob/main/docs/adr/0004-built-in-first-plugin-protocol-later.md";
const blogPost = "https://kieran.build/zh/blog/indie-dev-weekly-03/";

export const blogUrl = blogPost;

export const copy: Record<Lang, LandingCopy> = {
  en: {
    skip: "Skip to content",
    home: "PiNomad home",
    primaryNav: "Primary",
    hero: {
      title: "The open-source coding agent that goes where you go.",
      lead: "It runs on your own Mac or Linux machine; pick up any run from the Mac app, the browser, or your iPhone. Built on Pi Durable, it checkpoints every model and tool call, so a crash or restart resumes the run instead of starting over.",
      start: "Get started",
      github: "View on GitHub",
      modelsLabel: "Use any model pi supports",
      models: [...models, "Qwen", "Kimi", "Z.AI", "MiniMax", "OpenRouter", "GitHub Copilot"],
      modelsMore: "17 more",
      shotAlt:
        "The PiNomad web client mid-run: the slugkit project's conversations in the sidebar; the agent has folded accented letters in slugs, been asked to document the rules in the README, edited it, and is running the tests again",
    },
    anywhere: {
      eyebrow: "Any screen",
      title: "Start at your desk, decide from your phone",
      lead: "Start a task, then walk away. When the agent needs a decision, it asks one to four multiple-choice questions and waits; the iPhone app notifies you when a run is waiting for you, finished, or failed. Tap through to answer, send a message to steer the run, or queue the next one.",
      clients: ["Mac app", "Web", "iPhone"],
      shotAlt:
        "The same run in the PiNomad iPhone app: the agent's summary of the accent folding, the README request below it, and the run still going at the bottom with a stop button",
    },
    core: {
      eyebrow: "How it works",
      title: "Built on Pi Durable",
      allFeatures: "Everything the agent can do",
    },
    subs: {
      eyebrow: "Models",
      title: "Bring your own subscription",
      plans: [
        { logo: "claude", name: "Claude", note: "Pro · Max" },
        { logo: "openai", name: "ChatGPT", note: "Plus · Pro" },
        { logo: "copilot", name: "GitHub Copilot", note: "Subscription" },
        { logo: "grok", name: "Grok", note: "SuperGrok · X Premium" },
        { logo: "kimi", name: "Kimi", note: "Kimi Code" },
        { logo: "ollama", name: "Your endpoint", note: "Ollama · vLLM · LM Studio" },
      ],
    },
    durable: {
      title: "Runs survive crashes and restarts",
      body: "Pi Durable writes a checkpoint after every model call and tool call. After a restart the run continues from the last one; only the call that was in flight runs again.",
      description:
        "The same task run twice, with and without checkpoints. Three calls finish, then the host crashes during the fourth. After the restart, the run without checkpoints has lost all three and starts over from step 1. The Pi Durable run still has them, reruns only the call that was cut off, and finishes.",
      plain: "Without checkpoints",
      durable: "With Pi Durable",
      steps: [
        { tool: "model", detail: "plan the fix" },
        { tool: "bash", detail: "bun test" },
        { tool: "edit", detail: "src/auth.ts" },
        { tool: "bash", detail: "bun test" },
        { tool: "model", detail: "write it up" },
      ],
    },
    agents: {
      eyebrow: "Named agents",
      title: "Give each role its own agent",
      lead: "Define a role once, with its own prompt, model, and thinking level, then hand it work with an @mention or as a subagent. Split the work the way a small team would:",
      roles: [
        { name: "Planner", job: "designs the change with you" },
        { name: "Worker", job: "writes the code" },
        { name: "Critic", job: "argues against protocol and design changes" },
        { name: "Writer", job: "polishes the copy" },
      ],
      blog: "How the author splits a week's work across five named agents (in Chinese)",
      shotAlt:
        "One turn running three subagents: German titles is done, Vietnamese titles is still running a script, and the @reviewer agent is checking the fold map for collisions",
      diagram: {
        label:
          "You design the change with @planner, which hands the work to one or more @worker agents, @critic, and @writer, each with its own prompt, model, and thinking level.",
      },
    },
    connection: {
      eyebrow: "Connection",
      title: "Reach your host from anywhere, privately",
      lead: "Pair a device once with a one-time QR code. Everything after that is end-to-end encrypted with Noise: it goes peer-to-peer when the network allows, and otherwise through a relay that only ever sees ciphertext. Revoke any device from the host.",
      chips: [
        { name: "P2P", text: " over your LAN, tailnet, or the public internet" },
        { name: "Relay", text: " that only sees ciphertext" },
      ],
      more: { text: "How pairing, P2P, and the relay work", href: "/docs/#connect-your-other-devices" },
      diagram: {
        label:
          "A device pairs with the host once by scanning its QR code. After that the two talk end-to-end encrypted, directly over WebRTC when the network allows, otherwise through a relay that only forwards ciphertext.",
        host: "Host",
        relay: "Relay",
      },
    },
    next: {
      eyebrow: "Coming next",
      title: "Where PiNomad is heading",
      lead: "None of this ships yet. Each item links to the issue where it's planned.",
      items: [
        {
          title: "One host, many execution environments",
          body: "Keep the host on your main machine and point a project at a Windows, macOS, Linux, or Android machine. The model thinks on the host; the tools run on the other machine over SSH, through pi-env.",
          link: { text: "#363", href: issue(363) },
        },
        {
          title: "Hosts working together",
          body: "One client connected to several hosts, and an agent that hands parts of a task to agents on other machines.",
          link: { text: "#148", href: issue(148) },
        },
        {
          title: "An open plugin protocol",
          body: "PiNomad's own features already use the extension protocol. Once it settles, it opens up, and anyone can write plugins that add tools and new ways to present results.",
          link: { text: "ADR-0004", href: adr4 },
        },
      ],
      diagram: {
        label:
          "Planned: the host keeps running the model and reaches Windows, macOS, Linux, and Android machines over SSH through pi-env; the tools run on those machines.",
        host: "Host",
        machines: ["Windows", "macOS", "Linux", "Android"],
      },
    },
    start: {
      eyebrow: "Get started",
      title: "Install, start the host, open a client",
      lead: "Free and open source under Apache-2.0. The host needs Node 25+ on macOS or Linux.",
      notes: [
        "Then sign in to a model provider under Settings → Providers: a subscription you already pay for, an API key, or your own compatible endpoint.",
        "It's an early version, and things still change between releases.",
      ],
      terminal: "Terminal",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed",
      hostComment: "# starts the host on this machine",
      linkComment: "# in another terminal: prints a web client link",
      clientsTitle: "Clients",
      clients: [
        {
          name: "Web",
          body: (
            <>
              Your host serves it: <code>pinomad link</code> prints the link. Any modern browser.
            </>
          ),
        },
        {
          name: "macOS",
          body: (
            <>
              Signed DMG from <a href="https://github.com/bubbleptr/pinomad/releases">GitHub Releases</a>; updates
              itself.
            </>
          ),
          tag: "Apple silicon",
        },
        { name: "iOS", body: "Pairs with your host by scanning a one-time QR code.", tag: "Internal TestFlight only for now" },
        { name: "Linux, Windows", body: "Use the web client." },
      ],
      latest: (version, date) => `Latest release: ${version}, ${date}`,
      changelog: "Changelog",
      star: "Star on GitHub",
      starNote: "If PiNomad is useful to you, a star helps other people find it.",
    },
    footer: {
      sign: "PiNomad is open source under the Apache-2.0 license.",
      nav: "Footer",
      docs: "Docs",
      license: "License",
    },
  },
  zh: {
    skip: "跳到正文",
    home: "PiNomad 首页",
    primaryNav: "主导航",
    hero: {
      title: (
        <>
          <span className="nowrap">跑在你机器上、</span>
          <span className="nowrap">在哪都能接手的</span> <span className="nowrap">开源 coding agent</span>
        </>
      ),
      lead: "Mac App、浏览器、iPhone 都能随时接手正在跑的任务。基于 Pi Durable，每次模型和工具调用都存检查点，崩溃重启也从断处接着跑。",
      start: "开始使用",
      github: "在 GitHub 上查看",
      modelsLabel: "pi 支持的模型都能用",
      models: [...models, "通义千问", "Kimi", "智谱 Z.AI", "MiniMax", "OpenRouter", "GitHub Copilot"],
      modelsMore: "另有 17 家",
      shotAlt: "PiNomad Web 客户端运行画面：左侧是 slugkit 项目的对话列表；agent 改好了重音字母的折叠，又被要求在 README 里写明规则，改完 README 后正在重跑测试",
    },
    anywhere: {
      eyebrow: "多端接力",
      title: "在电脑前派活，出门用手机拍板",
      lead: "派完活就能走开。要你拍板时，agent 会出几道选择题等你回答；任务等你、跑完或失败，iPhone 都会推送。点开就能回答，也能中途插话或排下一条。",
      clients: ["Mac App", "Web", "iPhone"],
      shotAlt: "同一个任务在 PiNomad iPhone App 里：上面是 agent 对重音字母折叠的总结，下面是写 README 的追问，最底下任务还在跑，旁边是停止按钮",
    },
    core: {
      eyebrow: "工作方式",
      title: "基于 Pi Durable",
      allFeatures: "agent 能做的所有事",
    },
    subs: {
      eyebrow: "模型",
      title: "用你已经付费的订阅",
      plans: [
        { logo: "claude", name: "Claude", note: "Pro · Max" },
        { logo: "openai", name: "ChatGPT", note: "Plus · Pro" },
        { logo: "copilot", name: "GitHub Copilot", note: "订阅" },
        { logo: "grok", name: "Grok", note: "SuperGrok · X Premium" },
        { logo: "kimi", name: "Kimi", note: "Kimi Code" },
        { logo: "ollama", name: "自己的 endpoint", note: "Ollama · vLLM · LM Studio" },
      ],
    },
    durable: {
      title: "步步存检查点，重启不用从头来",
      body: "Pi Durable 在每次模型和工具调用后存检查点。宿主重启后从最近的检查点恢复，只重跑被打断的那一步。",
      description:
        "同一个任务跑两遍，一边没有检查点，一边用 Pi Durable。前三步跑完，第四步跑到一半宿主崩溃。重启后，没有检查点的那边三步全丢，从第一步重来；Pi Durable 这边三步都还在，只重跑被打断的那一步，然后跑完。",
      plain: "没有检查点",
      durable: "用 Pi Durable",
      steps: [
        { tool: "模型", detail: "定修复方案" },
        { tool: "bash", detail: "bun test" },
        { tool: "edit", detail: "src/auth.ts" },
        { tool: "bash", detail: "bun test" },
        { tool: "模型", detail: "写总结" },
      ],
    },
    agents: {
      eyebrow: "具名 Agent",
      title: "每个角色交给一个专属 agent",
      lead: "每个角色有自己的提示词、模型和思考等级，用 @名字 或子代理派活，像小团队一样分工：",
      roles: [
        { name: "Planner", job: "和你一起定方案" },
        { name: "Worker", job: "写代码" },
        { name: "Critic", job: "对协议和设计改动做对抗审查" },
        { name: "Writer", job: "润色文案" },
      ],
      blog: "看作者一周的开发记录：五个具名 Agent 怎么分工",
      shotAlt: "同一轮里并行跑着三个子代理：德语标题已完成，越南语标题还在跑脚本，@reviewer 正在检查转换表里有没有冲突",
      diagram: {
        label: "你和 @planner 一起定方案，@planner 再把活分给一个或多个 @worker、@critic 和 @writer；每个 agent 都有自己的提示词、模型和思考等级。",
      },
    },
    connection: {
      eyebrow: "连接",
      title: "在哪都能连上宿主，内容只有你看得到",
      lead: "扫一次二维码完成配对，之后全程 Noise 端到端加密。能直连就走 P2P，不通再经中继，中继只看得到密文。设备可以随时吊销。",
      chips: [
        { name: "P2P", text: "（直连）：局域网、tailnet 或公网" },
        { name: "中继", text: "：只转发密文" },
      ],
      more: { text: "配对、P2P 和中继的细节", href: "/zh/docs/remote-access/" },
      diagram: {
        label: "设备扫一次宿主的二维码完成配对。之后两者之间端到端加密：网络允许时走 WebRTC 直连，否则经中继转发，中继只转发密文。",
        host: "宿主",
        relay: "中继",
      },
    },
    next: {
      eyebrow: "接下来",
      title: "PiNomad 接下来要做的",
      lead: "以下都还没上线，每项链到对应的 issue。",
      items: [
        {
          title: "一台宿主，多个执行环境",
          body: "宿主留在主力机上，项目指向另一台 Windows、macOS、Linux 或 Android 机器：模型在宿主上思考，工具经 pi-env 用 SSH 在那台机器上执行。",
          link: { text: "#363", href: issue(363) },
        },
        {
          title: "多台宿主协作",
          body: "一个客户端同时连多台宿主，再由一个 agent 把任务拆给其他机器上的 agent。",
          link: { text: "#148", href: issue(148) },
        },
        {
          title: "开放插件协议",
          body: "PiNomad 自己的功能就是用这套扩展协议写的，稳定后对外开放，谁都能写插件加工具和展示方式。",
          link: { text: "ADR-0004", href: adr4 },
        },
      ],
      diagram: {
        label: "规划中：模型继续跑在宿主上，宿主通过 pi-env 用 SSH 连到 Windows、macOS、Linux 和 Android 机器，工具在这些机器上执行。",
        host: "宿主",
        machines: ["Windows", "macOS", "Linux", "Android"],
      },
    },
    start: {
      eyebrow: "开始使用",
      title: "三条命令跑起来",
      lead: "免费开源，Apache-2.0 许可。宿主需要 Node 25+，支持 macOS 和 Linux。",
      notes: [
        "然后在 Settings → Providers 接入模型：已有订阅、API key 或兼容 endpoint 都行。",
        "目前是早期版本，版本之间还会有变化。",
      ],
      terminal: "终端",
      copy: "复制",
      copied: "已复制",
      copyFailed: "复制失败",
      hostComment: "# 在本机启动宿主",
      linkComment: "# 另开一个终端，打印 Web 客户端链接",
      clientsTitle: "客户端",
      clients: [
        {
          name: "Web",
          body: (
            <>
              宿主自带，运行 <code>pinomad link</code> 打印链接，现代浏览器即开即用。
            </>
          ),
        },
        {
          name: "macOS",
          body: (
            <>
              从 <a href="https://github.com/bubbleptr/pinomad/releases">GitHub Releases</a> 下载已签名的 DMG，自动更新。
            </>
          ),
          tag: "Apple 芯片",
        },
        { name: "iOS", body: "扫宿主的一次性二维码配对。", tag: "目前仅限 TestFlight 内测" },
        { name: "Linux、Windows", body: "直接使用 Web 客户端。" },
      ],
      latest: (version, date) => `最新版本：${version}，${date}`,
      changelog: "更新日志",
      star: "在 GitHub 上 Star",
      starNote: "如果 PiNomad 对你有用，点颗 Star 能帮更多人发现它。",
    },
    footer: {
      sign: "PiNomad 基于 Apache-2.0 许可证开源。",
      nav: "页脚",
      docs: "文档",
      license: "许可证",
    },
  },
};
