# ADR-0039：Fork 作为左侧独立对话，右侧只保留 Tasks

- 状态：Accepted
- 日期：2026-11-02
- 修订：ADR-0007 §1、§2（Fork 的展示位置）；ADR-0019 背景与"考虑过的方案"中的 thread 定位；ADR-0038 §2（"Fork 不进入左侧"）

## 背景

ADR-0007 把 Fork 和子代理一起收在顶层对话旁边，ADR-0019 又把 Fork 的界面定成父对话右侧的 thread。实际使用中 Fork 很少被打开，用户也不认为单用户 coding agent 适合 Slack 式 channel / thread 模型：右侧 Threads 让 Fork 变成父对话的附属视图，而不是可以直接回到的对话。

Fork 本身仍然是一个有独立消息、运行状态和继续对话能力的 Durable 对话。展示方式不必把它变成另一类对象——它可以像顶层对话一样被导航和打开，只是仍属于同一个家族、共用父对话的执行检出。

## 决策

1. **Web/桌面端把 Fork 作为左侧独立对话行。** 在原来的"机器 → 项目 / Chat"分组里，每个根对话之后按家族现有稳定顺序列出它的 Fork；根对话之间的排序不变，也不改成全局 recency 排序。真实 `parent` 树、检出共用和一层 Fork 的规则都不变。

2. **Fork 在主区打开。** 左侧行、创建后的交接和消息上的 "N forks" chip 都打开主区，不再打开右侧面板。多宿主用 `{ hostKey, conversationId }` 导航；单连接即使带 `hostKey`、但没有 ReadyHost 的 `hostOpen`，也走自己的直接主区打开路径。主区继续显示继承的父前缀、完整 composer 和回到父对话的 breadcrumb；Fork 可以正常提交、中止和继续运行。

3. **根行与 Fork 行选中互斥。** 主区显示 Fork 时只有 Fork 行处于选中状态，不能同时高亮根对话；回到根对话后选中状态还给根行。

4. **右侧只保留 Tasks。** 删除 Threads 页签、Fork 列表和只供右侧 Fork 使用的 detail / composer。Foreground Subagent 继续按完整 root 家族聚合在 Tasks 中，Background Subagent 仍按 ADR-0038 只在根对话的 Background 投影里出现一次，Foreground 不进入左侧。右侧活动指示只反映 Tasks 中可见的 Foreground 活动。

5. **Fork 的生命周期不变。** Fork 行保留 Rename，但不提供 Archive：宿主只归档顶层 IndexEntry。归档根对话仍带走整个家族；不增加 Fork 独立归档、独立 checkout 或嵌套 Fork。

6. **创建后的交接走不可见的 side 暂存。** 宿主的 fork 调用不等待 conversation-list，所以客户端用现有的 `show: "side"` 把新 Fork 暂存在内部 side；pending 操作记录 `parentId` 和 `entryId`。只有暂存 side 的摘要满足 `kind === "fork"`、`parent === parentId`、`forkedAt === entryId`，才通过正常主区导航打开这个明确的 Fork id，并且只在当前 side 仍属于本次暂存时清理它。暂存期间主区一直停在父对话；用户切走、卸载或迟到的命令都不自动跟随。命令结束若没有属于本次操作的暂存 side，就释放 busy、允许重试；用户已打开其他 Task side 时不得误清。

## 考虑过的方案

- **保留右侧 Threads，只把 Fork 再加一份到左侧**：同一对话出现两个导航位置、两套打开方式，用户仍然要理解 thread 模型；这次要移除的正是这层模型。
- **把 Fork 提升为全局顶层列表并按 recency 排序**：会打散"根对话之后是它的 Fork"的家族关系，也改变现有根对话排序；这次只做展示投影，不改数据模型。
- **继续用 channel / thread 作为用法模型**：单用户 coding agent 没有多人协作场景，thread 的嵌套、每消息多个 Fork 等能力反而增加理解成本。

## 后果

- 这是 Web/桌面端共用的 `apps/web` 展示和导航改动，桌面端自动继承；iOS 保持不变。
- 不改宿主数据模型、线上协议、`packages/protocol`、`packages/client`、Rust core 或 FFI，不需要升级 `PROTOCOL` 或重录快照。
- 旧的多 Fork 和嵌套 Fork 数据仍可导航：它们按家族顺序全部列在根对话后，不会因为这次投影丢失。
- 用法文档和术语表不再把 Fork 描述成 thread；Fork、Foreground、Background 三种入口在文档里明确区分。
