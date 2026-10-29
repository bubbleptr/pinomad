---
title: 使用说明：项目、工具与 MCP
description: 项目、worktree、工具、具名 Agent、MCP、iOS 账号和推送通知的使用细节。
---

先装好宿主，见[快速上手](/zh/docs/)。

默认数据目录是 `~/.pinomad`（session.sqlite、token、目录锁），可用 `--data-dir` 或 `PINOMAD_DATA_DIR` 覆盖；同一数据目录同时只能有一个宿主进程。

对话按项目组织（ADR-0007）：在客户端侧栏的 Projects 里点 Add project，从宿主的文件系统里挑一个目录——分栏浏览，从宿主用户的家目录开始，点一个目录就选中它并在右边一栏列出子目录，底部路径栏可跳回任一级（包括 `/`），键盘方向键和输入名字开头也能走；点 Add project 后宿主把选中的目录登记为项目，并直接打开该项目的新对话草稿。也可以启动时用可重复的 `--project DIR` 登记；不选项目的对话归入 Chat。宿主启动时不再自动建对话，第一条消息发出时才新建。

Git 项目的对话默认在独立 worktree 里工作（ADR-0010）：宿主在 `<数据目录>/worktrees/<对话 id>` 检出项目仓库，分支是 `pinomad/<对话 id>-<随机>`，起点是创建时的 HEAD；项目的原目录不会被改动，改动留在分支上，由你自己 merge 或发 PR 合回。新建对话时勾选 "Work directly in project directory" 可以直接在项目目录里工作；非 Git 目录和还没有 commit 的仓库也直接使用项目目录。fork 会得到自己的 worktree，内容复制自父对话在 fork 那一刻的文件状态（已提交、未提交、未跟踪的都在，被 gitignore 的文件不复制）；子代理和所属对话共用一个 worktree。归档对话时干净的 worktree 目录会被删除（分支保留），有未提交改动的保留并提示。注意 worktree 是全新检出，`node_modules`、`.env` 这类被忽略文件不在里面，agent 需要时按 AGENTS.md 自行安装。如果移动或删除了数据目录，在仓库里跑一次 `git worktree prune` 清掉失效的登记。

Chat 对话在 `<数据目录>/chats/<对话 id>` 里工作。fork 和子代理的对话显示在所属对话下面。归档只是隐藏，移除项目也不会删除目录和对话。已归档的对话在 Settings → Archived 里列出（连同所属项目或 Chat），点 Restore 放回侧栏，fork 和子代理一起回来；归档时删掉的 worktree 会在下次运行时从保留的分支重新检出。已移除项目里的归档对话不列出，重新添加项目后才出现。

对话标题：第一轮成功跑完后，宿主用自己的默认模型自动起一个名（顶层对话和 fork 都会，子代理保留委托时的任务名），只起一次、之后不再变。侧栏里会话行的 … 菜单点 Rename 可以手动改名——改名是永久的，自动起名不会再覆盖；没有"恢复自动起名"的操作。起名失败（没配模型、模型不可用、provider 报错）会静默跳过，标题仍是第一条消息。

消息可以带图片（Web / 桌面端 / 移动端）：Web / 桌面端粘贴、拖进输入框，或点输入框左侧 "+" 菜单里的 Add images… 选图；移动端点 "+" 菜单里的"照片图库"（可多选）、"拍照"或"粘贴图片"（剪贴板没有图片时会提示）。一条消息最多 4 张，新对话的第一条消息也可以只发图片。发送前客户端把每张图缩到长边 1568px、转成 JPEG（质量约 0.85，EXIF/GPS 一并丢弃）；不是图片文件、或一次超过 4 张会在客户端拦住，单张超过 5 MB 或格式不对由宿主拒绝。当前模型不收图片时入口变灰；已经附上的图不会被清掉，发出去宿主照收（模型端由上游换成占位文本）。图片以缩略图显示在消息和工具卡片里，点开看大图（移动端点一下或下滑关闭）；滚到视口附近才向宿主取缩略图或预览图，点开大图时才取原图（旧宿主或派生图生成失败仍回原图），重连或重开对话不重传图片。运行失败时 Web / 桌面端的 Retry 会把原图一起重发。fork 线程面板的输入框暂时不能附图。

任意文件走 Attach files（协议 5.19，ADR-0030）：Web / 桌面端点 "+" 菜单里的 Attach files…，或把非图片文件拖进 / 粘贴进输入框。选中后立即分块上传到宿主的数据目录 `attachments/<id>/file/`，输入框上方显示文件名、大小和进度；失败的 chip 可以重试（从宿主已收到的位置续传），也可以移除。有文件还在上传时发送按钮禁用并显示 Uploading files…，Enter 也不发送；传完后用户再点发送，不带半截文件发出。一条消息最多 10 个文件，单个解码后最多 10 MiB；宿主的待用上传合计最多 20 个 / 200 MiB，未引用的上传 24 小时后清理，已被消息引用的永久保留。模型看到的是 `<attachments>` 块里的只读路径，需要修改时由模型自己复制到工作目录；气泡里显示文件 chip（名字 + 大小），不预览。图片仍走上面的图片路径；宿主低于 5.19 时没有入口，拖放非图片文件会提示升级宿主。附件以宿主上的绝对路径记录在消息里，所以数据目录不能搬家，备份要带上 `attachments/`。

agent 用 read / write / edit / bash 工具，执行前不需要审批；拿不准方向时用 `ask_user_question` 向用户提 1–4 个带选项的问题，问题卡片显示在输入框上方，用户也可以不回卡片、直接在对话里回复（ADR-0011）。agent 还可以用 `subagent` 把一个自包含的任务交给子代理：子代理在自己的对话里从零开始（看不到父对话），和父对话共用同一个检出，同一轮里的多个子代理并发执行；它不能向用户提问，需要澄清时写进回答交回父代理；默认沿用父对话的模型和思考等级，也可以在调用时用 `model`（`provider/modelId`）和 `thinkingLevel` 指定。中止父对话会连带中止子代理。edit / write 的结果带 unified diff，渲染成 diff 而不是文本；对话标题栏的 Overview 按钮打开一张浮在对话区右上角的概览卡片（从新对话页发出第一条消息时自动打开，窄屏除外）：项目对话的检出方式（Git worktree 或 Project folder）、工作目录、分支、改动行数（worktree 相对基线 commit，项目目录则是未提交的改动，每轮运行结束时刷新，点开看完整 diff）、上下文窗口用量和已花费的金额、运行中的子代理和 MCP 服务器状态。新对话页在输入框下方选择项目和检出方式。agent 还有 `codemode`（ADR-0013）：写一段 JavaScript，在 QuickJS 沙箱里调用其他工具，只有脚本的输出进入上下文，适合并发读多个文件、先过滤大段 bash 输出再看、批量改文件，以及调用 MCP 工具。脚本里能调 read / bash / edit / write 和 MCP 工具，不能调 `ask_user_question`、`subagent` 和 `codemode` 自己；一次 codemode 调用在 Web 上是一张卡片，列出脚本、每次嵌套调用的状态和耗时，以及脚本输出。嵌套调用不单独进 transcript；宿主崩溃或重启后脚本按确定性重放续跑，已完成的嵌套调用不会重跑，脚本分叉或超时过期才按失败收尾。系统提示词会带上以下内容，每次请求都重新读取（ADR-0006）：

- AGENTS.md：`~/.agents/AGENTS.md`，以及从根目录到 cwd 沿途的 AGENTS.md / CLAUDE.md；
- Skills：从 cwd 往上每一层的 `.agents/skills`，直到 git 根（不在 git 仓库里时只看 cwd），以及 `~/.agents/skills`；同名时离 cwd 越近的越优先，所有项目层都压过用户目录。标了 `disable-model-invocation: true` 的 skill 不进这个列表，模型不会自己挑它。

在消息里输入 `$` 可以从菜单里选 skill。发送时宿主把调用的 skill 的全文（去掉 frontmatter）放在消息前面交给模型，所以明确调用不依赖模型自己去读；`disable-model-invocation` 的 skill 也能这样调用。客户端告诉宿主选中了哪些（协议 5.16），只有这些会展开；不告诉的旧客户端，宿主按文本里的 `$name` 匹配。界面上的消息、排队消息和对话标题只显示你输入的文字。skill 不在当前项目里、或者文件读不出来时，这一个不展开，并提示（ADR-0028）。

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

`subagent` 工具多一个可选的 `role` 参数，主模型可以把任务派给某个具名 Agent；系统提示词的 `agent_roles` 小节会列出所有可用的名字和描述。定义里写了 `model` / `thinkingLevel` 的就以定义为准，调用时再传这两个参数直接报错；没写的可以照常传，不传就沿用父对话；定义里钉的模型不可用时报错，不回落。消息里写 `@name` 时，主模型会把相关工作派给对应的具名 Agent——宿主不做专门处理，固定规则就写在 `agent_roles` 小节里；Web / 桌面端输入框里打 `@` 会弹出具名 Agent 列表，选中后插入 `@name` 纯文本。子代理卡片也会标出它跑的是哪个具名 Agent（`Done · @name · …`）。具名 Agent 的提示词接在固定的子代理说明后面；派出那一刻抄一份进子代理自己的状态，之后再改或删文件都不影响已有的子代理。

文件改动立即生效：宿主监视 `agents/` 目录，新建、手改、删除都会在下一轮提示词里体现，并即时推给所有在线客户端。也可以在 Settings → Agents 里直接管理：列表显示每个具名 Agent（钉住的模型和思考等级标出来，钉的模型不存在会标 `Model not available`）和解析失败的文件及其原因，可以新建、编辑、删除——名字不合规的文件没有删除入口，只能手改。

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

stdio server 写 `command`（可选 `args`、`env`、`cwd`——相对的 cwd 按主目录解析）；HTTP server 写 `url`（可选 `headers`）。`env` 和 `headers` 的值可以用 `${NAME}` 引用宿主进程的环境变量。`timeout`（秒，默认 60）是单次工具调用的超时；`enabled: false` 保留配置但不连接。每个 server 在宿主里只连一份、所有对话共用；工具名是 `mcp__<server>__<tool>`。`exposure` 决定模型怎么够到它们（ADR-0013）：默认 `codemode`，工具不声明给模型，只能在 codemode 脚本里调用，模型用 `searchTools` / `describeNamespace` 找到它们，server 连上前后工具声明不变；写 `"direct"` 则同时直接声明给模型，结果里的图片显示在工具卡片里。`description`（可选）是给模型看的一句话说明，列在系统提示词里；不写时只列 server 名和工具数，server 自带的 instructions 由 `describeNamespace` 返回。右侧状态面板的 MCP 区列出每个 server 的状态、工具数和错误，以及配置错误（比如引用了一个不存在的环境变量）。配置只在启动时读一次，改动后重启宿主生效（常驻模式用 `pinomad service restart`；从源码检出跑时是 `bun run service -- restart`）。暂不支持：项目级 `mcp.json`、OAuth 登录（server 回 401 会在状态里提示）、resources / prompts、`deferred` / `tool_search`。

让 agent 看图：`read` 遇到 PNG / JPEG / GIF / WebP 会把图片返回给模型，太大的会按模型上限缩小；模型不支持图片输入时看到的是占位说明。要让 agent 自己截图，在 `~/.agents/mcp.json` 里配 Playwright MCP（或 Chrome DevTools MCP）：

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"], "exposure": "direct", "description": "Drive a browser" }
  }
}
```

`exposure: "direct"` 时它的截图工具结果图片直接显示在工具卡片上；默认 `codemode` 暴露下脚本也可以 `image()` 把拿到的图片放进输出。

宿主设置在侧栏底部的 Settings 对话框里（ADR-0021），按宿主名分组的那几节：新建对话的默认模型和思考等级、busy 时 steer / follow-up 消息排队后的投递方式、模型 Provider（见下），以及只读的 MCP 配置和宿主数据目录。运行中排队的消息显示在输入框上方，可以 Steer（改成 steer、等下一个可用边界）、Edit（撤回并放回输入框，输入框已有内容时不可用）或 Withdraw（撤回）。设置写在宿主数据目录的 `settings.json`（默认 `~/.pinomad/settings.json`），文件里只保存改过的键；没设过的回落到内置默认。任一设备改了，所有在线设备立刻看到新值。同一个对话框最上面的 "This device" 一组属于客户端自己：Hosts 里管理配对过的宿主（切换、忘记、粘贴配对链接配新宿主），桌面端还有 Updates。侧栏底部的电脑图标点开是各宿主的名字和连接状态（呼吸的绿点是已连接，灰点是没连上），点另一台就切过去。宿主运行时只有宿主自己写这个文件——要手动编辑请在宿主停止后进行。宿主不读 pi 的任何配置（ADR-0031）。

Settings → Providers 管理宿主能用哪些模型，任何一台已配对设备都能操作，所有设备共用同一份：

- **Subscription**：用已经在付费的订阅登录（Claude Pro/Max、ChatGPT Plus/Pro、GitHub Copilot、SuperGrok / X Premium、Kimi Code、Meta Muse），OpenRouter 等账号登录也在这里。有的会给一个链接，在任意设备的浏览器里批准后把页面给出的 code 贴回来；有的显示一个设备码，到 provider 的网站输入。
- **API key**：pi 支持的 provider 都在这里，Cloudflare、Vertex、Bedrock 这类要多填几项的会在同一个表单里一步步问。
- **Custom endpoint**：自己的 OpenAI / Anthropic / Gemini 兼容服务（Ollama、LM Studio、vLLM、网关）。填 base URL 和模型 id，"Fetch from /models" 由宿主去问 endpoint 有哪些模型。保存时宿主还会读 `/models` 里每个模型的上下文窗口、最大输出、是否支持思考和图片输入，写进 `models.json`；endpoint 没报的项按 pi 的默认值（128k 窗口、16k 输出、不思考、只收文字）。在 `models.json` 里手改过的字段优先，重新保存不会覆盖。

一个 provider 只存一份凭据，换登录方式会替换掉原来的。凭据存在数据目录的 `auth.json`，自定义 endpoint 存在 `models.json`（pi 的 models.json 格式，可以在宿主停止时手改）。宿主环境变量里的 key（例如 `GEMINI_API_KEY`）照样生效，在列表里标为来自环境变量。从旧版本升级不会带上 `~/.pi/agent` 里的登录，要在这里重新登录。代理、重试、压缩这些 pi 的 harness 设置写在 `settings.json` 的 `"pi"` 键下，格式同 pi 的 settings.json，只能手改，宿主启动时读。

## 斜杠命令、消息时间和送达状态

在消息开头输入 `/` 会出现宿主声明的命令菜单（ADR-0029）。命令只认消息开头那一段：`/compact [说明]` 让宿主压缩较早的上下文，在宿主上执行，不会作为消息发给模型；`/usr/bin/x` 这类开头的路径按普通消息发。`+` 菜单里的 "Run a command…" 打开同一份列表。宿主低于 5.17 时没有 `/` 菜单，`+` 里仍保留压缩上下文。

每条消息都显示发送时间：今天的只显示时刻，更早的加日期，往年的再加年份；Web / 桌面端悬停看完整的日期时间。你发的消息还显示送达状态（ADR-0034）：最新一条送达后显示 Delivered，发送中显示 Sending，30 秒没回音或断线显示 Not confirmed，被宿主拒绝显示 Failed 和原因。没确认的消息重连后会先向宿主核对，确实没收到才重发，不会发重；未确认和失败的消息可以 Retry，失败的还可以 Edit 取回输入框修改。

## 连接方式

在 Settings → Hosts 里点某台宿主的 Connection… 选连接方式（ADR-0033）：Auto（默认，有中继时先经中继连上，链路就绪后在后台切到 WebRTC P2P，打洞失败就留在中继）、Direct only（对话数据不经过 PiNomad 服务端，中继只用来建立链路）或 Relay only（只走中继，不尝试 P2P）。同一个面板的 Status 显示当前走 P2P 还是中继；走 P2P 时还显示两端是局域网 / tailnet / 公网地址（点 Show addresses 看完整地址），以及最近一次失败的原因。没有 TURN，有些网络建不起 P2P；中继和配对细节见[远程访问](/zh/docs/remote-access/)。

## iOS 账号

iOS 原生版同时只登录一个服务端账号（ADR-0022）。入口有两个：还没有配对过宿主时，首页的「用账号登录」；已经配对过时，对话列表左上角的宿主按钮 →「宿主」页顶部的「账号」。

登录先填服务端地址（`https://…`；本机开发可以填 `http://127.0.0.1:…` 或 `http://localhost:…`），App 会先探测这个服务端有没有开账号。没开账号会提示「这个服务端没有开启账号」，连不上会提示检查地址和网络；探测通过后再填用户名和密码，密码支持系统密码自动填充。

登录成功后，宿主页列出账号下的宿主：在线状态、是否已配对。对未配对的宿主点「配对」，服务端会向宿主要一份一次性邀请，再用现有的安全通道完成配对，不需要扫码；已经用扫码等方式配过的宿主会被认出来，并静默记下账号关联。宿主离线、版本太旧或公钥对不上时按钮会灰掉，并写明原因。

宿主的公钥变了（比如重装了宿主）时，账号列表只提示「公钥变了」，不会自动重新配对；确认是自己的操作后点「重新配对」。如果宿主说这台设备被拒绝（4401），同样只在页面上提示，并给一个显式的「经账号重新配对」，点一下才会重新要邀请。

退出登录只是让服务端不再替这台设备担保；已经配对的宿主仍然能连、能继续用，设备登记和吊销仍由各台宿主自己管。要彻底移除这台设备，到宿主的「设备」页面吊销它。「在所有设备上退出」会让账号的所有登录会话失效，包括其他设备。

会话过期或服务端说登录失效时，App 会清掉钥匙串里的令牌，保留服务端地址和用户名，回到未登录状态，重新登录即可。账号令牌只存在钥匙串和内存里，不写日志。

要再给另一台设备配对，在已经连上的宿主的「宿主」页里点「给另一台设备配对」，会出示一张带倒计时的二维码，也可以复制链接发给对方；过期后点「新二维码」。如果链接的主机是 `127.0.0.1`，说明宿主只在本机暴露，另一台设备打不开，App 不会显示二维码，会提示改用宿主终端的 `pinomad pair` 或 Web 端的「设备 → 配对设备」。

## 推送通知

iOS 原生版的推送开关按宿主分别保存，默认关闭。入口在对话列表左上角的宿主按钮：打开「宿主」后，最下面的「推送」一节给当前宿主设置。第一次打开会请求系统通知权限；拒绝后开关旁会提示，并给出「去系统设置打开通知」。

推送需要宿主是 5.9 或更新、宿主已经加入账号（`pinomad join`），并且服务端为对应环境配好了 APNs 密钥（#131）。没加入账号时宿主会回一段说明，原样显示在开关旁；连上、重连、回到前台或再切换开关时会重试。宿主低于 5.9 时开关不可用，旁边会提示升级宿主。

登记时机是连上、重连和回到前台：开关开着、宿主支持推送并且系统已经给了设备 token 时登记；开关关着时，如果这台设备在宿主上可能还有登记（比如断线时关掉开关），并且宿主是 5.7 或更新，会发一次注销，否则什么都不发。断开时关掉开关不会立刻发出去，下次连上时补上。

App 在前台时只屏蔽当前宿主的横幅，其他宿主的推送照常显示（横幅加声音）。点开推送会切到对应的已配对宿主，等它连上并拿到第一份数据后打开那条对话；冷启动点开也一样。推送的 hostKey 不在已配对宿主里时直接丢弃。

推送内容只有对话标题和事件（「等你回答」「完成」「失败」），不带问题或回复；标题会经过服务端和 Apple。设备 token 登记在宿主上，服务端用自己的 APNs 密钥发送。

忘记宿主前，如果这台设备在宿主上可能还有登记，而且正连着这台宿主，App 会先注销这台设备的登记（最多等 5 秒）；没连上、注销超时或失败时仍然忘记，但会提示你到宿主 Web 端的「设备 → 配对设备」里吊销这台设备，否则它可能继续收到推送。

App 的环境由构建时的 `PINOMAD_APS_ENVIRONMENT` 决定：Debug 是 `development`，Release 是 `production`。签名里的 `aps-environment` 和 Info.plist 的 `PinomadAPSEnvironment` 都来自这一个设置，代码里不按 Debug / Release 判断。模拟器签名不带 entitlement（Xcode 把它放进产物的 `Simulated.xcent` 和二进制段），实际环境看这两个产物；TestFlight 和 App Store 包是 `production`。真机端到端要等服务端密钥配好，App 侧行为可以用 `xcrun simctl push` 在模拟器上验证。
