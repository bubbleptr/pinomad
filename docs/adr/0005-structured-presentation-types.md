# ADR-0005：插件状态通过 PiNomad 定义的展示类型呈现

- 状态：Proposed
- 日期：2026-10-04

## 背景

Durable 加 chord 保证插件状态是可同步的结构化 JSON：文档有 `kind` 和 `version`，和对话在同一个事务里提交，以"快照 + 增量"同步给所有客户端；交互走 service 方法或文档写入，不再是阻塞对话框。

但"结构化"不等于"能渲染"：

- 文档结构只在 TypeScript 编译期受 `JsonObject` 约束，没有运行时 schema；
- 工具结果的 `details` 是泛型 `JsonValue`；
- chord 只保证跨边界的数据是合法 JSON，不管 JSON 表达什么意思。

两个插件可能用完全不同的 JSON 表达同一类东西，客户端无从知道。这一层语义需要 PiNomad 自己定义。

## 决策

呈现分三层：

1. **通用兜底**：不认识的文档或 `details`，用 JSON 树或键值列表展示。各端行为一致，永远能显示。
2. **标准展示类型（主力）**：PiNomad 发布一组带运行时 schema 的标准类型（候选：`pinomad.todo`、`pinomad.progress`、`pinomad.approval`、`pinomad.diff`、`pinomad.table`、`pinomad.log`、`pinomad.status`）。数据符合 schema，就由设计系统在各端统一渲染；客户端在边界上做校验，不符合就退回第 1 层。需要多端安全的交互（如审批）必须用文档实现，以先写入者为准。
3. **声明式视图树（暂不做）**：用 JSON 描述受限的组件树并绑定到文档路径和 service 方法。等第 2 层确实不够用时再考虑。

## 待验证

先做一个小实验再把状态改为 Accepted：定义 `pinomad.todo` 和 `pinomad.approval` 两个 schema，写一个内置扩展产出它们，确认桌面和 Web 都能渲染和交互，不符合 schema 时能退回兜底。
