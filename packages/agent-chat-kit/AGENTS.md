# AgentChatKit — Agent 说明

给 agent 对话用的 SwiftUI 组件库，支持 iOS 26+ 和 macOS 26+。最先服务的是 PiNomad 的原生 iOS 评估（还没决定取代它的 Expo 版），以后可能开源。最重要的两个组件是流式 Markdown 和 agent trace（思考、工具调用、中途输出、最终回答）。

## 布局

- `AgentChatCore`：不依赖 SwiftUI。流式 Markdown 的增量解析和半截语法预判、agent trace 的数据模型和展示规则。解析交给 `swift-markdown`（cmark-gfm），流式这一层是自己写的。
- `AgentChatKit`：SwiftUI 视图（`MarkdownView`、`StreamingMarkdown` + `StreamingMarkdownView`、`AgentTraceView`、`Transcript`、`UserMessageView`），只依赖 `AgentChatCore`。逐词淡入用 `TextRenderer`，只作用在还在流式输出的最后一段文字上，靠环境值 `tailFade` 沿最后一个子块往下传。
- `Demo/`：iOS Demo App，回放一段脚本化的 agent 运行（`Replay.swift`），用来截图验证视图。Xcode 工程是手写的，用了同步文件夹（Xcode 16+），往 `Demo/AgentChatDemo/` 加文件不用改工程。

trace 用本库自己的通用模型，不引用 PiNomad 的类型；语义对照 PiNomad 的 `packages/client/src/cot-view.ts`（phase、step），由使用方写适配层。流式 Markdown 的行为对照 MyGo 的规格：https://mygo.egoist.dev/docs/ui/markdown

## 开发和验证

在 omarchy 上改代码，Swift 只能在 mbp 上构建：`scripts/mbp swift test` 会把工作区 rsync 到 mbp 的 `~/code/projects/AgentChatKit` 再在那边执行，跑完把 `Package.resolved` 拉回来。mbp 离线时没法构建和测试。

`scripts/demo 2 8.5` 在 mbp 上构建 Demo、装到已启动的 iPhone 17 Pro 模拟器并启动，启动后第 2 秒、第 8.5 秒各截一张图，拉回本机的 `.build/shots/`。改了视图要用它截图确认。

测试只放在这几个边界上：

- 流式解析器（`MarkdownStream` 的 `append` / `finish` / `blocks`）：同一段文本不管怎么切分，结果都一样；已闭合的块不再变化；半截语法按预判显示；`finish()` 之后和 cmark-gfm 一次性解析的结果一致。
- 显示节奏（`RevealSchedule`）：一阵 token 在追赶窗口内均匀铺开，显示的文字落后到达的不超过这个窗口，不会在到达之前显示，汉字一个字一步。
- 代码高亮（`CodeHighlighter`）：字符串和注释里看起来像代码的东西不上色，没闭合的字符串只延伸到行尾，块注释可以跨行，未知语言不上色。
- 复制成纯文本（`PlainText`）：块之间空一行，列表项各占一行，表格单元格用制表符分隔，代码原样。
- trace 的展示规则（自动展开和收起、摘要）。纯数据结构不测。
- 视图不写单元测试，用 Demo App 在模拟器上截图验证。

## 约定

- 依赖锁精确版本，不用发布不到 7 天的版本。
- 改代码走 `feat/` / `fix/` / `chore/` 分支和 PR，提交信息用 Conventional Commits。
- 代码注释用英文，优先写为什么。文档用中文，放在 `docs/` 下。
