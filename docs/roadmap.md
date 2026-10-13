# 路线图

唯一一份随进度更新的计划。ADR 只记录难以回退的取舍，"以后再做"的事情都收在这里；做完一项就挪进"已完成"，需要新决策的在条目后注明。

最后更新：2026-10-13

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
- npm 单包分发：一个公开的 `pinomad` 包装宿主、中继和构建好的 Web 客户端（Bun.build 打我们自己的代码，第三方依赖外置）；`pinomad` 单入口分发子命令；打包安装升级走 `npm i -g`；tag 触发 GitHub Actions 发布（OIDC trusted publishing）（ADR-0016）。仓库已公开，`pinomad@0.1.0` 已手动首发；trusted publisher 已配置（只允许 `npm publish`，不开 `npm dist-tag`），`v0.1.1` 由 tag 流水线经 OIDC 自动发布并带 provenance。`v0.2.0`（协议 5）第一次由流水线同时发出 npm 包和签名、公证过的 Mac 包（GitHub Release 带 `latest-mac.yml`）；发布前 electron-builder 升到 26.16.1，26.15.x 在 `macos-26` runner 上签名会失败（electron-builder#10066，PR #55）。Omarchy 已升到 0.2.0（2026-10-12）。跨协议主版本升级时，`pinomad upgrade` 里等待重启的仍是旧版代码，会误报 "host did not answer … protocol mismatch"，实际宿主已经起来了，用 `pinomad service status` 确认即可。中继代码从 0.1.1 到 0.2.0 没变，但中继托管的 Web 客户端跟着镜像里的 npm 版本走，宿主升到协议 5 后还停在 0.1.1（协议 4），浏览器从中继打开会版本不匹配；`deploy/relay/Dockerfile` 已改到 `0.2.0` 并在 Zeabur 重新部署（2026-10-12；桌面端和 iOS 不受影响，代码随 App 打包）
- 协议兼容（ADR-0018）：hello 带 `protocol: { major: 5, minor: 0 }` 和 `hostVersion`，客户端只比较主版本号，不一致时按"客户端太旧 / 宿主太旧"分别提示。`parseClientFrame` 区分"不认识"和"格式错误"：不认识的调用回 `result ok:false`，不认识的流回 `ended`，不认识的帧类型忽略；格式错误用 4400 断开，客户端收到 4400 不再重连（1008 留给安全通道，照旧重连）。契约快照的测试在 `apps/host/test/protocol-contract.test.ts`，基准文件在 `packages/protocol/test/fixtures/`；升级 `@earendil-works/*` 时用 `PINOMAD_UPDATE_CONTRACT=1` 重新录制并评审变化。遗留：第一次涨次版本号时，在 `packages/protocol` 里加功能对应次版本号的 `since` 表
- 回环安全通道（ADR-0020）：宿主每次启动都加载密钥、能签发配对邀请；回环端口的 `/secure` 路径走 Noise 握手，不校验 token 和 Origin；没开远程访问时配对链接指向回环地址，Web 的 Devices 对话框和 `pinomad pair` 遇到回环链接不画二维码，提示只能给本机客户端用
- Omarchy 真机常驻：npm 安装的宿主跑成 systemd 用户单元 + linger，带 `--relay` 常驻；中继用 `deploy/relay/Dockerfile` 部署在 Zeabur 香港机器上，自定义域名 HTTPS 和 WebSocket 都验证过，宿主登记成功，手机走流量配对连通（2026-10-09）
- tailnet 直连试用：Mac 和 Omarchy 都装官方 Tailscale 客户端，和 sing-box 共存。共用的 sing-box 配置要改两处：DNS 规则让 `tailscale.com` / `tailscale.io` 不走 FakeIP，否则控制面连不上；tun 用 `route_exclude_address` 排除 `100.64.0.0/10` 和 `fd7a:115c:a1e0::/48`。`tailscale ping` 显示经局域网直连，2–7ms，没走 DERP。Omarchy 开了 Tailscale SSH，tailnet 策略加了一条 SSH 规则（成员登录自己的设备，非 root）。宿主带 `--remote-port 7422` 和 `--relay` 同时跑：tailnet 内的设备直连，不在 tailnet 里的设备仍走中继。Mac 已经配对上并通过直连使用（2026-10-10）
- fork 和子代理的呈现：侧栏只放顶层对话，行首状态点按整个家族汇总（等回答 > 失败 > 运行中），行尾显示更新时间；右侧面板分 Threads / Tasks / Live 三个 tab，fork 能在面板里对话或"在主区打开"（顶栏面包屑回父对话），子代理只读；父对话里分叉点显示"N forks"胶囊、子代理调用显示成任务卡片（fork 的检出和层数见 ADR-0019；PR #34、#40、#42）

## M5：离开电脑，用手机也能推进 side project（下一阶段）

衡量标准：一整天只用手机，能发起任务、知道它跑完了或在等你、看懂它改了什么、给它截图或看它的截图。主用手机和 Web；每项 Web 和移动端都要做，界面按端分 PR。按顺序：

1. **项目入口**（ADR-0007 §1、§7）：现在 Web 的 "+" 只在悬停时出现，要手打绝对路径，移动端完全没有入口。改成选宿主上已有的文件夹，参照 Pace 的 Add Project：
   - 协议新增"列出某个目录下的子文件夹"的调用，从宿主的家目录开始，不列隐藏文件夹；
   - 三端统一的文件夹选择器：面包屑、子文件夹列表、"选择"即登记；去掉手打路径的输入框。桌面端连本机宿主也用它，不调原生对话框；
   - Web 和桌面端：Projects 标题的 "+" 一直显示，没有项目时空状态里放"添加项目"；移动端：新建对话页的项目菜单底部"添加项目…"，没有项目时对话列表也给入口；
   - 加完直接进入这个项目的新对话草稿；
   - 不做：新建目录、`git init`、从 Git 地址克隆（先让 agent 在 Chat 里做）、项目根目录设置。
2. **顺手的小项**：运行失败后的重试入口（`ChatRunFailure` 已支持 `onRetry`，`chat-entries.tsx` 还没传）；对话自动起名（用默认模型，标题跟着当前的工作实时变化，手动改名后不再自动覆盖）。
3. **推送通知**（只做 iOS，Web Push 不做；issue #69）：
   - 宿主直接调 Expo Push Service（`https://exp.host/--/api/v2/push/send`，默认不要鉴权），不经服务端，宿主上不放 Apple 密钥；APNs 密钥在 EAS 凭据里。移动端加 `expo-notifications`，要出新的 TestFlight 构建；
   - 推送只带对话标题和事件（"等你回答"、"完成"、"失败"），不带问题和回复内容。标题会经过 Expo 和 Apple，这是推送不走安全通道的代价；真要加密得写 iOS Notification Service Extension 解密，现在不做；
   - App 拿到权限后经安全通道把 Expo push token 报给当前宿主，存进这台设备在 `pinomad.devices` 里的记录；吊销设备、Expo 回执 `DeviceNotRegistered` 时删掉；App 里的通知开关是客户端偏好，关掉就注销；
   - 宿主复用 `packages/client` 的 `diffRunNotices`（等回答，子代理也算；顶层对话一轮完成或失败），推给所有登记了 token 的设备；App 在前台时不弹横幅；推送带宿主身份和对话 id，点开后切到那台宿主、打开那条对话；
   - 对话列表的"等你回答"提示已经有了（Web 侧栏状态点、移动端 "Waiting"），不用另做。
4. **图片**（issue #68）：
   - 用户 → agent（先做）：只支持图片，一条消息最多 4 张；新对话第一条、平时发送、排队的 Follow-up / Steer 都能带。Web 可粘贴、拖入、"+" 菜单选图（ChatPromptInput 已留好 drawer、onFiles），移动端 "+" 菜单选相册或拍照、也能粘贴；用户消息显示缩略图，点开看大图；
   - 客户端发送前缩放到长边 1568px、转成质量约 0.85 的 JPEG；宿主再校验，单张超过 5 MB 拒绝；
   - 协议：`submit` / `createConversation` 加 `images`（base64 + mimeType），`ModelSummary` 加能否收图片（取 pi-ai 模型数据的 `input`），按 ADR-0018 涨次版本号；当前模型不收图片时附图入口变灰并提示，换模型后历史图片由上游换成占位文本；
   - agent → 用户：不做内置截图工具，靠 Playwright MCP / Chrome DevTools MCP（`~/.agents/mcp.json`）；移动端工具卡片显示图片、点开看大图，codemode 卡片显示脚本输出的图片；`docs/usage.md` 写一段"怎么让 agent 截图"；
   - 升级 `@earendil-works/*` 到 1.2.0（2026-10-12 发布，ADR-0002 要显式评审）接上 read 读图片：1.2.0 的 read 遇到 PNG / JPEG / GIF / WebP 返回图片块，还可以经 `createCodingTools({ images })` 按模型限制缩放。同一版本还带了上游自己的 codemode 和结构化工具输出，评审时一并看对我们的 codemode（ADR-0013）有什么影响。
5. **手机上的改动面板**：Web 已有的对话级改动面板搬到移动端（ADR-0010、0011）。
6. **具名 Agent**（ADR-0023），连同输入框的 `@` 菜单和 @ 文件补全（Pace 的 trigger 菜单方案：leading token + typeahead）。实现条目见下。

服务端上的账号（ADR-0022）排在 M5 之后，见 M3。

### 具名 Agent 的实现条目

- 宿主：读 `<dataDir>/agents/*.md` 并监视目录；解析 frontmatter（`description` 必填，`model`、`thinkingLevel` 选填），名字规则和错误原因随列表一起推；新建、修改、删除调用由宿主写文件
- `subagent` 加 `role` 参数，工具描述列出可用的具名 Agent；定义里写了的模型和思考等级锁定，调用再传就报错；提示词接在固定的子代理说明后面
- 新建对话可选具名 Agent：初始模型和思考等级取它的，提示词接在系统提示词后面，对话记下名字；之后可以换模型，不能换具名 Agent
- `@` 提及：输入框弹出具名 Agent 列表，宿主在这一轮附指令让主模型派给它；和 @ 文件补全共用一个菜单
- Web 和桌面端：设置里的具名 Agent 页（列表、编辑、错误原因），新建对话选具名 Agent，对话头部和子代理卡片显示名字
- 移动端单独做：显示列表、新建对话时能选、`@` 提及；编辑以后再说
- 以后可能的后续，等有需要再做：项目级具名 Agent、工具白名单（等不带 bash 的只读工具集）、`skills` 字段、对话中途换具名 Agent；workflow 另行设计

## 待定优先级：小项

不单独排期，有空或真碰到时再做：

- 上下文用量指示（Pace 的位置行右侧有 context meter；我们的宿主还没暴露用量）。
- 斜杠命令（和 M5 的 `@` 菜单共用 trigger 菜单）。
- 撤回或改写排队中的消息（需要协议新增调用；Pace 是 queued-message 行内的 Withdraw / Steer 操作）。
- 查看和恢复已归档的对话。恢复后 worktree 由 `ensureWorktree` 从保留的分支重建。

## M1：并行任务的审阅与对齐（已完成）

## M2：coding 能力补齐（已完成）

目标：日常 coding 不用再切回 Pi CLI。子代理、MCP 和 codemode 都已完成（见"已完成"）。

工具集和 Pi CLI 的默认一致，就是 read / bash / edit / write 四个。pi-coding-agent 虽然也带了 grep / find / ls，但默认是关的，搜索交给 bash，所以不算缺口，不进 M2。将来需要不带 bash 的只读工具集时再补（比如只读子代理）。届时注意：CLI 的这三个工具是 `AgentTool`，构造时绑死 cwd，直接调本机 fs 和 `child_process`，要基于每次调用的 `api.env` 重写。read 读图片等上游，见"等上游"。

子代理第一版之后可能的后续，都等有明确需求再做：
- 后台子代理（Durable 例 23：spawn / message / wait / stop / list，回答作为 follow-up 回帖给父对话）。
- 并行写冲突现在只靠工具描述约束；真出问题时再考虑只读子代理，或给写文件的子代理单独开 worktree（会改动 ADR-0010 §5）。
- 子代理在界面上怎么呈现已经定了，见 M2.5 的"fork 和子代理的呈现"。

### MCP 的后续

MCP 接入和 codemode 都已完成（ADR-0012、0013）。

codemode 之后可能的后续，都等有明确需求再做：`store` / `load`（要一个跟着 fork 走的可回退文档）、`models`（分类、图片模型）、`deferred` + `tool_search`（可用 Durable 的 `control.addTools`）、CLI 的 `only` 模式、bash 在脚本里返回带退出码的结构化结果。

MCP 本身的后续，都等有明确需求再做：

- 项目级 `mcp.json`：等于让仓库在宿主上不经模型就起任意进程，登记项目时要先确认信任；协议和 Web 都要动。
- OAuth：HTTP server 回 401 现在只在状态里提示"需要登录"；授权链接要经客户端打开、回调回到宿主，和远程访问（ADR-0008）有交集。
- 配置热加载、server 掉线或崩溃后的手动重连：现在都要重启宿主（`service -- restart` 等空闲）。
- MCP resources / prompts 还没有接入方式和呈现。

## M2.5：搬入 Pace 的界面（已完成）

把 Pace 的对话界面和外框搬进 Web 客户端（ADR-0014）。按依赖顺序拆成 stacked PR：

1. 视觉基础（已完成）：Tailwind v4、token 桥、Montserrat、Hugeicons、`@/` 别名；现有界面不改结构，只换底子。
2. 对话流（已完成）：思维链（工具 step 行、思考行、状态行）、Markdown 和代码块；从 Durable 的 `ConversationView` 推导 `CotView`。edit / write 的 diff、codemode 的嵌套调用、工具结果图片、fork 按钮都保留；子代理卡片能点进子对话（运行中也能点），卡片标题用 `subagent` 新增的可选参数 `description`，查看子对话时能回到父对话。
3. 外框（已完成）：Astryx AppShell，侧栏是 wash 底色、主区是白色；顶栏 40px，显示对话标题，子代理对话显示成"父对话 › 子对话"面包屑；右侧 Dock 默认收起，由顶栏按钮开关，有运行中的任务或排队消息时按钮上亮一个点；cwd 和分支移进 Dock 的 Workspace。侧栏按 Pace 分成 New chat、Chats、Projects，操作悬停时才出现，Devices 放在底部。窄屏只有一行顶栏。
4. 首页和 Composer（已完成）：草稿态变成 Pace 的首页——hero（"Build something useful with PiNomad"）、项目选择器、四条建议提示；新建对话可以选模型和思考等级（`createConversation` 加 `model` / `thinkingLevel`，hello 带默认模型，协议 v4）。Composer 换成 Pace 的 ChatPromptInput：左侧是"+"菜单和"模型 · 思考等级"胶囊，运行中带文字的草稿可以排队为 Follow-up 或 Steer，排队消息显示在输入框上方；footer 是位置行（Chat / Git worktree 加分支 / Project folder，草稿里项目可以选 worktree 还是直接在目录里跑）。Dock 的 Queue 区块撤掉，圆点只算运行中的任务。

原来"之后接着做"的余项已经收拢：附件、重试、自动起名、@ 文件补全进 M5，其余进"待定优先级：小项"。

## M3：在哪都能连（进行中）

场景：一台 7x24 常驻的 Linux 机器（Omarchy）当宿主跑任务，出门在外也能连上。自部署中继和 Omarchy 真机常驻都已完成（见"已完成"）。

- 中继的后续，等有需要再做：二维码同时带局域网和中继两个候选地址并自动选择；中继限流；Web 里显示中继连接状态；中继托管页面加 CSP
- tailnet 直连的后续：同时开着中继时，`pinomad pair` 只给出中继链接，要走直连得取出其中的 `pair=…`，拼到 tailnet 地址后面（现在由本机脚本完成）。用一段时间后，再决定是给 `pair` 加一个选地址的参数，还是并入上面的"二维码带多个候选地址"。另外 `--remote-port` 监听的是 `0.0.0.0`，局域网也能访问到；连上后仍要过 IK 握手，所以暂不限制
- 服务端上的账号（ADR-0022，信任模型已定，实现未开始）：中继演进为服务端，环境变量创建唯一用户、不开放注册；Web / App "添加宿主"给出 `pinomad join` 命令，宿主加入账号，取代 `relay-id` + `--allow-host`；客户端登录后列出宿主，第一次进某台宿主时服务端经控制连接要邀请、走现有 IK 配对；宿主设置加"接受账号担保的设备"开关，设备列表标来源，账号加入时提示在线设备；移动端补出示二维码。排在 M5 之后。之后：`apps/relay` 改名 `apps/server`；开放注册、OAuth、配额和限流；账号层面一键把某台设备从所有宿主上踢掉；客户端同时连多台宿主、开始对话时选宿主
- 按 ADR-0009 记下的条件，重新评估要不要加 PiNomad 自己的监管进程
- 按设备区分的权限：只读设备（ADR-0008；审批策略见 ADR-0011）
- 推送通知已挪进 M5；"有问题等你回答"的提示已经有了

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

1. 桌面端 `apps/desktop`（ADR-0020）。外壳、electron-updater、签名公证从 Pace 复制，提交信息注明来源 commit；后端子进程、终端、内嵌浏览器和 Pi 打包相关的 Vite 插件不搬。按堆叠 PR 分步：
   已完成：宿主侧的回环安全通道。外壳：electron-vite 的 renderer 以 `apps/web` 为根目录（共用 `webViteBase()`），页面经 `app://pinomad` 加载、带 CSP；只放行 http(s) 链接到系统浏览器；粘贴配对链接或 `pinomad://pair#…` 深链配对，两者都经 `packages/protocol` 的 `pairingFragment` 规范化成只含 `pair` 和 `url` 的片段；macOS 隐藏标题栏，Web 端按 `data-pinomad-platform` 给红绿灯留位、提供拖拽区；`bun run desktop:package` 打不签名的 dmg/zip，`bun run desktop:e2e` 在本机跑 Electron 端到端（手动，不进 `bun run test`）。多宿主：宿主列表由 main 用 `safeStorage` 加密成单个 `hosts.bin`，经 preload 的 `pinomad:hosts:*` 通道交给 renderer；浏览器照旧在 `localStorage` 存单个设备；侧栏底部切换宿主（记下选择后重载页面，一次只连一台），连不上或被拒的失败页面也能换宿主；新配对不覆盖已有宿主。自动更新：main 里跑 electron-updater（启动 10s 首查、每 4h 复查，自动下载、不自动安装；`PINOMAD_E2E=1` 或未打包时禁用），状态经 `pinomad:updates:*` 通道推给 renderer；菜单有 Check for Updates…（检查出结果时弹原生对话框）；下载完成后侧栏底部出现"Restart to update"；客户端协议旧了的 mismatch 页不再重载、改触发一次更新检查并显示下载/重试/重启状态；更新源是 `release.yml` 传到 GitHub Release 的 `latest-mac.yml`。通知：Web Notification API，窗口不在前台时，任一会话进入等待回答、或非子代理会话的一轮运行结束（完成或失败）就通知，点击切到该会话；首次发送提示词时申请权限。App 图标是 `apps/desktop/build/icon.icon`（Icon Composer 格式，打包时由 actool 编成 Assets.car，需要 Xcode 26+，发布任务因此跑在 macos-26）。

   以后再说：同时保持多台宿主的连接（后台宿主也能发通知）；内嵌浏览器（宿主可能在别的机器上，预览要经安全通道转发端口）；侧栏里还没有"忘记宿主"的入口（只在被拒页面上有 Forget this host）。
2. 移动端 `apps/mobile`（Expo SDK 57 / RN 0.86 / expo-router，UI 用 heroui-native OSS + Uniwind，不用 Pro：仓库公开，Pro 要 license 才能构建）。第一期只做 iOS，目标是能日常用的 MVP；设计 token 先按 HeroUI 默认主题手调接近 Web，两端稳定后再抽共享。按堆叠 PR 分步：
   已完成：骨架和 Hermes 验证。`packages/protocol` 原样在 Hermes 上跑通，Metro 用 `expo/metro-config` 默认配置就能解析 Bun 隔离链接器和包的 `exports`；Hermes 只缺 `crypto.getRandomValues`（入口先加载 `polyfills.ts`，用 `expo-crypto` 补），`TextEncoder` / `TextDecoder`、`URL` / `URLSearchParams`、`WebSocket` 都是原生的，typebox 和 chord delta 正常；局域网 `ws://` 不需要 ATS 例外。配对：粘贴链接或 `pinomad://pair#…` 深链（`+native-intent` 规范化）都先到确认页；宿主列表存 expo-secure-store（`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`，不进 iCloud）；连接页显示连接状态和顶层对话列表，处理被拒、版本不匹配、断线重连。共享推导：`packages/client` 收拢了不依赖 DOM 和 React 的推导（`cot-view`、`family`、`tool-diff-stat`、`run-notifications` 的 `diffRunNotices`、`chat`、`provider-failure`、工具名和工具类别、`StoredHost` 校验），Web 改从这里导入；Web、移动端、桌面端共用 `parseStoredHost`，三端都只接受 `ws:` / `wss:` 地址。浏览器专属的地址解析（`resolveAddress`、设备名）和通知权限留在 Web。对话界面：expo-router Stack，首页是对话列表（Chats 和各项目分组，显示状态和相对时间），点进对话页；连接的 `RemoteDurable` 经 `active-remote` 模块交给兄弟路由，对话页用 `switchConversation` 切过去。对话流用倒置 FlatList 渲染 `deriveChat` 的结果：运行中显示思维链，结束后折叠；工具行可展开参数和输出；子代理只读卡片；Markdown 用 `react-native-marked`（`useMarkdown`，按 HeroUI 主题变量上色）。Composer：浮在对话流上，收起时是一行胶囊，聚焦后展开成卡片（点顶部把手或往下拖收起），里面是"+"菜单（Compact）、"模型 · 思考等级"胶囊（底部弹出面板，可搜索）、发送按钮和位置行；草稿为空时不显示发送按钮，运行中空草稿时显示 Stop。跟 Web 不同，运行中点发送默认是 Follow-up，按住发送按钮会以它为圆心弹出分块的扇形轮盘（现在是 Follow-up 和 Steer 两块），滑到块上松手发送，滑回按钮或滑出扇形松手取消（`expo-haptics` 震动反馈，VoiceOver 走自定义操作）。系统支持 Liquid Glass 时，Composer 卡片、状态和排队条用系统玻璃（`expo-glass-effect`），否则用原来的不透明底色。状态和排队显示在 Composer 上方。待回答的 `ask_user_question` 卡片也在 Composer 上方（`packages/client` 的 `pendingQuestions` / `questionAnswers`，Web 共用）。新建对话页对齐 Web 的草稿首页：可选模型和思考等级、项目，项目里还能选 worktree 或项目目录；草稿里选的模型只存在内存里。模型相关的推导（`modelLabel`、`filterModels`、`reconcileDraftPick` 等）移到 `packages/client/src/model.ts`，Web 共用。还没有 fork、改动面板。返回按钮只显示图标。命令失败在 `RemoteDurable` 里只变成 notice、promise 照常 resolve，移动端把 notice 弹成 toast，建对话和打开对话靠检查命令后显示的是哪个对话来判断成败（`conversation-commands.ts`）。多宿主：一次只连一台；`/hosts` 列出已存宿主（`hostLabels` 移到 `packages/client`，Web 共用），点选切换、确认后忘记，下面可扫码或粘贴再配对一台；当前宿主存在钥匙串的 `pinomad.activeHost`，重启后沿用。连不上或被撤销的页面也有 Hosts 入口，离线的宿主不再挡住配对新宿主。扫码用 `expo-camera`（只要相机权限，不要麦克风），扫到的内容按粘贴链接的同一规则（`pairingFragment`）解析后进确认页；确认后直接回首页（`dismissTo("/")`），不论是从 `/hosts` 还是 `/scan` 进来的。模拟器没有相机，扫码只在真机上能验证。
   发版准备：EAS 项目在 Expo 个人账号 `kieranx` 下，`apps/mobile/eas.json` 配了 `production`（构建号远端自增）和不需要 Apple 账号的 `simulator`；Release 包在模拟器上不依赖 Metro 跑通（内嵌 bundle、Hermes、polyfill、Noise 握手）。流程见 `docs/mobile-release.md`。bundle ID 是 `build.kieran.pinomad`；出口合规声明不使用需要申报的加密（`ITSAppUsesNonExemptEncryption: false`）。移动端版本号独立，不跟 npm 包和桌面端的 `v*` tag 一起发；兼容靠协议主次版本号（ADR-0018），只有主版本号升级时各端一起升，节奏写在发版文档的“版本和发版节奏”一节。
   第一个 TestFlight 构建 0.1.0（3）已经发出。
   真机上扫码配对和用主机名连接都已验证（2026-10-12）。
   接下来：正式图标（优先级不高）。改动面板进 M5；fork、子代理只读展示放在 MVP 之后。
- 设置界面（第一版已完成，PR #58–#61，ADR-0021）。宿主设置存在数据目录的 `settings.json`，没设过的项按键回落到 pi 的设置；凭据仍共用 pi 的 `auth.json`。任一设备改了，其他在线设备立刻看到。堆叠的四步：
  1. 宿主状态流的通用做法：协议里一份宿主流的表（流名 + 值类型 + 引入它的次版本号），网关用一条通用分支提供"内存值 + 完整快照"的流；`mcp` 的快照和订阅之间原本有一个会丢变化的空隙，顺带修掉。
  2. `models`、`auth` 两条流和 `logout` 调用（协议 5.1）：`HOST_STREAMS` / `CALL_SINCE` 就是 ADR-0018 的 `since` 表，客户端只订阅、等待宿主次版本号覆盖的流，调用不支持时提示升级宿主。宿主监视 `~/.pi/agent/auth.json` 所在目录，Pi CLI 登录或退出后调用 `getAvailable()` 刷新并推给客户端（`getAvailableSnapshot()` 不会自己刷新，以前要重启宿主）。
  3. `settings` 流和 `updateSettings` 调用（协议 5.2）：默认模型、思考等级、steering / follow-up 模式；`settings.json` 只存改过的键，未知键原样保留，写入先写临时文件再改名；文件里的默认模型暂时不可用时静默回落，可用后恢复；`initialModel` 选项去掉，新对话和 `hello.defaults` 都读当前生效值。
  4. Web 设置对话框（侧栏底部 Settings，桌面端随之带上），布局照 Pace 的设置：左侧分区导航 Providers / Models / MCP / Chats / About，手机宽度下全屏、先列分区再点进去。Providers 列已存储的登录（"…"菜单登出，二次确认）；Models 默认模型和思考等级；Chats 两种排队模式；MCP 只读配置和服务器状态；About 宿主版本、协议、数据目录和设置文件。各项可恢复成 pi 的默认，宿主版本太旧时显示升级提示。用法见 `docs/usage.md`。
  之后：宿主启动参数的只读展示（协议里还没有，要新增字段）；客户端内登录订阅（授权链接经客户端打开、回调回到宿主，和 MCP OAuth 是同一个难点），届时决定凭据是否分开存；移动端设置；客户端偏好。
- 以后可能有：TUI 客户端（TS，能直接复用 `packages/protocol`）。

## 等上游

不自己实现，也不去上游提 issue，等官方版本带上后随升级（ADR-0002 锁精确版本，升级时顺带评审）接入。

- 目前没有。read 读图片已由上游 1.2.0 带上，升级排在 M5 第 4 项。

## 待定优先级：其余展示类型

ADR-0005 的候选 `progress`、`table`、`log`、`status` 不单独排期，等某个产品功能确实需要结构化呈现时再定义对应的类型，没有产出方的 schema 只是猜测。目前看得到的需求：bash 运行输出（`log`）、MCP server 连接状态和子代理在做什么（`status`）。用不上的类型直接从候选里删掉。每加一个类型：`packages/protocol/src/presentation.ts` 加 schema 和 `classify` 分支、Web 加渲染、测试覆盖"不符合 schema 时兜底"；旧客户端会兜底，不用同步升级。

## 技术债

- npm 上的 `0.0.0-stage` 占位版本可以 `npm deprecate` 掉（要 2FA），不影响安装
- 远程配对测试偶发 `UnauthorizedError`，原因未查明
- Skills 只扫描 `<cwd>/.agents/skills`，在仓库子目录启动时看不到仓库根目录的 Skills；格式有误的 Skill 被直接忽略，不提示用户（ADR-0006）
- 审计和费用统计需要单独的数据来源，`watchEvents` 不能当审计日志（ADR-0002）
- 协议版本号靠人工判断该加哪个，没有机器检查（ADR-0009、0018）；契约快照只盯得住上游的数据结构，我们自己的帧仍靠评审
- macOS 日志不轮转（ADR-0009）
- 消息里的图片以 base64 内联存进 SQLite，每次订阅或重连，宿主都把整段历史连同图片重发（M5 图片靠客户端压缩缓解）；以后可以把图片另存、按需加载

## 不在计划内

- Windows 宿主（ADR-0009）
- Serverless / 云端宿主（ADR-0003）
- 兼容 Pi CLI 的扩展、配置和会话格式（ADR-0001）
- 声明式视图树，等标准展示类型确实不够用时再考虑（ADR-0005）
