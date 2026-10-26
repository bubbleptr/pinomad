import type { ReactNode } from "react";
import type { Lang } from "@/lib/i18n.ts";

// Every word on the landing page, once per language. Both languages share one
// shape, so a section added to one and missed in the other fails the typecheck.
// What ships today is written as a feature; what's planned stays in `next`,
// labelled as planned and linked to its issue (#364 has the selling points).

type Link = { text: string; href: string };

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
    placeholder: string;
  };
  core: {
    eyebrow: string;
    title: string;
    machine: { title: string; body: string; placeholder: string };
    allFeatures: string;
  };
  durable: {
    title: string;
    body: string;
    description: string;
    plain: string;
    durable: string;
    steps: { tool: string; detail: string }[];
    tags: { lost: string; kept: string; cut: string; rerun: string };
    restartPlain: string;
    restartDurable: string;
    host: { up: string; down: string };
    replay: string;
    status: { running: string; crashed: string; restarted: string; done: string };
  };
  agents: {
    eyebrow: string;
    title: string;
    lead: string;
    roles: { name: string; job: string }[];
    blog: string;
    shotAlt: string;
    placeholder: string;
  };
  connection: {
    eyebrow: string;
    title: string;
    lead: string;
    chips: { name: string; text: string }[];
    placeholder: string;
  };
  next: {
    eyebrow: string;
    title: string;
    lead: string;
    items: { title: string; body: string; link: Link }[];
    placeholder: string;
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
      title: "The durable coding agent for your own machine.",
      lead: "PiNomad runs on your machine, with that machine's shell and repos, and checkpoints every model and tool call. If the host crashes or restarts, the run picks up where it stopped. The Mac app, the web client, and the iPhone app all attach to the same runs.",
      start: "Get started",
      github: "View on GitHub",
      modelsLabel: "Use any model pi supports",
      models: [...models, "Qwen", "Kimi", "Z.AI", "MiniMax", "OpenRouter", "GitHub Copilot"],
      modelsMore: "17 more",
      shotAlt:
        "The PiNomad web client mid-run: conversations in the sidebar; the agent has answered, been asked for more, and is now reading and editing files and running commands",
    },
    anywhere: {
      eyebrow: "Any screen",
      title: "Step away from your desk",
      lead: "Start a task at your desk, then check on it or steer it from your phone. The Mac app, the web client, and the iPhone app attach to the same runs.",
      clients: ["Mac app", "Web", "iPhone"],
      placeholder: "Screenshot coming: the same run on iPhone.",
    },
    core: {
      eyebrow: "How it works",
      title: "Runs on your machine, survives crashes, follows you around",
      machine: {
        title: "Your machine does the work",
        body: "The host runs on a Mac mini, a Linux box, or a VPS, and the agent uses that machine's shell, repositories, and credentials.",
        placeholder: "Diagram coming: the host on your own machine.",
      },
      allFeatures: "Everything the agent can do",
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
      tags: { lost: "lost", kept: "kept", cut: "cut off", rerun: "rerun" },
      restartPlain: "Restarted · back to step 1",
      restartDurable: "Restarted · picks up at step 4",
      host: { up: "Host running", down: "Host crashed" },
      replay: "Replay",
      status: {
        running: "Same task, two runs.",
        crashed: "The host crashes during the fourth call.",
        restarted: "Back up. One run lost everything; Pi Durable kept the three finished calls.",
        done: "Pi Durable is done, rerunning only the call that was cut off. The other run is still redoing step 2.",
      },
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
      placeholder: "Diagram coming: a planner handing work to workers, a critic, and a writer.",
    },
    connection: {
      eyebrow: "Connection",
      title: "Reach your host from anywhere, privately",
      lead: "Pair a device by scanning a one-time QR code. From then on it talks to the host over an end-to-end encrypted channel.",
      chips: [
        { name: "Direct", text: " over your LAN or tailnet" },
        { name: "Relay", text: " that only sees ciphertext" },
      ],
      placeholder: "Diagram coming: a device, the encrypted channel, and the host.",
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
          title: "More ways to connect",
          body: "Peer-to-peer connections alongside the relay, and a built-in Tailscale network.",
          link: { text: "#345", href: issue(345) },
        },
        {
          title: "An open plugin protocol",
          body: "Built-in features are already written against the same extension boundary. Once it settles, the protocol opens to plugins from anyone.",
          link: { text: "ADR-0004", href: adr4 },
        },
      ],
      placeholder: "Diagram coming: one host driving Windows, macOS, Linux, and Android machines.",
    },
    start: {
      eyebrow: "Get started",
      title: "Install, start the host, open a client",
      lead: "Free and open source under Apache-2.0. The host needs Node 25+ on macOS or Linux.",
      notes: [
        <>
          <code>pinomad host</code> uses the models and credentials you set up in pi (<code>~/.pi/agent</code>).
          Haven't set up pi yet? <code>pinomad host --faux "hi"</code> runs a scripted fake model so you can click
          around.
        </>,
        "It's early. Pi Durable is itself experimental, and the host and its clients must speak the same protocol major version.",
      ],
      terminal: "Terminal",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed",
      hostComment: "# uses the models and credentials set up in pi",
      linkComment: "# in another terminal: prints a web client link",
      clientsTitle: "Clients",
      clients: [
        {
          name: "Web",
          body: (
            <>
              Open <a href="https://app.pinomad.si">app.pinomad.si</a>, or the web client your host serves itself (
              <code>pinomad link</code>). Any modern browser.
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
          <span className="nowrap">崩溃重启也不丢进度的</span> <span className="nowrap">coding agent</span>
        </>
      ),
      lead: "PiNomad 跑在你自己的机器上，直接调用本机的 shell 和代码。每一步模型和工具调用都会存下检查点，就算进程挂了或机器重启，也能从断处接着跑。Mac App、Web 和 iPhone App 连向同一个宿主，任务在哪都能随时接手。",
      start: "开始使用",
      github: "在 GitHub 上查看",
      modelsLabel: "pi 支持的模型都能用",
      models: [...models, "通义千问", "Kimi", "智谱 Z.AI", "MiniMax", "OpenRouter", "GitHub Copilot"],
      modelsMore: "另有 17 家",
      shotAlt: "PiNomad Web 客户端运行画面：左侧是对话列表，agent 答完上一轮后，正顺着追问改测试、跑测试",
    },
    anywhere: {
      eyebrow: "多端接力",
      title: "离开电脑也能接着管",
      lead: "在电脑前派好活，出门拿手机看进度，方向偏了随时插话调整。Mac App、Web 和 iPhone App 连的是同一批任务。",
      clients: ["Mac App", "Web", "iPhone"],
      placeholder: "截图待补：在 iPhone 上接着看同一个任务。",
    },
    core: {
      eyebrow: "工作方式",
      title: "跑在你的机器上，崩了能接着跑，走到哪跟到哪",
      machine: {
        title: "活在你自己的机器上干",
        body: "宿主可以跑在 Mac mini、Linux 主机或 VPS 上，agent 直接用那台机器的 shell、代码仓库和凭据。",
        placeholder: "示意图待补：宿主跑在你自己的机器上。",
      },
      allFeatures: "agent 能做的所有事",
    },
    durable: {
      title: "步步存检查点，重启不用从头来",
      body: "每完成一次模型调用或工具调用，Pi Durable 都会存下检查点。宿主重启后直接从最近一个检查点恢复，只有中断时没跑完的那一步需要重跑。",
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
      tags: { lost: "丢了", kept: "保留", cut: "被打断", rerun: "重跑" },
      restartPlain: "重启 · 回到第 1 步",
      restartDurable: "重启 · 从第 4 步接着跑",
      host: { up: "宿主运行中", down: "宿主崩溃" },
      replay: "再看一遍",
      status: {
        running: "同一个任务，跑两遍。",
        crashed: "第四步跑到一半，宿主崩溃。",
        restarted: "宿主重启。一边全丢了，Pi Durable 这边跑完的三步都在。",
        done: "Pi Durable 跑完了，只重跑了被打断的那一步；另一边还在重做第 2 步。",
      },
    },
    agents: {
      eyebrow: "具名 Agent",
      title: "每个角色交给一个专属 agent",
      lead: "把一个角色定义一次：提示词、模型、思考等级都是它自己的。之后用 @名字 或子代理派活给它，像一个小团队那样分工：",
      roles: [
        { name: "Planner", job: "和你一起定方案" },
        { name: "Worker", job: "写代码" },
        { name: "Critic", job: "对协议和设计改动做对抗审查" },
        { name: "Writer", job: "润色文案" },
      ],
      blog: "看作者一周的开发记录：五个具名 Agent 怎么分工",
      shotAlt: "同一轮里并行跑着三个子代理：德语标题已完成，越南语标题还在跑脚本，@reviewer 正在检查转换表里有没有冲突",
      placeholder: "示意图待补：Planner 把活分给 Worker、Critic 和 Writer。",
    },
    connection: {
      eyebrow: "连接",
      title: "在哪都能连上宿主，内容只有你看得到",
      lead: "新设备扫一次性二维码就能配对，之后和宿主之间全程走端到端加密的通道。",
      chips: [
        { name: "直连", text: "：局域网或 tailnet" },
        { name: "中继", text: "：只转发密文" },
      ],
      placeholder: "示意图待补：设备、加密通道和宿主。",
    },
    next: {
      eyebrow: "接下来",
      title: "PiNomad 接下来要做的",
      lead: "下面这些都还没上线，每一项都链到规划它的 issue。",
      items: [
        {
          title: "一台宿主，多个执行环境",
          body: "宿主留在你的主力机上，把项目指向一台 Windows、macOS、Linux 或 Android 机器：模型在宿主上思考，工具通过 SSH 在那台机器上执行，底层是 pi-env。",
          link: { text: "#363", href: issue(363) },
        },
        {
          title: "多台宿主协作",
          body: "一个客户端同时连多台宿主，再由一个 agent 把任务拆给其他机器上的 agent。",
          link: { text: "#148", href: issue(148) },
        },
        {
          title: "更多连接方式",
          body: "在中继之外加上 P2P 直连，以及内置的 Tailscale 网络。",
          link: { text: "#345", href: issue(345) },
        },
        {
          title: "开放插件协议",
          body: "内置功能已经按同一套扩展边界来写，等协议稳定后对外开放，谁都能写插件。",
          link: { text: "ADR-0004", href: adr4 },
        },
      ],
      placeholder: "示意图待补：一台宿主驱动 Windows、macOS、Linux 和 Android 机器。",
    },
    start: {
      eyebrow: "开始使用",
      title: "三条命令跑起来",
      lead: "免费开源，Apache-2.0 许可。宿主需要 Node 25+，支持 macOS 和 Linux。",
      notes: [
        <>
          <code>pinomad host</code> 会直接复用你在 pi（<code>~/.pi/agent</code>）里配好的模型和认证。还没配过
          pi？可以先跑 <code>pinomad host --faux "hi"</code>，用内置的模拟模型把界面点通试试。
        </>,
        "项目还在早期，底层的 Pi Durable 也处于实验阶段；升级时请保持宿主和客户端的协议主版本号一致。",
      ],
      terminal: "终端",
      copy: "复制",
      copied: "已复制",
      copyFailed: "复制失败",
      hostComment: "# 复用 pi 里配好的模型和认证",
      linkComment: "# 另开一个终端，打印 Web 客户端链接",
      clientsTitle: "客户端",
      clients: [
        {
          name: "Web",
          body: (
            <>
              直接打开 <a href="https://app.pinomad.si">app.pinomad.si</a>，或运行 <code>pinomad link</code> 打开宿主自带的 Web 客户端，现代浏览器即开即用。
            </>
          ),
        },
        {
          name: "macOS",
          body: (
            <>
              在 <a href="https://github.com/bubbleptr/pinomad/releases">GitHub Releases</a> 下载已签名的 DMG
              安装包，支持自动更新。
            </>
          ),
          tag: "Apple 芯片",
        },
        { name: "iOS", body: "扫一下宿主生成的一次性二维码即可完成配对。", tag: "目前仅限 TestFlight 内测" },
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
