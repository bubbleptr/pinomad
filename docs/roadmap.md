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

## M1：并行任务的审阅与对齐（已完成）

## M2：coding 能力补齐

- grep / find / ls 工具；read 支持图片（ADR-0002、0006 遗留）
- 子代理工具（Web 端已经能渲染子代理对话，宿主还没有生成子代理的工具）
- MCP 接入（ADR-0004 定为早期的外部扩展入口）
- 其余候选展示类型：`progress`、`table`、`log`、`status`（ADR-0005）

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

## 技术债

- Linux systemd 用户单元还没在真机上验证（ADR-0009）
- 远程配对测试偶发 `UnauthorizedError`，原因未查明
- Skills 只扫描 `<cwd>/.agents/skills`，在仓库子目录启动时看不到仓库根目录的 Skills；格式有误的 Skill 被直接忽略，不提示用户（ADR-0006）
- npm 打包发布：Node 不对 `node_modules` 做类型剥离，宿主要先构建成 JS（ADR-0009）
- 审计和费用统计需要单独的数据来源，`watchEvents` 不能当审计日志（ADR-0002）
- 协议版本号靠人工在破坏性变更时加一，没有机器检查（ADR-0009）
- macOS 日志不轮转（ADR-0009）
- `@earendil-works/*` 锁在 1.0.0，评审并升级到 1.0.4（ADR-0002）。1.0.3/1.0.4 的破坏性变更针对自己实现的 `ExecutionEnv`，我们只直接用 `NodeExecutionEnv`，预计影响小；另外三个包的变更还没看。放在 M2 之前做，grep/find/ls 可以用上新增的 `openDirReader()`、`scanLines()`

## 不在计划内

- Windows 宿主（ADR-0009）
- Serverless / 云端宿主（ADR-0003）
- 兼容 Pi CLI 的扩展、配置和会话格式（ADR-0001）
- 声明式视图树，等标准展示类型确实不够用时再考虑（ADR-0005）
