# ADR-0005：插件状态通过 PiNomad 定义的展示类型呈现

- 状态：Accepted（2026-10-05，见文末验证结果）
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

## 验证结果（2026-10-05）

原定的实验是：定义 `pinomad.todo` 和 `pinomad.approval`，写内置扩展产出它们，确认桌面和 Web 都能渲染、交互，不符合 schema 时退回兜底。当时还没有桌面端，验收改为"两个 Web 客户端 + 宿主测试"。实验通过，状态改为 Accepted。落地时定下的细节：

- **schema 放在 `packages/protocol/src/presentation.ts`**，用 TypeBox（`typebox`，与 pi-ai 同版本）写，宿主和客户端共用同一份校验。`classify()` 只在宿主声明了展示类型并且数据通过 `Value.Check` 时才返回具体类型，其余情况（没声明、不符合、客户端不认识的新类型）一律兜底。
- **文档 kind 和展示类型是两回事**：kind 归扩展所有（如 `todo.list`、`approval.requests`），展示类型在注册扩展时声明（`ExtensionDoc.presentation`），随 hello 帧下发。同一个展示类型可以由多个扩展的不同文档使用。
- **标准类型的交互由核心实现**，扩展不实现。审批的 `decide` 调用由网关对着 `pinomad.approval` 的 schema 在一个事务里写入决定，先写入者为准，返回 `first` 告诉调用方自己是否生效。
- **审批完全存在文档里**：待审批请求和决定都在文档中，宿主重启后各客户端看到的仍是同一份状态。工具 `request_approval` 声明为 `replay: "safe"`，按 `callId` 去重，重放时不会产生重复请求。
- **取消走 Durable 的 abort 协议**：工具调用创建一个归它所有的子任务 `approval.wait` 来等待决定。中止对话时子任务先被中止，由子任务的 `abort` 处理器写入 `cancelled`。中止标记打上后，run 模式的 invocation 不能再提交，所以工具自己在中止时写不进去，只有新开的 abort invocation 可以写。等待中的 phase 必须响应 `runtime.signal`，否则 abort invocation 排不上，`conversation.abort()` 会一直挂住。

`pinomad.approval` 后来由 ADR-0011 换成了 `pinomad.question`，上面记下的文档、先写入者为准、abort 取消这套机制原样沿用。

尚未覆盖：工具结果 `details` 的展示类型声明；其余候选类型；桌面端和移动端渲染。
