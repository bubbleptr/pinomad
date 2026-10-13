# 使用说明：项目、工具与 MCP

从 README 移来的使用细节。安装和快速上手见 [README](../README.zh-CN.md)。

默认数据目录是 `~/.pinomad`（session.sqlite、token、目录锁），可用 `--data-dir` 或 `PINOMAD_DATA_DIR` 覆盖；同一数据目录同时只能有一个宿主进程。

对话按项目组织（ADR-0007）：在客户端侧栏的 Projects 里点 Add project，从宿主的文件系统里挑一个目录——从宿主用户的家目录开始，用 Parent folder 返回上一级；选定后宿主把它登记为项目，并直接打开该项目的新对话草稿。也可以启动时用可重复的 `--project DIR` 登记；不选项目的对话归入 Chat。宿主启动时不再自动建对话，第一条消息发出时才新建。

Git 项目的对话默认在独立 worktree 里工作（ADR-0010）：宿主在 `<数据目录>/worktrees/<对话 id>` 检出项目仓库，分支是 `pinomad/<对话 id>-<随机>`，起点是创建时的 HEAD；项目的原目录不会被改动，改动留在分支上，由你自己 merge 或发 PR 合回。新建对话时勾选 "Work directly in project directory" 可以直接在项目目录里工作；非 Git 目录和还没有 commit 的仓库也直接使用项目目录。fork 会得到自己的 worktree，内容复制自父对话在 fork 那一刻的文件状态（已提交、未提交、未跟踪的都在，被 gitignore 的文件不复制）；子代理和所属对话共用一个 worktree。归档对话时干净的 worktree 目录会被删除（分支保留），有未提交改动的保留并提示。注意 worktree 是全新检出，`node_modules`、`.env` 这类被忽略文件不在里面，agent 需要时按 AGENTS.md 自行安装。如果移动或删除了数据目录，在仓库里跑一次 `git worktree prune` 清掉失效的登记。

Chat 对话在 `<数据目录>/chats/<对话 id>` 里工作。fork 和子代理的对话显示在所属对话下面。归档只是隐藏，移除项目也不会删除目录和对话。

对话标题：第一轮成功跑完后，宿主用自己的默认模型自动起一个名（顶层对话和 fork 都会，子代理保留委托时的任务名），只起一次、之后不再变。侧栏里会话行的 … 菜单点 Rename 可以手动改名——改名是永久的，自动起名不会再覆盖；没有"恢复自动起名"的操作。起名失败（没配模型、模型不可用、provider 报错）会静默跳过，标题仍是第一条消息。

消息可以带图片（Web / 桌面端）：粘贴、拖进输入框，或点输入框左侧 "+" 菜单里的 Add images… 选图；一条消息最多 4 张，新对话的第一条消息也可以只发图片。发送前客户端把每张图缩到长边 1568px、转成 JPEG（质量约 0.85，EXIF/GPS 一并丢弃）；不是图片文件、或一次超过 4 张会在客户端拦住，单张超过 5 MB 或格式不对由宿主拒绝。当前模型不收图片时入口变灰；已经附上的图不会被清掉，发出去宿主照收（模型端由上游换成占位文本）。图片以缩略图显示在消息里，点开看大图；运行失败时 Retry 会把原图一起重发。fork 线程面板的输入框和移动端暂时不能附图。

agent 用 read / write / edit / bash 工具，执行前不需要审批；拿不准方向时用 `ask_user_question` 向用户提 1–4 个带选项的问题，问题卡片显示在输入框上方，用户也可以不回卡片、直接在对话里回复（ADR-0011）。agent 还可以用 `subagent` 把一个自包含的任务交给子代理：子代理在自己的对话里从零开始（看不到父对话），和父对话共用同一个检出，同一轮里的多个子代理并发执行；它不能向用户提问，需要澄清时写进回答交回父代理；默认沿用父对话的模型和思考等级，也可以在调用时用 `model`（`provider/modelId`）和 `thinkingLevel` 指定。中止父对话会连带中止子代理。edit / write 的结果带 unified diff，渲染成 diff 而不是文本；对话标题栏的 Changes 按钮随时查看当前检出的全部改动（worktree 相对基线 commit，项目目录则是未提交的改动），busy 转空闲时自动刷新。agent 还有 `codemode`（ADR-0013）：写一段 JavaScript，在 QuickJS 沙箱里调用其他工具，只有脚本的输出进入上下文，适合并发读多个文件、先过滤大段 bash 输出再看、批量改文件，以及调用 MCP 工具。脚本里能调 read / bash / edit / write 和 MCP 工具，不能调 `ask_user_question`、`subagent` 和 `codemode` 自己；一次 codemode 调用在 Web 上是一张卡片，列出脚本、每次嵌套调用的状态和耗时（edit / write 的 diff 可以展开），以及脚本输出。嵌套调用不单独进 transcript，宿主崩溃时整段脚本按中断处理，已经执行的调用不会撤销。系统提示词会带上以下内容，每次请求都重新读取（ADR-0006）：

- AGENTS.md：`~/.agents/AGENTS.md`，以及从根目录到 cwd 沿途的 AGENTS.md / CLAUDE.md；
- Skills：`<cwd>/.agents/skills` 和 `~/.agents/skills`，同名时项目的生效。

具名 Agent（ADR-0023）是宿主级的可复用角色配置：每个具名 Agent 一个 Markdown 文件，放在 `<数据目录>/agents/<名字>.md`（默认 `~/.pinomad/agents/`，跟着 `--data-dir` / `PINOMAD_DATA_DIR` 走），文件是 YAML frontmatter 加提示词正文：

```markdown
---
description: "审代码改动"
model: "anthropic/claude-opus-4"
thinkingLevel: "high"
---

你是严格的代码审阅者……
```

`description` 必填（模型靠它判断什么时候用，最长 1024 字符）；`model`（`provider/modelId`）和 `thinkingLevel` 选填；正文是提示词，可以为空；frontmatter 里不能有其他字段。名字就是去掉 `.md` 的文件名：只能是小写字母、数字和连字符（不能以连字符开头结尾），最长 32 字符。

`subagent` 工具多一个可选的 `role` 参数，主模型可以把任务派给某个具名 Agent；系统提示词的 `agent_roles` 小节会列出所有可用的名字和描述。定义里写了 `model` / `thinkingLevel` 的就以定义为准，调用时再传这两个参数直接报错；没写的可以照常传，不传就沿用父对话；定义里钉的模型不可用时报错，不回落。消息里写 `@name` 时，主模型会把相关工作派给对应的具名 Agent——宿主不做专门处理，固定规则就写在 `agent_roles` 小节里。具名 Agent 的提示词接在固定的子代理说明后面；派出那一刻抄一份进子代理自己的状态，之后再改或删文件都不影响已有的子代理。

文件改动立即生效：宿主监视 `agents/` 目录，新建、手改、删除都会在下一轮提示词里体现，并即时推给所有在线客户端。解析不了或不合规的文件不会被当成具名 Agent——可用的名字里没有它，错误原因随 `agents` 列表一起给出。

MCP server 在 `~/.agents/mcp.json` 里配置（ADR-0012），格式是各家客户端通用的 `mcpServers`：

```json
{
  "mcpServers": {
    "docs": { "command": "npx", "args": ["-y", "@example/docs-mcp"] },
    "github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } },
    "browser": { "command": "npx", "args": ["-y", "@playwright/mcp"], "exposure": "direct", "description": "Drive a browser" },
    "local": { "command": "my-mcp-server", "env": { "KEY": "${MY_KEY}" }, "enabled": false }
  }
}
```

stdio server 写 `command`（可选 `args`、`env`、`cwd`——相对的 cwd 按主目录解析）；HTTP server 写 `url`（可选 `headers`）。`env` 和 `headers` 的值可以用 `${NAME}` 引用宿主进程的环境变量。`timeout`（秒，默认 60）是单次工具调用的超时；`enabled: false` 保留配置但不连接。每个 server 在宿主里只连一份、所有对话共用；工具名是 `mcp__<server>__<tool>`。`exposure` 决定模型怎么够到它们（ADR-0013）：默认 `codemode`，工具不声明给模型，只能在 codemode 脚本里调用，模型用 `searchTools` / `describeNamespace` 找到它们，server 连上前后工具声明不变；写 `"direct"` 则同时直接声明给模型，结果里的图片显示在工具卡片里。`description`（可选）是给模型看的一句话说明，列在系统提示词里；不写时只列 server 名和工具数，server 自带的 instructions 由 `describeNamespace` 返回。右侧状态面板的 MCP 区列出每个 server 的状态、工具数和错误，以及配置错误（比如引用了一个不存在的环境变量）。配置只在启动时读一次，改动后重启宿主生效（常驻模式用 `bun run service -- restart`）。暂不支持：项目级 `mcp.json`、OAuth 登录（server 回 401 会在状态里提示）、resources / prompts、`deferred` / `tool_search`。

宿主设置在侧栏底部的 Settings 对话框里（ADR-0021）：新建对话的默认模型和思考等级、busy 时 steer / follow-up 消息排队后的投递方式、已存储的登录（可以登出），以及只读的 MCP 配置和宿主数据目录。设置写在宿主数据目录的 `settings.json`（默认 `~/.pinomad/settings.json`），文件里只保存改过的键；没设过的回落到 pi 的 `~/.pi/agent/settings.json`，再回落到内置默认。任一设备改了，所有在线设备立刻看到新值。宿主运行时只有宿主自己写这个文件——要手动编辑请在宿主停止后进行。登录凭据仍共用 pi 的 `~/.pi/agent/auth.json`，登录用 Pi CLI 完成；在这里登出会同时把本机的 Pi CLI 登出。
