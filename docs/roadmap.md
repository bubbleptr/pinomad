# 路线图

唯一一份随进度更新的计划。ADR 只记录难以回退的取舍，"以后再做"的事情都收在这里；做完一项就挪进"已完成"，需要新决策的在条目后注明。

最后更新：2026-10-07

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

## M1：并行任务的审阅与对齐（已完成）

## M2：coding 能力补齐

目标：日常 coding 不用再切回 Pi CLI。子代理已完成（见"已完成"），剩下 MCP，要先写新 ADR。

工具集和 Pi CLI 的默认一致，就是 read / bash / edit / write 四个。pi-coding-agent 虽然也带了 grep / find / ls，但默认是关的，搜索交给 bash，所以不算缺口，不进 M2。将来需要不带 bash 的只读工具集时再补（比如只读子代理）。届时注意：CLI 的这三个工具是 `AgentTool`，构造时绑死 cwd，直接调本机 fs 和 `child_process`，要基于每次调用的 `api.env` 重写。read 读图片等上游，见"等上游"。

子代理第一版之后可能的后续，都等有明确需求再做：
- 后台子代理（Durable 例 23：spawn / message / wait / stop / list，回答作为 follow-up 回帖给父对话）。
- 并行写冲突现在只靠工具描述约束；真出问题时再考虑只读子代理，或给写文件的子代理单独开 worktree（会改动 ADR-0010 §5）。

### 1. MCP 接入（ADR-0004 定为早期的外部扩展入口；需要新 ADR）

- 现状：没有。pi-coding-agent 1.0.4 有一套完整的 MCP 实现（`createMcpExtension`：stdio / streamable HTTP 传输、OAuth、`codemode` / `deferred` / `direct` / `hidden` 四种暴露方式、resource 工具），但它是 CLI 的 `ExtensionFactory`，依赖 CLI 的会话和 `/mcp` 界面，装不进 Durable 的 registry。能复用多少（配置解析、传输、`mcp__<server>__<tool>` 命名约定）要先调研。
- ADR 要定的事：
  - 配置从哪读：ADR-0006 定了 AGENTS.md / Skills 不读 `~/.pi`，但模型认证和 settings 复用 `~/.pi/agent`。`mcp.json` 跟哪边走：`~/.agents/mcp.json` 加 `<project>/.agents/mcp.json`，还是复用 pi 的。项目级配置等于让仓库在宿主上启动任意命令，要不要先让用户确认信任。
  - 连接生命周期：stdio server 在宿主进程里常驻一份、按 cwd（worktree）各起一份，还是按对话起；宿主等空闲重启（ADR-0009）时怎么关。
  - 暴露方式：第一版是否只做 `direct`（工具直接声明给模型），codemode / tool_search 以后再说。
  - 崩溃重放：无法知道 MCP 工具是否幂等，一律不声明 `replay: "safe"`，中断后模型拿到 `interrupted`。
  - OAuth：宿主没有界面，授权链接得经客户端打开，回调还要回到宿主，和远程访问（ADR-0008）有交集。第一版可以只支持不需要登录的 server。
  - 呈现：结果里的文本照常显示；`structuredContent` 走兜底渲染，不映射到展示类型。MCP 工具也可能返回图片，而 Web 工具卡片现在会丢掉图片（见"等上游"的 read 读图片），两边要用同一套图片渲染，MCP 先做的话就在这里补上。
  - 状态可见：客户端至少要能看到每个 server 连上没有、错误是什么。先用宿主的 warning 广播。
- 验收：本地起一个 stdio 测试 server，模型能调用它的工具，结果出现在对话里；配置错误和连接失败在客户端有提示。

## M3：在哪都能连

- 可以自己部署的中继（ADR-0008 第二期）；同时按 ADR-0009 记下的条件，重新评估要不要加 PiNomad 自己的监管进程
- 移动端形态：PWA 还是 Expo。这一项也决定浏览器客户端代码可信的问题怎么解决（需要新 ADR；ADR-0008 后果）
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

- 桌面端（Electron 外壳，按 ADR-0001 从 Pace 复制）
- 设置界面，连带决定 PiNomad 要不要有自己的设置文件（ADR-0006 遗留）
- 取消归档、查看已归档对话
- 新建对话时选择模型
- 对话自动起名（ADR-0007 遗留）

## 等上游

不自己实现，也不去上游提 issue，等官方版本带上后随升级（ADR-0002 锁精确版本，升级时顺带评审）接入。

- read 读图片（ADR-0002、0006 遗留）：Pi CLI 的 read 能读图片，Durable 的 read 识别出图片后返回 `unsupported_image`，README 写的是 "not supported yet"。截至 2026-10-07，上游 main 和 CHANGELOG 的 Unreleased 都还没有，也没有对应的 issue 或 PR。上游支持后，PiNomad 这边还要做：Web 的 `chatItems` 用 `textOf` 只取 text 块，会丢掉工具结果里的图片，要在工具卡片里显示出来。

## 待定优先级：其余展示类型

ADR-0005 的候选 `progress`、`table`、`log`、`status` 不单独排期，等某个产品功能确实需要结构化呈现时再定义对应的类型，没有产出方的 schema 只是猜测。目前看得到的需求：bash 运行输出（`log`）、MCP server 连接状态和子代理在做什么（`status`）。用不上的类型直接从候选里删掉。每加一个类型：`packages/protocol/src/presentation.ts` 加 schema 和 `classify` 分支、Web 加渲染、测试覆盖"不符合 schema 时兜底"；旧客户端会兜底，不用同步升级。

## 技术债

- Linux systemd 用户单元还没在真机上验证（ADR-0009）
- 远程配对测试偶发 `UnauthorizedError`，原因未查明
- Skills 只扫描 `<cwd>/.agents/skills`，在仓库子目录启动时看不到仓库根目录的 Skills；格式有误的 Skill 被直接忽略，不提示用户（ADR-0006）
- npm 打包发布：Node 不对 `node_modules` 做类型剥离，宿主要先构建成 JS（ADR-0009）
- 审计和费用统计需要单独的数据来源，`watchEvents` 不能当审计日志（ADR-0002）
- 协议版本号靠人工在破坏性变更时加一，没有机器检查（ADR-0009）
- macOS 日志不轮转（ADR-0009）

## 不在计划内

- Windows 宿主（ADR-0009）
- Serverless / 云端宿主（ADR-0003）
- 兼容 Pi CLI 的扩展、配置和会话格式（ADR-0001）
- 声明式视图树，等标准展示类型确实不够用时再考虑（ADR-0005）
