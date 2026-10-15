# AgentChatKit — Agent 说明

给 agent 对话用的 SwiftUI 组件库，支持 iOS 26+ 和 macOS 26+。最先服务的是 PiNomad 的原生 iOS 评估（还没决定取代它的 Expo 版），以后可能开源。最重要的两个组件是流式 Markdown 和 agent trace（思考、工具调用、中途输出、最终回答）。

## 布局

- `AgentChatCore`：不依赖 SwiftUI。流式 Markdown 的增量解析和半截语法预判、agent trace 的数据模型和展示规则。解析交给 `swift-markdown`（cmark-gfm），流式这一层是自己写的。
- `AgentChatKit`（还没建）：SwiftUI 视图，只依赖 `AgentChatCore`。
- Demo App（还没建）：回放录好的数据流，用来截图验证视图。

trace 用本库自己的通用模型，不引用 PiNomad 的类型；语义对照 PiNomad 的 `packages/client/src/cot-view.ts`（phase、step），由使用方写适配层。流式 Markdown 的行为对照 MyGo 的规格：https://mygo.egoist.dev/docs/ui/markdown

## 开发和验证

在 omarchy 上改代码，Swift 只能在 mbp 上构建：`scripts/mbp swift test` 会把工作区 rsync 到 mbp 的 `~/code/projects/AgentChatKit` 再在那边执行，跑完把 `Package.resolved` 拉回来。mbp 离线时没法构建和测试。

测试只放在这几个边界上：

- 流式解析器（`MarkdownStream` 的 `append` / `finish` / `blocks`）：同一段文本不管怎么切分，结果都一样；已闭合的块不再变化；半截语法按预判显示；`finish()` 之后和 cmark-gfm 一次性解析的结果一致。
- trace 的展示规则（自动展开和收起、摘要）。纯数据结构不测。
- 视图不写单元测试，用 Demo App 在模拟器上截图验证。

## 约定

- 依赖锁精确版本，不用发布不到 7 天的版本。
- 改代码走 `feat/` / `fix/` / `chore/` 分支和 PR，提交信息用 Conventional Commits。
- 代码注释用英文，优先写为什么。文档用中文，放在 `docs/` 下。
