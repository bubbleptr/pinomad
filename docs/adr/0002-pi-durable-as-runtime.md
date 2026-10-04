# ADR-0002：以 Pi Durable 作为运行时内核，Durable 存储是唯一事实来源

- 状态：Accepted
- 日期：2026-10-04

## 背景

Durato 需要两种 Pi Coding Agent 的 `AgentSession` 提供不了的能力：

- 执行可恢复：宿主进程崩溃或重启后，未完成的模型调用和工具任务能从检查点继续；
- 多个客户端同时观察、操作同一个会话。

`@earendil-works/pi-durable` 提供持久化对话、不可变 transcript、原子提交（transcript + 文档 + 任务）、带检查点的任务状态机、fork、abort、子代理所有权，以及"快照 + 增量"的 `watchEvents`。Pace 仓库里的两个实验在 1.0.0 上验证过这些能力：

- `spikes/durable-multiview`：TUI、Web、Pace 三端作为普通客户端共用一个宿主，宿主被强杀后恢复的是原会话和子代理；
- `spikes/durable-cloudflare`：在本地 workerd 里，PiHarness 跑在 SQLite Durable Object 中，提交可去重，alarm 能唤醒恢复。

## 决策

1. 运行时内核使用 Pi Durable 的 `Harness`，不使用 Pi Coding Agent 的 `AgentSession`。
2. Durable 存储是对话、文档、任务状态的唯一事实来源。不另外维护一份事件 Journal 去复刻运行事实；呈现层只从 Durable 存储派生。
3. 认证、模型目录（`ModelRuntime`）、Skills 加载等独立设施，可以从 `pi-coding-agent` 包里复用，但不引入它的会话或扩展机制。
4. 上游标注为 Experimental（"The API changes without notice between releases"），所以：
   - 锁定精确版本，升级时显式评审；
   - Durable 和 chord 的调用集中在少数几个适配模块里，领域代码不直接依赖上游类型。

## 后果

- 可恢复性有边界，产品不能对外承诺超出这些边界的语义：
  - 恢复的是显式检查点，不是 JavaScript 调用栈；
  - 工具能否安全重放取决于工具自己声明的 `safe` 契约，不能证明外部副作用是幂等的；
  - `requestId` 去重的是提交记录，不是外部副作用；
  - `failFast` 不会补偿已经完成的任务；
  - 本地存储只能由一个进程持有，不提供分布式选主。
- `watchEvents` 的观察者落后太多时会直接拿到新快照，所以它不能当作只追加的审计日志用。如果以后需要审计或费用统计，要单独设计数据来源。
- Durable 自带的工具只有 read/write/edit/bash，`read` 不支持图片，其余 coding 工具需要第一方补齐。
