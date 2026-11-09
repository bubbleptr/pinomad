import type { ReactNode } from "react";
import type { Lang } from "@/lib/i18n.ts";

// Every word on the landing page, once per language. Both languages share one
// shape, so a section added to one and missed in the other fails the typecheck.
// What ships today is written as a feature; what's planned stays in `next`,
// labelled as planned and linked to its issue (#364 has the selling points).

type Link = { text: string; href: string };

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
    /** Spec pairs under the call to action, set like a colour swatch's HEX / CMYK lines. */
    specs: { label: string; value: string }[];
  };
  anywhere: {
    eyebrow: string;
    title: string;
    lead: string;
    /** The three moments the phone shows, as buttons that switch it. */
    steps: [string, string];
    shotAlt: string;
  };
  core: {
    eyebrow: string;
    title: string;
    allFeatures: string;
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
    upComment: string;
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
        "The PiNomad Mac app with two machines in its sidebar. On macbook-pro, @planner has split currency support for the iOS and web clients between two @worker agents and a @critic, each on its own model; on omarchy, the API is filling in a currency for old bills. In front, the @critic's own conversation is open in a browser.",

      specs: [
        { label: "Host", value: "macOS · Linux" },
        { label: "Clients", value: "Mac · Web · iPhone" },
        { label: "License", value: "Apache-2.0" },
      ],
    },
    anywhere: {
      eyebrow: "Away from your desk",
      title: "Your computer at home is your cloud machine",
      lead: "The code and the agent stay on your computer at home; your phone is a screen onto it. From anywhere you can start a task, answer the agent's questions, or step in mid-run, then go through what changed, line by line, before you decide what's next.",
      steps: ["Start a task", "Answer"],
      shotAlt:
        "The PiNomad iPhone app at the step chosen beside it: a task sent from the phone to omarchy, or the push notification over the list of machines and then the agent's question about old bills.",
    },
    core: {
      eyebrow: "How it works",
      title: "Built on Pi Durable",
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
      title: "Install the host and add it to your account",
      lead: "Free and open source under Apache-2.0. The host runs on macOS or Linux; the install script brings its own Node.",
      notes: [
        <>
          On a new Mac the script asks you to run <code>pinomad up</code> in a new terminal window.{" "}
          <code>pinomad up</code> prints a code. Enter it at app.pinomad.si, signed in to your account (sign-up is by
          invite), and the host joins your account and keeps running as a service. Sign in on your other devices and
          they connect on their own, then add your Claude, ChatGPT, or Copilot subscription, an API key, or a local
          Ollama or vLLM endpoint under Settings → Providers.
        </>,
      ],
      more: { text: "Full setup guide, or use it without an account", href: "/docs/" },
      terminal: "Terminal",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed",
      upComment: "# joins your account",
      clientsTitle: "Clients",
      clients: [
        {
          name: "Web",
          body: (
            <>
              Sign in at app.pinomad.si in any modern browser. Your host serves it too: <code>pinomad link</code>.
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
        { name: "iOS", body: "Sign in and it pairs with your hosts on its own.", tag: "Internal TestFlight only for now" },
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
      shotAlt: "PiNomad Mac App，侧栏里有两台机器：macbook-pro 上 @planner 把 iOS 和 Web 的多币种支持分给了两个 @worker 和一个 @critic，各用各的模型；omarchy 上服务端正在给旧账单回填币种。前面的浏览器里打开的是 @critic 自己的对话。",
      specs: [
        { label: "宿主", value: "macOS · Linux" },
        { label: "客户端", value: "Mac · Web · iPhone" },
        { label: "许可", value: "Apache-2.0" },
      ],
    },
    anywhere: {
      eyebrow: "出门在外",
      title: "家里的电脑，就是你随身的云主机",
      lead: "代码和 agent 都留在家里的电脑上，手机只是连上去的一块屏幕。出门在外照样能派活、回答 agent 的提问、中途插话；跑完了在手机上看改了哪些文件，逐行看完 diff 再决定下一步。",
      steps: ["派活", "拍板"],
      shotAlt: "PiNomad iPhone App，显示旁边选中的那一步：从手机发给 omarchy 的任务，或者机器列表上弹出的推送，接着是 agent 关于旧账单的提问。",
    },
    core: {
      eyebrow: "工作方式",
      title: "基于 Pi Durable",
      allFeatures: "agent 能做的所有事",
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
      title: "两行命令装好宿主",
      lead: "免费开源，Apache-2.0 许可。宿主支持 macOS 和 Linux，安装脚本自带 Node。",
      notes: [
        <>
          新 Mac 上脚本会提示在新的终端窗口里跑 <code>pinomad up</code>。<code>pinomad up</code> 会打印一个短码，登录 app.pinomad.si
          输入它（注册要邀请码），宿主就加入了你的账号，并作为服务常驻运行。其他设备登录同一个账号就会自动连上；再到 Settings
          → Providers 登录已有的 Claude / ChatGPT / Copilot 订阅，或填入 API Key、本地 Ollama / vLLM 端点。
        </>,
      ],
      more: { text: "查看完整上手指南，以及不用账号的用法", href: "/zh/docs/" },
      terminal: "终端",
      copy: "复制",
      copied: "已复制",
      copyFailed: "复制失败",
      upComment: "# 加入账号",
      clientsTitle: "客户端",
      clients: [
        {
          name: "Web",
          body: (
            <>
              现代浏览器打开 app.pinomad.si 登录即可；宿主自己也提供，运行 <code>pinomad link</code>。
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
        { name: "iOS", body: "登录后自动配对账号下的宿主。", tag: "目前仅限 TestFlight 内测" },
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
