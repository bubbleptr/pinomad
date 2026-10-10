# 路线图

唯一一份随进度更新的计划。ADR 只记录难以回退的取舍，"以后再做"的事情都收在这里；做完一项就挪进"已完成"，需要新决策的在条目后注明。

最后更新：2026-10-10

## 已完成

- 宿主与 Web 客户端骨架，宿主和客户端只通过 `packages/protocol` 通信（ADR-0001、0002、0003）
- 项目 → 对话、Chat、fork、compact、abort、切换模型和思考等级（ADR-0007）
- 编码工具 read / write / edit / bash；AGENTS.md 与 Skills 上下文（ADR-0006）
- 展示类型 `pinomad.todo`、`pinomad.question`、`pinomad.diff` 和兜底渲染（ADR-0005；`pinomad.approval` 后被 ADR-0011 换掉）
- 远程访问第一期：Noise IK 安全通道、扫码配对、设备登记与吊销，传输只有局域网直连；出门在外可以自备 Tunnel 或 tailnet，配合 `--public-url` 使用（ADR-0008）
- 宿主常驻：用户级系统服务、等空闲重启、源码检出升级、协议版本检查（ADR-0009）
- Git 项目的对话默认在独立 worktree 里工作；fork 复制当前文件；归档清理（ADR-0010）
- `pinomad.diff` 展示类型；工具结果 `details` 声明展示类型；edit/write 渲染成 diff（ADR-0005、0011）
- 结构化提问 `ask_user_question` 和 `pinomad.question`，取代审批（ADR-0011）
- 对话级改动面板：相对检出起点的 git diff（ADR-0010、0011）
- 前台子代理工具 `subagent`：子对话归调用任务所有，中止连带、重启不重复派活；共用父对话检出，并行写只靠工具描述约束；子代理里禁用 `ask_user_question`；模型和思考等级默认沿用父对话，可用 `model` / `thinkingLevel` 参数指定；调用结束后卡片仍能链到子对话（ADR-0010 §5）
- MCP 接入：`~/.agents/mcp.json` 全局 `mcpServers` 配置，每个 server 在宿主里只连一份、所有对话共用；工具以 `mcp__<server>__<tool>` 直接声明，`tools/list_changed` 跟随；状态和配置错误经 `mcp` 流推到客户端右侧面板；结果图片显示在工具卡片里（ADR-0012；协议 v3）
- codemode：所有对话默认开启的通用工具，模型写 JavaScript 在 QuickJS 沙箱里调用其他工具，只有脚本输出进入上下文；工具按 `direct` / `model-only` / `codemode` 暴露，`ask_user_question`、`subagent` 只给模型；MCP 工具默认只在脚本里可调（`mcp.json` 可按 server 写 `exposure: "direct"`），脚本用 `searchTools` / `describeTool` / `describeNamespace` 发现，server 连上前后工具声明不变；Web 上一次调用是一张 `pinomad.codemode` 卡片，列出嵌套调用并能展开 edit / write 的 diff（ADR-0013）
- 远程访问第二期：自部署中继 `apps/relay`，宿主 `--relay` 主动连出，每台设备一条数据连接拼接到同一个 IK 握手；宿主用独立 Ed25519 密钥签名登记，中继按 `--allow-host` 白名单接受；中继用 HTTPS 提供 Web 客户端，配对链接优先指向中继（ADR-0008、0015）
- npm 单包分发：一个公开的 `pinomad` 包装宿主、中继和构建好的 Web 客户端（Bun.build 打我们自己的代码，第三方依赖外置）；`pinomad` 单入口分发子命令；打包安装升级走 `npm i -g`；tag 触发 GitHub Actions 发布（OIDC trusted publishing）（ADR-0016）。仓库已公开，`pinomad@0.1.0` 已手动首发；trusted publisher 已配置（只允许 `npm publish`，不开 `npm dist-tag`），`v0.1.1` 由 tag 流水线经 OIDC 自动发布并带 provenance
- 协议兼容（ADR-0018）：hello 带 `protocol: { major: 5, minor: 0 }` 和 `hostVersion`，客户端只比较主版本号，不一致时按"客户端太旧 / 宿主太旧"分别提示。`parseClientFrame` 区分"不认识"和"格式错误"：不认识的调用回 `result ok:false`，不认识的流回 `ended`，不认识的帧类型忽略；格式错误用 4400 断开，客户端收到 4400 不再重连（1008 留给安全通道，照旧重连）。契约快照的测试在 `apps/host/test/protocol-contract.test.ts`，基准文件在 `packages/protocol/test/fixtures/`；升级 `@earendil-works/*` 时用 `PINOMAD_UPDATE_CONTRACT=1` 重新录制并评审变化。遗留：第一次涨次版本号时，在 `packages/protocol` 里加功能对应次版本号的 `since` 表
- Omarchy 真机常驻：npm 安装的宿主跑成 systemd 用户单元 + linger，带 `--relay` 常驻；中继用 `deploy/relay/Dockerfile` 部署在 Zeabur 香港机器上，自定义域名 HTTPS 和 WebSocket 都验证过，宿主登记成功，手机走流量配对连通（2026-10-09）
- tailnet 直连试用：Mac 和 Omarchy 都装官方 Tailscale 客户端，和 sing-box 共存。共用的 sing-box 配置要改两处：DNS 规则让 `tailscale.com` / `tailscale.io` 不走 FakeIP，否则控制面连不上；tun 用 `route_exclude_address` 排除 `100.64.0.0/10` 和 `fd7a:115c:a1e0::/48`。`tailscale ping` 显示经局域网直连，2–7ms，没走 DERP。Omarchy 开了 Tailscale SSH，tailnet 策略加了一条 SSH 规则（成员登录自己的设备，非 root）。宿主带 `--remote-port 7422` 和 `--relay` 同时跑：tailnet 内的设备直连，不在 tailnet 里的设备仍走中继。Mac 已经配对上并通过直连使用（2026-10-10）

## M1：并行任务的审阅与对齐（已完成）

## M2：coding 能力补齐（已完成）

目标：日常 coding 不用再切回 Pi CLI。子代理、MCP 和 codemode 都已完成（见"已完成"）。

工具集和 Pi CLI 的默认一致，就是 read / bash / edit / write 四个。pi-coding-agent 虽然也带了 grep / find / ls，但默认是关的，搜索交给 bash，所以不算缺口，不进 M2。将来需要不带 bash 的只读工具集时再补（比如只读子代理）。届时注意：CLI 的这三个工具是 `AgentTool`，构造时绑死 cwd，直接调本机 fs 和 `child_process`，要基于每次调用的 `api.env` 重写。read 读图片等上游，见"等上游"。

子代理第一版之后可能的后续，都等有明确需求再做：
- 后台子代理（Durable 例 23：spawn / message / wait / stop / list，回答作为 follow-up 回帖给父对话）。
- 并行写冲突现在只靠工具描述约束；真出问题时再考虑只读子代理，或给写文件的子代理单独开 worktree（会改动 ADR-0010 §5）。
- 子对话的呈现方式和位置要重新设计：现在作为普通对话挂在侧栏父对话下，标题取自父代理写的任务描述开头（真实模型冒烟里是 "In the working directory /tmp/…" 这种套话），分不清各子代理在干什么。工具卡片已能点进子对话（M2.5 第 2 步）。

### MCP 的后续

MCP 接入和 codemode 都已完成（ADR-0012、0013）。

codemode 之后可能的后续，都等有明确需求再做：`store` / `load`（要一个跟着 fork 走的可回退文档）、`models`（分类、图片模型）、`deferred` + `tool_search`（可用 Durable 的 `control.addTools`）、CLI 的 `only` 模式、bash 在脚本里返回带退出码的结构化结果。

MCP 本身的后续，都等有明确需求再做：

- 项目级 `mcp.json`：等于让仓库在宿主上不经模型就起任意进程，登记项目时要先确认信任；协议和 Web 都要动。
- OAuth：HTTP server 回 401 现在只在状态里提示"需要登录"；授权链接要经客户端打开、回调回到宿主，和远程访问（ADR-0008）有交集。
- 配置热加载、server 掉线或崩溃后的手动重连：现在都要重启宿主（`service -- restart` 等空闲）。
- MCP resources / prompts 还没有接入方式和呈现。

## M2.5：搬入 Pace 的界面（主体已完成，余项暂缓）

把 Pace 的对话界面和外框搬进 Web 客户端（ADR-0014）。按依赖顺序拆成 stacked PR：

1. 视觉基础（已完成）：Tailwind v4、token 桥、Montserrat、Hugeicons、`@/` 别名；现有界面不改结构，只换底子。
2. 对话流（已完成）：思维链（工具 step 行、思考行、状态行）、Markdown 和代码块；从 Durable 的 `ConversationView` 推导 `CotView`。edit / write 的 diff、codemode 的嵌套调用、工具结果图片、fork 按钮都保留；子代理卡片能点进子对话（运行中也能点），卡片标题用 `subagent` 新增的可选参数 `description`，查看子对话时能回到父对话。
3. 外框（已完成）：Astryx AppShell，侧栏是 wash 底色、主区是白色；顶栏 40px，显示对话标题，子代理对话显示成"父对话 › 子对话"面包屑；右侧 Dock 默认收起，由顶栏按钮开关，有运行中的任务或排队消息时按钮上亮一个点；cwd 和分支移进 Dock 的 Workspace。侧栏按 Pace 分成 New chat、Chats、Projects，操作悬停时才出现，Devices 放在底部。窄屏只有一行顶栏。
4. 首页和 Composer（已完成）：草稿态变成 Pace 的首页——hero（"Build something useful with PiNomad"）、项目选择器、四条建议提示；新建对话可以选模型和思考等级（`createConversation` 加 `model` / `thinkingLevel`，hello 带默认模型，协议 v4）。Composer 换成 Pace 的 ChatPromptInput：左侧是"+"菜单和"模型 · 思考等级"胶囊，运行中带文字的草稿可以排队为 Follow-up 或 Steer，排队消息显示在输入框上方；footer 是位置行（Chat / Git worktree 加分支 / Project folder，草稿里项目可以选 worktree 还是直接在目录里跑）。Dock 的 Queue 区块撤掉，圆点只算运行中的任务。

之后接着做（细节到时再定）：
- **优先**：fork 和子代理在界面上怎么体现，还没有方案。现在两者都作为普通对话挂在侧栏的父对话下；子代理标题是任务描述开头，分不清各自在干什么（另见 M2 子代理后续）。M3 中继之后回来做。
- 上下文用量指示（Pace 的位置行右侧有 context meter；我们的宿主还没暴露用量）。
- 附件：ChatPromptInput 已经留好接口（drawer、onFiles），需要协议里能带附件的消息。
- 斜杠命令和 @ 文件补全：Pace 的 trigger 菜单方案（leading token + typeahead）。
- 撤回或改写排队中的消息（需要协议新增调用；Pace 是 queued-message 行内的 Withdraw / Steer 操作）。
- 运行失败后的重试入口（Pace 的 run-failure 恢复）。`ChatRunFailure` 已搬入并支持 `onRetry`，`chat-entries.tsx` 还没传，按钮不显示。
- 侧栏行显示运行中标记和更新时间：对话摘要要先加 `updatedAt` 和是否在跑。
- 查看和恢复已归档的对话。恢复后 worktree 由 `ensureWorktree` 从保留的分支重建。
- 对话自动起名：用默认模型，标题跟着当前的工作实时变化；手动改名后不再自动覆盖。

## M3：在哪都能连（进行中）

场景：一台 7x24 常驻的 Linux 机器（Omarchy）当宿主跑任务，出门在外也能连上。自部署中继和 Omarchy 真机常驻都已完成（见"已完成"）。

- 中继的后续，等有需要再做：二维码同时带局域网和中继两个候选地址并自动选择；中继限流；Web 里显示中继连接状态；中继托管页面加 CSP
- tailnet 直连的后续：同时开着中继时，`pinomad pair` 只给出中继链接，要走直连得取出其中的 `pair=…`，拼到 tailnet 地址后面（现在由本机脚本完成）。用一段时间后，再决定是给 `pair` 加一个选地址的参数，还是并入上面的"二维码带多个候选地址"。另外 `--remote-port` 监听的是 `0.0.0.0`，局域网也能访问到；连上后仍要过 IK 握手，所以暂不限制
- 长期：账号绑定中继，宿主登记到账号下，客户端用账号找到并连上自己的宿主（类似 Lody）。还没定：账号只管发现和路由、信任仍落在设备密钥上（新设备由已有设备批准，或账号密码走 PAKE 直接和宿主认证），还是由中继背书授权（等于放弃 ADR-0008 的端到端保证）。定了要写新 ADR，修订 ADR-0008 的配对和握手，同步改 `CONTEXT.md` 的"设备"
- 按 ADR-0009 记下的条件，重新评估要不要加 PiNomad 自己的监管进程
- 官方中继、推送通知（ADR-0008 第三期）
- 按设备区分的权限：只读设备（ADR-0008；审批策略见 ADR-0011）
- 对话列表里提示"有问题等你回答"，和推送通知一起做（ADR-0011）

## 待定优先级：代码在别的机器上跑

coding anywhere 的第三条线：客户端在哪（M3）、宿主在哪之外，还有代码在哪执行。现在宿主只能操作自己所在机器上的代码（ADR-0003）。M2 做完、开始设计中继之前再决定优先级。

- 用 `@earendil-works/pi-env`（1.0.4 起官方提供，SSH 部署 Rust 守护进程的 `RemoteExecutionEnv`）支持远端机器上的项目：宿主和 Durable 状态留在本机，工具在远端执行（需要新 ADR）
  - 项目要记录所在机器；每个对话创建的 env 不再固定是 `NodeExecutionEnv`（`host.ts`）
  - `checkout.ts` 的 worktree、fork 快照、改动 diff 和 `organization.ts` 的路径检查现在直接用本机 `node:fs` / `child_process`，要改成经由 env 执行；在那之前，新的 git 操作尽量收在 `checkout.ts` 里
  - 主机密钥确认、SSH 凭据管理的界面；宿主持有多台机器的凭据，安全边界随之变大
  - 不解决客户端连宿主的问题（仍靠 M3 中继），宿主也要能连到目标机器
- 每个任务一台临时机器或容器，作为 worktree 之外更彻底的并行隔离方式

## M4：客户端完善

客户端形态已定（ADR-0017）：桌面端 Electron 只做 macOS arm64，页面打包进 App；Linux 用 Web；移动端 Expo。按顺序：

1. 桌面端 `apps/desktop`：renderer 复用 `apps/web` 的构建；外壳、electron-updater、签名公证从 Pace 复制（注明来源 commit）；私钥存进 `safeStorage`；同时连多台宿主；`pinomad://` 深链配对；通知。内嵌浏览器不搬（宿主可能在别的机器上，预览要经安全通道转发端口），等有需要再说。
2. 移动端 Expo：先验证 `packages/protocol` 能在 Hermes 上跑（`getRandomValues`、`TextEncoder`、`WebSocket`）、能和 Bun workspaces 一起用；界面用 React Native 重写，不依赖 DOM 的视图推导（如 `CotView`）挪到共享的位置；设计 token 怎么在两端共享还没定。iOS 构建和分发走 EAS / TestFlight。
- 设置界面，连带决定 PiNomad 要不要有自己的设置文件（ADR-0006 遗留）。设置存在哪还没定，候选：写 pi 的 `settings.json`、存进 Durable 的 session 级文档、新建 `~/.pinomad/settings.json`。客户端偏好存在设备本地；宿主启动参数和 `mcp.json` 第一版只读展示。
- 以后可能有：TUI 客户端（TS，能直接复用 `packages/protocol`）。

## 等上游

不自己实现，也不去上游提 issue，等官方版本带上后随升级（ADR-0002 锁精确版本，升级时顺带评审）接入。

- read 读图片（ADR-0002、0006 遗留）：Pi CLI 的 read 能读图片，Durable 的 read 识别出图片后返回 `unsupported_image`，README 写的是 "not supported yet"。截至 2026-10-07，上游 main 和 CHANGELOG 的 Unreleased 都还没有，也没有对应的 issue 或 PR。Web 工具卡片已经能显示结果里的图片块（随 MCP 做的，ADR-0012），上游支持后接上 read 即可。

## 待定优先级：其余展示类型

ADR-0005 的候选 `progress`、`table`、`log`、`status` 不单独排期，等某个产品功能确实需要结构化呈现时再定义对应的类型，没有产出方的 schema 只是猜测。目前看得到的需求：bash 运行输出（`log`）、MCP server 连接状态和子代理在做什么（`status`）。用不上的类型直接从候选里删掉。每加一个类型：`packages/protocol/src/presentation.ts` 加 schema 和 `classify` 分支、Web 加渲染、测试覆盖"不符合 schema 时兜底"；旧客户端会兜底，不用同步升级。

## 技术债

- npm 上的 `0.0.0-stage` 占位版本可以 `npm deprecate` 掉（要 2FA），不影响安装
- 远程配对测试偶发 `UnauthorizedError`，原因未查明
- Skills 只扫描 `<cwd>/.agents/skills`，在仓库子目录启动时看不到仓库根目录的 Skills；格式有误的 Skill 被直接忽略，不提示用户（ADR-0006）
- 审计和费用统计需要单独的数据来源，`watchEvents` 不能当审计日志（ADR-0002）
- 协议版本号靠人工判断该加哪个，没有机器检查（ADR-0009、0018）；契约快照只盯得住上游的数据结构，我们自己的帧仍靠评审
- macOS 日志不轮转（ADR-0009）

## 不在计划内

- Windows 宿主（ADR-0009）
- Serverless / 云端宿主（ADR-0003）
- 兼容 Pi CLI 的扩展、配置和会话格式（ADR-0001）
- 声明式视图树，等标准展示类型确实不够用时再考虑（ADR-0005）
