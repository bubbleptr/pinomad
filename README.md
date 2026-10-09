# PiNomad

以 coding 为核心的 agent 产品，基于 [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable)。

- 自托管宿主：在你自己的机器（Mac mini、Linux VPS）上运行，直接使用本机的 shell 和代码仓库；执行可在崩溃或重启后恢复。
- 多端客户端：桌面、Web、移动端连接同一个宿主，界面由 PiNomad 统一定义。

架构决策见 [`docs/adr/`](docs/adr/README.md)，路线图见 [`docs/roadmap.md`](docs/roadmap.md)，术语见 [`CONTEXT.md`](CONTEXT.md)。

## 运行

安装只需要 Node 25+（宿主依赖 `node:sqlite`），不需要 Bun：

```sh
npm i -g pinomad

# 起宿主：真实模型需要先在 pi 里配好认证（读 ~/.pi/agent）；
# 没有认证可以用脚本化的假模型冒烟：
pinomad host --faux "hi"

# 打印带 token 的浏览器链接，打开即用（Web 客户端由宿主自己提供）：
pinomad link
```

### 开发 / 从源码运行

检出仓库，需要 Bun（装依赖、跑脚本）+ Node 25+：

```sh
bun install

bun run host -- --faux "hi"

# 另一个终端起 Web 客户端开发服务器（http://127.0.0.1:5199）：
bun run web
bun run link
```

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

## 远程访问（ADR-0008）

一条命令起全部（构建 Web、起宿主、起 vite），并在终端打印电脑浏览器链接和手机配对二维码：

```sh
bun run start
# 透传宿主参数：bun run start -- --faux "hi" --data-dir /tmp/demo
```

手机扫二维码即完成配对（Noise IK 端到端加密 + 设备登记）；二维码是一次性的，5 分钟过期，过期后用 `bun run pair` 重发一个。已登记的设备和吊销在 Web 侧栏的 Devices 里管理；吊销设备也可以在那直接点 Revoke。

<details><summary>手动/高级：分开跑各个进程</summary>

默认只监听 `127.0.0.1`。`--remote-port N` 另起一个监听所有网卡的安全通道端口，同端口用 HTTP 提供构建好的 Web 客户端（`apps/web/dist`，缺失时页面是 503）：

```sh
bun run build
bun run host -- --remote-port 7422
bun run web          # 电脑上的开发服务器 http://127.0.0.1:5199
bun run link         # 打印带 token 的浏览器链接
bun run pair         # 打印配对二维码（一次性，5 分钟过期）
# 走隧道/自建入口，或 LAN 地址探测选错网卡时用 --public-url 覆盖：
bun run host -- --remote-port 7422 --public-url https://pinomad.example.com
```

远程端口不接受 token：只有完成配对、公钥已登记在设备表里的客户端能连。

</details>

### 经自部署中继访问

宿主在家里局域网、手机在外面时，把中继跑在一台有公网地址的 VPS 上：宿主和手机都只往外连中继，中继按宿主身份把两端的连接接起来，只转发密文、不存东西；Web 客户端也由中继用 HTTPS 提供，手机扫二维码直接打开。

宿主这边：先打印中继身份（Ed25519 公钥，存在 `<dataDir>/relay-key`）：

```sh
pinomad relay-id [--data-dir DIR]        # 输出 hostId，把它加进中继的 --allow-host
pinomad host --relay https://relay.example.com
# 常驻：pinomad service install --relay https://relay.example.com
pinomad pair                             # 打出的二维码指向中继
```

VPS 这边：同一个包（只要 Node 25+）——中继和 Web 客户端来自同一个 `pinomad` 安装，版本天然一致：

```sh
npm i -g pinomad
pinomad relay --public-origin https://relay.example.com --allow-host <hostId>
# 默认只监听 127.0.0.1:7430，--port / --listen 可改；多台宿主就写多个 --allow-host
```

Caddy 终止 TLS（自动签证书，WebSocket 无需额外配置）：

```
relay.example.com {
  reverse_proxy 127.0.0.1:7430
}
```

systemd 单元示例（VPS 上的系统级单元；node 和包路径都用绝对路径，`command -v node` 和 `npm root -g` 查）：

```ini
[Unit]
Description=PiNomad relay
After=network-online.target

[Service]
User=pinomad
ExecStart=/usr/bin/node /usr/lib/node_modules/pinomad/dist/pinomad.js relay --public-origin https://relay.example.com --allow-host <hostId>
Restart=always

[Install]
WantedBy=multi-user.target
```

升级：中继托管的 Web 客户端和宿主版本不一致时，客户端会显示需要更新；两边一起升级——宿主 `pinomad upgrade`，VPS 上 `npm i -g pinomad@latest` 后重启中继。宿主不在中继的 `--allow-host` 里时，宿主日志和 Web 警告会带着要补的 `--allow-host <hostId>`。

npm 装的实例和本机任何开发检出互不相干（各自的数据目录、进程、包路径都独立），所以在同一台机器上开发 PiNomad 不会碰到正在跑的服务。

## 常驻运行（ADR-0009）

把宿主装成当前用户的系统服务（macOS 是 LaunchAgent，Linux 是 systemd 用户单元），开机自启、崩溃自动拉起（从源码检出跑时用 `bun run service -- …`，下同）：

```sh
pinomad service install [--data-dir DIR --port N --remote-port N --relay URL --project DIR …]
pinomad service status [--data-dir D] [--url U]
pinomad service restart [--force] [--data-dir D] [--url U]
pinomad service logs [--follow] [-n N] [--data-dir D]
pinomad service uninstall
pinomad upgrade [--force]
```

- `install` 把宿主参数原样写进服务定义；`--data-dir`（或 `PINOMAD_DATA_DIR`，默认 `~/.pinomad`）展开成显式的绝对路径。改参数就是带新参数再跑一次 `install`。装好后用 `pinomad link` 拿本机浏览器链接、`pinomad pair` 发手机配对码。
- **PATH 在安装时固定**：服务里 agent 的 bash 继承的是安装那一刻终端的 PATH（已经剥掉 `node_modules/.bin` 和 Bun 注入的临时目录）。后来装了新工具、PATH 变了，重新跑一次 `install` 刷新。
- `restart` 先连上宿主读任务图，有未结束的任务就等它们跑完再重启（Ctrl-C 取消）；`--force` 立即重启，交给 Durable 恢复。打包安装时 `upgrade` 把 `pinomad@latest` 装进运行包所在的 npm 全局前缀（非全局安装会拒绝执行）+ 同样的 restart；源码检出里（`bun run upgrade`）依次 `git pull --ff-only`、`bun install`、`bun run build`，工作区有未提交改动时拒绝执行。前面任何一步失败都直接停下，不重启，服务继续跑旧代码。
- `uninstall` 只卸载服务，不动数据目录。
- macOS：宿主以登录会话运行，机器重启后要能自动起来需在系统设置里打开自动登录，并为这台机器关掉睡眠。日志写到 `<数据目录>/logs/host.log`。
- Linux：要在未登录时也运行需自己执行 `loginctl enable-linger`（install 检测到没开会提示）；日志走 `journalctl --user`。
- 服务模式下**回环端口也用 HTTP 提供构建好的 Web 客户端**。`pinomad link` 打印的链接按顺序探测：正在跑的 vite 开发服务器（5199）优先；否则宿主自己提供 Web 的端口；都没有则仍是 5199。开发时 `bun run start` + vite 照旧。
- 服务在跑时 `bun run start` 会因为目录锁拿不到而失败（同一数据目录只有一个宿主）；开发时用另一个 `--data-dir`，或先 `uninstall`。

Windows 不在支持范围；其他平台跑 `service` 会直接报错退出。

## 验证

```sh
bun run typecheck
bun run test    # vitest + Playwright，首次跑前先 bunx playwright install chromium
bun run build
```
