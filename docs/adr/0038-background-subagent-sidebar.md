# ADR-0038：Background Subagent 进入左侧对话层级

- 状态：Accepted
- 日期：2026-11-02
- 修订 ADR-0007 §1（子代理的展示位置）
- 部分修订：ADR-0039 §2（Fork 进入左侧独立导航；Background 的展示与家族聚合不变）
- 部分修订：[ADR-0046](0046-one-kind-of-subagent.md) §6（§1 的 `lifecycle` 可以从 foreground 单向变成 background；§3 主内容区可以给子代理发消息和 Stop）
- 部分修订：[ADR-0047](0047-subagents-in-tasks-read-only.md)（§2、§3、§5：Background 不再进左侧，所有子代理都在右侧 Tasks，对用户只读加 Stop）

## 背景

ADR-0007 把 fork 和子代理都收在顶层对话旁边，不进入左侧列表。引入子代理生命周期分类后，Foreground Subagent 仍属于发起它的 Run，但 Background Subagent 在父对话空闲后仍需要被找到、观察和以后显式控制。继续只放在右侧 Tasks 会让这类工作失去稳定入口。

但不能简单地把每个 Durable Conversation 都提升为侧栏条目：一次性 Foreground Subagent、内部任务和工具执行会让导航迅速膨胀。还需要同时解决 fork 派发的后台子代理、真实模型图标，以及子代理在主内容区的只读边界。

## 决策

1. **子代理有稳定的 `lifecycle` 分类：`foreground` 或 `background`。** 它在创建时确定，完成、失败、父级后续 Run 和宿主重启都不改变，不能从只含存活任务的 taskGraph 临时推导。协议 5.26 在 `ConversationSummary` 上增加可选 `lifecycle`；旧宿主和旧数据缺省为 Foreground。当前已有的子代理全部是 Foreground。

2. **左侧只展示 Background Subagent，按 root 家族压成一层。** 展示集合来自完整家族树，包含 `root → fork → background` 的后代；真实 `parent` 始终保留实际派发者，不为视觉层级改写。Fork 和 Foreground Subagent 不进入左侧。`familyStatus`、`familyUpdatedAt` 仍聚合完整家族，不能用裁剪后的展示树计算。

3. **Foreground 留在右侧 Tasks，所有打开入口按 lifecycle 统一。** 右侧列表和 Overview 不再重复 Background；侧栏、子代理卡片、Overview 和深链都把 Background 打开到主内容区。主内容区的子代理保持只读，不出现 composer、普通 abort/Stop、提交重试、取回编辑、Fork 或修改模型，不能把普通 `abort()` 冒充为未来的后台 stop。

4. **摘要可携带子代理实际启动模型。** `ConversationSummary.model` 来自 `SubagentDoc` 记录的创建时模型，用于左侧的 ModelLogo；旧数据没有时留空并保留对齐，不用父模型或当前 role 配置猜测。该字段同样适用于 TS、Rust core 和 FFI 双向转换。

5. **左侧是轻量导航，不是通用任务面板。** root 可展开/折叠，折叠时显示实际可见的 Background 数量；展开状态按宿主和 root 存在本机。子行使用模型 Logo 和自身状态，虚线树线只表达一层视觉归属，不展示 Durable 的 generation/tool task。

## 考虑过的方案

- **所有 Conversation 都进左侧**：包括一次性 Foreground 和 Fork，条目太多；侧栏应是导航而不是完整审计树。
- **只取 root 的直接子节点**：`root → fork → background` 会从左侧消失，右侧又过滤 Background 后两处都找不到。
- **Background 也留在右侧 Tasks**：同一工作出现两个导航位置和两套交互，失去这次拆分的意义。
- **从 taskGraph 推导 lifecycle**：owner task 终结后分类会丢失，无法保证完成后的稳定展示。

## 后果

- 当前线上只有 Foreground，因此本决策先建立协议和 UI 契约，不会把现有子代理搬到左侧；Background 的 spawn / message / stop / persistent 执行能力另行实现。
- 客户端必须分别计算完整家族聚合、左侧 Background 投影和右侧 Foreground 集合。测试要覆盖混合家族、fork 后代、旧数据缺省、完成后保留和 FFI 往返。
- 本次只做 Web 和桌面端共用的 `apps/web`；iOS 的对应导航另行设计。
