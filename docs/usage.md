# 使用说明：项目、工具与 MCP

从 README 移来的使用细节。安装和快速上手见 [README](../README.zh-CN.md)。

默认数据目录是 `~/.pinomad`（session.sqlite、token、目录锁），可用 `--data-dir` 或 `PINOMAD_DATA_DIR` 覆盖；同一数据目录同时只能有一个宿主进程。

对话按项目组织（ADR-0007）：在客户端侧栏点 Add project 登记一个宿主上的目录，也可以启动时用可重复的 `--project DIR` 登记；不选项目的对话归入 Chat。宿主启动时不再自动建对话，第一条消息发出时才新建。

Git 项目的对话默认在独立 worktree 里工作（ADR-0010）：宿主在 `<数据目录>/worktrees/<对话 id>` 检出项目仓库，分支是 `pinomad/<对话 id>-<随机>`，起点是创建时的 HEAD；项目的原目录不会被改动，改动留在分支上，由你自己 merge 或发 PR 合回。新建对话时勾选 "Work directly in project directory" 可以直接在项目目录里工作；非 Git 目录和还没有 commit 的仓库也直接使用项目目录。fork 会得到自己的 worktree，内容复制自父对话在 fork 那一刻的文件状态（已提交、未提交、未跟踪的都在，被 gitignore 的文件不复制）；子代理和所属对话共用一个 worktree。归档对话时干净的 worktree 目录会被删除（分支保留），有未提交改动的保留并提示。注意 worktree 是全新检出，`node_modules`、`.env` 这类被忽略文件不在里面，agent 需要时按 AGENTS.md 自行安装。如果移动或删除了数据目录，在仓库里跑一次 `git worktree prune` 清掉失效的登记。

Chat 对话在 `<数据目录>/chats/<对话 id>` 里工作。fork 和子代理的对话显示在所属对话下面。归档只是隐藏，移除项目也不会删除目录和对话。

agent 用 read / write / edit / bash 工具，执行前不需要审批；拿不准方向时用 `ask_user_question` 向用户提 1–4 个带选项的问题，问题卡片显示在输入框上方，用户也可以不回卡片、直接在对话里回复（ADR-0011）。agent 还可以用 `subagent` 把一个自包含的任务交给子代理：子代理在自己的对话里从零开始（看不到父对话），和父对话共用同一个检出，同一轮里的多个子代理并发执行；它不能向用户提问，需要澄清时写进回答交回父代理；默认沿用父对话的模型和思考等级，也可以在调用时用 `model`（`provider/modelId`）和 `thinkingLevel` 指定。中止父对话会连带中止子代理。edit / write 的结果带 unified diff，渲染成 diff 而不是文本；对话标题栏的 Changes 按钮随时查看当前检出的全部改动（worktree 相对基线 commit，项目目录则是未提交的改动），busy 转空闲时自动刷新。agent 还有 `codemode`（ADR-0013）：写一段 JavaScript，在 QuickJS 沙箱里调用其他工具，只有脚本的输出进入上下文，适合并发读多个文件、先过滤大段 bash 输出再看、批量改文件，以及调用 MCP 工具。脚本里能调 read / bash / edit / write 和 MCP 工具，不能调 `ask_user_question`、`subagent` 和 `codemode` 自己；一次 codemode 调用在 Web 上是一张卡片，列出脚本、每次嵌套调用的状态和耗时（edit / write 的 diff 可以展开），以及脚本输出。嵌套调用不单独进 transcript，宿主崩溃时整段脚本按中断处理，已经执行的调用不会撤销。系统提示词会带上以下内容，每次请求都重新读取（ADR-0006）：

- AGENTS.md：`~/.agents/AGENTS.md`，以及从根目录到 cwd 沿途的 AGENTS.md / CLAUDE.md；
- Skills：`<cwd>/.agents/skills` 和 `~/.agents/skills`，同名时项目的生效。

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
