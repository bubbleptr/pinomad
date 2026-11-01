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
    title: ReactNode;
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
    more: Link;
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
  footer: { sign: string; nav: string; docs: string; license: string; privacy: string; terms: string };
}

const models = ["Anthropic", "OpenAI", "Google", "DeepSeek", "xAI", "Mistral"];
const issue = (n: number) => `https://github.com/bubbleptr/pinomad/issues/${n}`;
const adr4 = "https://github.com/bubbleptr/pinomad/blob/main/docs/adr/0004-built-in-first-plugin-protocol-later.md";
const blogPost = "https://kieran.build/zh/blog/indie-dev-weekly-03/";

export const blogUrl = blogPost;

export const copy: Record<Lang, LandingCopy> = {
  en: {
    skip: "Skip to content",
    hero: {
      title: (
        <>
          <span className="line">The durable coding agent,</span> <span className="line">reachable from anywhere.</span>
        </>
      ),
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
      title: "Reach your agent from anywhere, end-to-end encrypted",
      lead: "Scan a one-time QR code to pair a device and establish a Noise end-to-end encrypted channel. Devices connect directly over WebRTC P2P (LAN, tailnet, or public internet) and fall back to a ciphertext-only relay when NAT gets in the way. Revoke any device at any time.",
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
          body: "Keep the host on your main machine and point a project at a Windows, macOS, Linux, or Android machine over SSH. The model plans on the host; shell and file tools run on the other machine.",
          link: { text: "#363", href: issue(363) },
        },
        {
          title: "Hosts working together",
          body: "One client connected to several hosts, and an agent that hands parts of a task to agents on other machines.",
          link: { text: "#148", href: issue(148) },
        },
        {
          title: "An open plugin protocol",
          body: "Write plugins that add custom tools and structured result cards, rendered the same way in the web, Mac, and iPhone clients.",
          link: { text: "Design decision", href: adr4 },
        },
      ],
      diagram: {
        label:
          "Planned: the host keeps running the model and reaches Windows, macOS, Linux, and Android machines over SSH; the tools run on those machines.",
        host: "Host",
        machines: ["Windows", "macOS", "Linux", "Android"],
      },
    },
    start: {
      eyebrow: "Get started",
      title: "Install, start the host, open a client",
      lead: "Free and open source under Apache-2.0. The host runs on macOS or Linux; the install script brings its own Node.",
      notes: [
        <>
          Sign in with your Claude, ChatGPT, or Copilot subscription, an API key, or a local Ollama or vLLM endpoint under
          Settings → Providers. Ready to keep it running? <code>pinomad service install</code> registers the host as a
          background LaunchAgent on macOS or a systemd service on Linux.
        </>,
      ],
      more: { text: "Full setup guide and service options", href: "/docs/" },
      terminal: "Terminal",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed",
      hostComment: "# starts the host on your machine",
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
      privacy: "Privacy",
      terms: "Terms",
    },
  },
  zh: {
    skip: "跳到正文",
    hero: {
      title: (
        <>
          <span className="line">
            <span className="nowrap">持久可靠的</span>
            <span className="nowrap">编码智能体，</span>
          </span>
          <span className="line">随时随地都能连上</span>
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
      title: (
        <>
          <span className="nowrap">在哪都能连上</span>
          <span className="nowrap">你的 agent，</span>
          <span className="nowrap">全程端到端加密</span>
        </>
      ),
      lead: "扫一次二维码即可完成设备公钥配对，建立基于 Noise 协议的端到端加密通道。客户端优先走 WebRTC 点对点直连（支持局域网、Tailscale 或公网打洞）；遇到复杂网络自动回落到只转发密文的中继。设备权限随时可以吊销。",
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
          body: "宿主留在主力机上，把项目通过 SSH 指向另一台 Windows、macOS、Linux 或 Android 机器：模型在宿主上思考，读写文件和执行命令都在那台机器上。",
          link: { text: "#363", href: issue(363) },
        },
        {
          title: "多台宿主协作",
          body: "一个客户端同时连多台宿主，再由一个 agent 把任务拆给其他机器上的 agent。",
          link: { text: "#148", href: issue(148) },
        },
        {
          title: "开放插件协议",
          body: "对外开放插件协议，谁都能写插件，添加自定义工具和结构化的结果卡片，在 Web、Mac 和 iPhone 上统一渲染。",
          link: { text: "设计决策", href: adr4 },
        },
      ],
      diagram: {
        label: "规划中：模型继续跑在宿主上，宿主用 SSH 连到 Windows、macOS、Linux 和 Android 机器，工具在这些机器上执行。",
        host: "宿主",
        machines: ["Windows", "macOS", "Linux", "Android"],
      },
    },
    start: {
      eyebrow: "开始使用",
      title: "三条命令跑起来",
      lead: "免费开源，Apache-2.0 许可。宿主支持 macOS 和 Linux，安装脚本自带 Node。",
      notes: [
        <>
          打开客户端后，在 Settings → Providers 登录已有的 Claude / ChatGPT / Copilot 订阅，或填入 API Key、本地
          Ollama / vLLM 端点。需要常驻后台时，运行 <code>pinomad service install</code> 即可注册为 macOS LaunchAgent 或
          Linux systemd 服务。
        </>,
      ],
      more: { text: "查看完整上手指南与常驻服务配置", href: "/zh/docs/" },
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
      privacy: "隐私政策",
      terms: "服务条款",
    },
  },
};
