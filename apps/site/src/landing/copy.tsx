import type { ReactNode } from "react";
import type { Lang } from "@/lib/i18n.ts";

// Every word on the landing page, once per language. Both languages share one
// shape, so a section added to one and missed in the other fails the typecheck.
// Feature claims follow the docs' features page.

type Shot = "worktree" | "question" | "subagents";

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
    chips: { name: string; text: string }[];
    caption: string;
  };
  durable: {
    eyebrow: string;
    title: string;
    lead: string;
    description: string;
    model: string;
    crash: string;
    resume: string;
    start: string;
    pull: string;
    again: string;
    idle: string;
    running: string;
    crashed: string;
    resumed: (flag: number) => string;
    restartedEmpty: string;
    done: string;
    doneClean: string;
  };
  features: {
    eyebrow: string;
    title: string;
    lead: string;
    rows: { shot: Shot; title: string; body: ReactNode; alt: string }[];
    moreTitle: string;
    more: { term: string; body: ReactNode }[];
  };
  clients: {
    eyebrow: string;
    title: string;
    items: { name: string; body: ReactNode; tag?: string }[];
  };
  quickStart: {
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
  };
  closing: { title: string; lead: string; start: string; star: string; starNote: string };
  footer: { sign: string; nav: string; docs: string; license: string };
}

const models = ["Anthropic", "OpenAI", "Google", "DeepSeek", "xAI", "Mistral"];

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
      lead: "Start a task at your desk, then check on it or steer it from your phone. Devices pair with a one-time QR code and talk to the host over an end-to-end encrypted channel.",
      chips: [
        { name: "Direct", text: " over your LAN or tailnet" },
        { name: "Relay", text: " that only sees ciphertext" },
      ],
      caption: "Screenshot coming: the same run on iPhone.",
    },
    durable: {
      eyebrow: "Durable runs",
      title: "Runs survive crashes and restarts",
      lead: "Pi Durable writes a checkpoint after every model call and tool call. After a restart the run continues from the last one; only the call that was in flight runs again.",
      description:
        "A run drawn as a track of model and tool calls. Each finished call plants a flag. The host crashes between two calls; after the restart the run continues from the last flag, and only the half-finished call is redone.",
      model: "model",
      crash: "host crashes",
      resume: "picks up at this flag",
      start: "Start a run",
      pull: "Pull the plug",
      again: "Run it again",
      idle: "Start a run, then pull the plug while it's going.",
      running: "Running. Each finished call plants a flag: a checkpoint.",
      crashed: "The host is gone. Only the half-finished call is lost.",
      resumed: (flag) => `Restarted. Picking up from flag ${flag}.`,
      restartedEmpty: "Restarted. No flag yet, so it starts from the top.",
      done: "Done. No call behind a flag ran twice.",
      doneClean: "Done. Next time, pull the plug while it runs.",
    },
    features: {
      eyebrow: "Features",
      title: "What the agent can do",
      lead: "The agent has pi's four tools (read, bash, edit, write), plus:",
      rows: [
        {
          shot: "worktree",
          title: "A worktree for every conversation",
          body: "In a Git repo each conversation works in its own worktree and branch, so your checkout stays untouched.",
          alt: "The slugkit project's conversations in the sidebar. The open one has read, written and edited files and run the tests, and the line under its composer shows it works in its own Git worktree on a pinomad branch",
        },
        {
          shot: "question",
          title: "Questions, not approvals",
          body: "Tools run without approval prompts. When the direction is unclear, the agent asks one to four multiple-choice questions.",
          alt: "A question card from the agent: what to call the command, slugkit or slug, and whether to read titles from arguments or also from stdin, each with a box for a custom answer",
        },
        {
          shot: "subagents",
          title: "Subagents and named agents",
          body: (
            <>
              Hand self-contained tasks to subagents that run in parallel, or delegate to a reusable role with an <code>@name</code> mention, optionally pinning its model and thinking level.
            </>
          ),
          alt: "One turn running three subagents: German titles is done, Vietnamese titles is still running a script, and the @reviewer agent is checking the fold map for collisions",
        },
      ],
      moreTitle: "And also",
      more: [
        { term: "Forks", body: "Branch off from a message and keep both lines going." },
        {
          term: "codemode",
          body: "The model writes JavaScript that calls other tools in a QuickJS sandbox; only the script's output enters the context.",
        },
        {
          term: "MCP",
          body: (
            <>
              Servers configured in <code>~/.agents/mcp.json</code>, in the usual <code>mcpServers</code> format.
            </>
          ),
        },
        { term: "Images", body: "Paste, drop, or pick up to 4 images per message in the web and desktop composer." },
        {
          term: "AGENTS.md and skills",
          body: (
            <>
              Reads <code>AGENTS.md</code> / <code>CLAUDE.md</code> and skills from <code>~/.agents</code> and the
              project, on every request.
            </>
          ),
        },
      ],
    },
    clients: {
      eyebrow: "Clients",
      title: "Pick up the same run anywhere",
      items: [
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
    },
    quickStart: {
      eyebrow: "Quick start",
      title: "Install, start the host, open a client",
      lead: "The host needs Node 25+ on macOS or Linux.",
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
    },
    closing: {
      title: "Start a run. Walk away.",
      lead: "Free and open source. It runs on your hardware, with your model credentials.",
      start: "Get started",
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
      lead: "在电脑前派好活，出门拿手机看进度，方向偏了随时插话调整。新设备扫一次性二维码就能完成配对，和宿主之间全程走端到端加密的安全通道。",
      chips: [
        { name: "直连", text: "：局域网或 tailnet" },
        { name: "中继", text: "：只转发密文" },
      ],
      caption: "截图待补：在 iPhone 上接着看同一个任务。",
    },
    durable: {
      eyebrow: "断点续跑",
      title: "步步存检查点，重启不用从头来",
      lead: "每完成一次模型调用或工具调用，Pi Durable 都会存下检查点。宿主重启后直接从最近一个检查点恢复，只有中断时没跑完的那一步需要重跑。",
      description:
        "示意图：一条任务路线串联起多次模型调用和工具调用，每完成一步就插一面旗。宿主在两步中途崩溃，重启后直接从上一面旗恢复，只重做中断的那一步。",
      model: "模型",
      crash: "宿主崩溃",
      resume: "从这面旗接着跑",
      start: "开始运行",
      pull: "拔掉电源",
      again: "再来一次",
      idle: "点「开始运行」，趁它跑到半路把电源拔了。",
      running: "正在跑。每完成一步插一面旗，代表存了一个检查点。",
      crashed: "宿主挂了。只有卡在半路的那一步作废。",
      resumed: (flag) => `宿主重启，直接从第 ${flag} 面旗接着跑。`,
      restartedEmpty: "宿主重启。还没来得及插旗，这次从头跑。",
      done: "跑完了，插过旗的步骤一步都没重跑。",
      doneClean: "跑完了。再试一次，趁它在跑时拔掉电源看看。",
    },
    features: {
      eyebrow: "功能",
      title: "agent 能做什么",
      lead: "除了和 pi 一样的 read、bash、edit、write 四个基础工具，还支持：",
      rows: [
        {
          shot: "worktree",
          title: "每个对话独立一个 worktree",
          body: "在 Git 项目里，每个对话都在独立的 worktree 和分支上改代码，多个任务并行互不干扰，也不会动到你手头正在改的目录。",
          alt: "左侧是 slugkit 项目下的多条对话。当前对话已经完成读写文件和跑测试，输入框底部显示它运行在独立的 Git worktree 和 pinomad/ 分支上",
        },
        {
          shot: "question",
          title: "提问代替审批",
          body: "调工具不弹确认框，不用一路点允许。遇到需要你拿主意的地方，agent 会列 1–4 道选择题让你拍板。",
          alt: "agent 发出的提问卡片：询问命令该叫 slugkit 还是 slug、是否支持从标准输入读取标题，每道题除了现成选项也可以自己填答案",
        },
        {
          shot: "subagents",
          title: "子代理和具名 Agent",
          body: (
            <>
              独立的活可以拆给多个子代理并行去跑；也可以配置带专属提示词、模型和思考等级的具名 Agent，用 <code>@名字</code> 直接点名派活。
            </>
          ),
          alt: "同一轮里并行跑着三个子代理：德语标题已完成，越南语标题还在跑脚本，@reviewer 正在检查转换表里有没有冲突",
        },
      ],
      moreTitle: "还有这些",
      more: [
        { term: "Fork", body: "从任意一条消息分出新对话，继承此前上下文，两条线各自往下聊。" },
        { term: "codemode", body: "模型写 JavaScript 在 QuickJS 沙箱里组合调用其他工具，只把最终输出放进上下文。" },
        {
          term: "MCP",
          body: (
            <>
              在 <code>~/.agents/mcp.json</code> 里按通用的 <code>mcpServers</code> 格式配好就能用。
            </>
          ),
        },
        { term: "图片", body: "Web 和桌面端输入框支持直接粘贴、拖入或选图，单条消息最多附带 4 张。" },
        {
          term: "AGENTS.md 和 skills",
          body: (
            <>
              每次请求都会读取 <code>~/.agents</code> 和项目目录下的 <code>AGENTS.md</code>、<code>CLAUDE.md</code> 与 skills。
            </>
          ),
        },
      ],
    },
    clients: {
      eyebrow: "客户端",
      title: "同一个任务，在哪都能接着看",
      items: [
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
    },
    quickStart: {
      eyebrow: "快速上手",
      title: "三条命令跑起来",
      lead: "宿主需要 Node 25+，支持 macOS 和 Linux。",
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
    },
    closing: {
      title: "派好活，放手让它跑。",
      lead: "免费开源。跑在你自己的机器上，用你自己的模型账号。",
      start: "开始使用",
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
