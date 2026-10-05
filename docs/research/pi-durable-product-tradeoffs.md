# 基于 Pi Durable 构建另一种 Agent 产品：Pace 能力取舍

研究日期：2026-10-02。**这是能力分析，不是采用决定或迁移计划。** 当前工作区依赖为 `pi-coding-agent` / `pi-ai` 1.0.0；Durable 对照 1.0.0 发布包。仅新增本文，没有修改产品代码。[依赖](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/package.json)、[Durable README](https://unpkg.com/@earendil-works/pi-durable@1.0.0/README.md)

结论：更换执行框架并不等于失去所有成熟能力。真正需要承担的是现有扩展 API、会话存储格式和产品行为的重新接线；可以继续使用 coding-agent 包提供的独立设施，也可以保留 Pace 自己的界面。

## 能力分类

| 能力 | Pace 目前实际依赖 | 使用 Durable 后的边界 |
| --- | --- | --- |
| 模型请求、切换模型/思考等级 | AgentSession 与 ModelRuntime | Durable 已有模型配置和 pi-ai 调用，改 API；不必重写模型协议 |
| 恢复、分叉、历史 | SessionManager 与 Pi JSONL，Pace 另做索引/展示投影 | Durable 有恢复、fork、entries；旧 JSONL 不能直接视为 Durable Storage，需要导入或旧引擎阅读路径 |
| 排队、steer、停止、压缩、重试 | AgentSession 控制与事件 | Durable 已有对应机制；Pace 队列重排、撤回、消息身份和状态映射要另行适配 |
| 模型凭据、OAuth、账户模型目录 | coding-agent 的 ModelRuntime + Pace 账户过滤 | ModelRuntime 实现 pi-ai Models，可保留并传给 Harness；需装配，非 Durable 自动读取 |
| Skills、AGENTS.md、提示词、包管理 | DefaultResourceLoader、SettingsManager、DefaultPackageManager、loadSkills | 文件与解析设施可复用；发现、注入、斜杠命令和设置规则需由产品接线 |
| 现有 Pi 扩展 | ExtensionAPI、事件钩子、命令、工具、session 生命周期 | 不直接兼容 Durable 的 defineExtension/defineTool；按使用到的接口适配或移植 |
| MCP、codemode、tool_search | Pace 显式安装 coding-agent 内置扩展 | 不会随 Harness.open 自动出现；MCP 协议设施可研究复用，Agent API 绑定要改 |
| 聊天、文件、Git、终端、浏览器、设置界面 | Pace React/Electron 与自身 Gateway | 不必全部重写；数据适配与新产品交互需要调整 |

## 1. 执行能力已有对应机制，API 与语义仍要对齐

Pace 的 Driver 实际暴露创建/恢复/分叉、prompt、follow-up、steer、停止、模型配置、工具 schema、命令目录与快照。Durable 提供 `configure`、`submit`、`fork`、`abort`、`compact`、`context`、`entries`，以及 retry/compaction 设置；这不是把这些能力从零重做。[Pace Driver](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/gateway/runtime-gateway.ts)、[Durable 类型](https://unpkg.com/@earendil-works/pi-durable@1.0.0/dist/harness/types.d.ts)

但 Pace 的队列不是简单按钮转发：adapter 记录消息身份，调用 SDK 的 `clearQueue` / `followUp` / `steer` 实现撤回、重排与转为 steer。Durable 的提交 ID、inbox 和取消接口应重新映射，不能假设旧队列实现直接可用。[队列适配](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/drivers/pi-sdk-runtime-adapter.ts)

Pace 观察 compaction/retry 事件并显示状态；当前 Driver 没有专门的 compact、retry、tree 导航或 HTML export 命令。不要把 coding-agent 完整 CLI 功能清单误写成 Pace 已实现的功能清单。[事件归一化](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/gateway/agent-runtime-event-normalizer.ts)、[Driver 契约](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/gateway/runtime-gateway.ts)

## 2. 旧会话兼容是独立成本

Pace 恢复调用 `SessionManager.open(sessionFile)`，分叉调用 `createBranchedSession` 或创建新 SessionManager；历史列表和详情还直接扫描、解析 Pi JSONL。Durable 自己保存 conversation、entry、task、document 和 submission。即使二者都提供 JSONL 后端，也不代表格式相同。[SDK 恢复/分叉](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/drivers/pi-sdk-runtime-adapter.ts)、[历史解析](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/workspace/sessions.ts)、[Durable 存储类型](https://unpkg.com/@earendil-works/pi-durable@1.0.0/dist/types.d.ts)

新产品可以选择保留旧会话只读入口，或做明确的导入；没有证据表明可无损带入旧扩展状态、未完成工具、树导航及导出语义。这里的成本是兼容产品数据，不是 Durable 没有恢复与分叉。

## 3. 凭据、技能和包管理不必一起丢弃

Pace 的模型目录与 OAuth 已通过 `ModelRuntime` 装配，并叠加账户可用模型过滤。coding-agent 1.0.0 的 `ModelRuntime implements Models`；Durable 的 `HarnessOptions.models` 正是 `Models`，所以可以保留这层设施，独立于 AgentSession 使用。仍需核对凭据路径、provider 注册、刷新和生命周期。[账户模型](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/workspace/account-models.ts)、[认证](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/workspace/provider-auth.ts)、[ModelRuntime 契约](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/core/model-runtime.d.ts)

Pace 每个 Session 进程创建 `SettingsManager`、`DefaultResourceLoader`，并调用 `reload()`；包安装/更新使用 `DefaultPackageManager`；命令补全从技能、模板与扩展命令生成。Skills Markdown 与解析器可复用，但 Durable 不会自动采用这些文件发现和输入展开规则。[Session 装配](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/drivers/session-process-entry.ts)、[资源管理](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/workspace/resource-management.ts)、[静态命令](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/workspace/prompt-commands.ts)

官方 Durable coding 示例另行复用 coding-agent 的 `ModelRuntime`、项目上下文与技能加载设施，说明“换 harness”与“完全移除 coding-agent 包”是不同选择；示例不是旧扩展 API 自动兼容的证明。[官方实验示例目录](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/experimental/durable)

## 4. 主要缺口是现有扩展契约，不是扩展这个概念

Pace 读取已注册扩展命令、绑定扩展错误、发送 `session_shutdown`，还有依赖特定扩展事件的子代理 shim。Durable 的扩展是 tools、sections、hooks、tasks 等定义的集合，工具参数与宿主 API 也不同。原来的扩展文件不能仅换 import；凡依赖 `ExtensionAPI`、`ctx.ui`、SessionManager、AgentSession 事件或特定消息格式的行为都要审计。[SDK 适配](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/drivers/pi-sdk-runtime-adapter.ts)、[Durable 扩展类型](https://unpkg.com/@earendil-works/pi-durable@1.0.0/dist/harness/types.d.ts)

Pace 当前 `bindExtensions` 只传 `onError`，没有完整提供 `uiContext`；主题资源也明确只影响 Pi 终端。不能将 TUI 交互和主题整体算作迁移后才失去的 Pace 功能。[扩展绑定](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/drivers/pi-sdk-runtime-adapter.ts)、[主题边界](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/workspace/resource-management.ts)

## 5. MCP、codemode 与工具差异需要单列

Pace 明确通过 `createPaceBuiltInExtensions()` 装入 codemode、tool_search、MCP；SDK 本身也不会替 Pace 默认装它们。MCP 设置页还借用 coding-agent 的 config/CLI/OAuth 内部模块。管理界面与凭据未必重做，但工具注册、调用、暴露策略与 Durable 生命周期需要接线。[内置扩展](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/drivers/pi-builtin-extensions.ts)、[MCP 管理](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/workspace/mcp-servers.ts)、[内部模块别名](https://github.com/bubbleptr/pace/blob/2315db6/tsconfig.json)

Durable 1.0.0 自带 read/write/edit/bash，并不等于完整 coding-agent 工具集；其 read 工具不支持读图片。Pace 目前发送的用户图片附件与“Agent 读取本地图片”是两个不同入口，不能把前者也误判为 Durable 不支持。[工具契约](https://unpkg.com/@earendil-works/pi-durable@1.0.0/dist/tools/index.d.ts)、[Durable README](https://unpkg.com/@earendil-works/pi-durable@1.0.0/README.md)、[图片输入适配](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/drivers/pi-sdk-runtime-adapter.ts)

## 6. Pace 的界面资产可以保留，状态桥接仍有工作

Pace 已把 SDK 隔在 Normalizer/Runtime Gateway 后面，renderer 消费自己的消息、状态和能力契约。聊天、轨迹、输入框、设置、Git/文件/终端/浏览器的组件不因换 harness 自动失效。新的 driver 或投影桥可以继续满足已有契约；如果新产品选择不同交互，再按需求改 UI。[架构](https://github.com/bubbleptr/pace/blob/2315db6/README.md#architecture)、[核心事件契约](https://github.com/bubbleptr/pace/blob/2315db6/packages/core/src/agent-runtime-event.ts)、[Gateway](https://github.com/bubbleptr/pace/blob/2315db6/packages/core/src/runtime-gateway.ts)

这不保证只改一个 adapter：session/entry 身份、上下文用量、消息重连、工具详情、嵌套调用、统计和旧历史解析都在接入范围。Durable 的快照与 watch 可减少客户端猜测，但其慢观察者会跳到最新快照，不能原样当成 Pace 的追加式审计日志。[Durable 观察实现](https://unpkg.com/@earendil-works/pi-durable@1.0.0/dist/session/observation.js)、[Pace 事件 Journal](https://github.com/bubbleptr/pace/blob/2315db6/packages/backend/src/persistence/session-event-journal.ts)

## 核验边界

这是阅读当前工作区与发布包所得的能力清单，没有实现替换或运行兼容性验证。适合先决定新产品需要哪些体验，再选择复用设施；不要求为了兼容旧 CLI 而实现全部旧功能。文档改动不涉及运行行为，因此未运行产品测试。
