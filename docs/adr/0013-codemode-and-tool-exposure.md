# ADR-0013：codemode 作为通用工具，工具暴露方式和来源正交

- 状态：Accepted
- 日期：2026-10-08

## 背景

ADR-0012 第一版把 MCP 工具全部直接声明给模型，并把 codemode 留作下一步。重新对照 Pi CLI（pi-coding-agent 1.0.4 的 `docs/codemode.md`、`docs/extensions.md`）后发现，codemode 并不是 MCP 的附属品：

- `codemode` 是一个通用工具：模型写一段 JavaScript，在 QuickJS 沙箱里调用会话里的其他工具，只有脚本的输出进入上下文。没有 MCP 也有用：并发跑多个 read / bash、在大输出进入上下文前先过滤。
- 工具的**暴露方式（exposure）**是每个工具自己的属性，和工具从哪来无关：`direct`（声明给模型，脚本也能调）、`model-only`（只给模型，脚本不能调）、`codemode`（只在脚本里能调）、`deferred`（经 `tool_search` 加载）、`hidden`。MCP 只是把自己的工具默认标成 `codemode`。

两者正交，codemode 的价值是让 MCP 甩掉几样负担：大量工具声明占上下文、server 在后台连上时声明变化打断 prompt cache、结果太大。

Durable 1.0.4 没有这两样东西：模型看到哪些工具只由 agent 的 `tools` 决定，没有 exposure；工具也没有 CLI 那样的 `ctx.executeTool()` 嵌套调用管线。CLI 的 `createCodemodeExtension` 是 `ExtensionFactory`，装不进 Durable registry。上游另有独立的 `@earendil-works/pi-codemode`：只提供沙箱（每次执行一个 worker 和一个 QuickJS VM）和把 schema 渲染成 TypeScript 声明的 `renderDeclarations`，不依赖 pi 的其他包。

## 决策

1. **codemode 是内置扩展，所有对话默认开启。** 和 CLI 的 `on` 模式一样：read / bash / edit / write 照常声明给模型，codemode 额外可用。不做 CLI 的 `only` 模式（把其他工具都藏到脚本后面）。沙箱用 `@earendil-works/pi-codemode`，锁精确版本（ADR-0002）。子对话继承父对话的扩展，子代理里也能用。

2. **暴露方式是 PiNomad 的工具级概念，第一版三种：**
   - `direct`：声明给模型，脚本里也能调。内置的 read / bash / edit / write 是这一类。
   - `model-only`：只声明给模型，脚本里不能调。`ask_user_question`（要阻塞等用户回答）和 `subagent`（依赖自己工具任务的 memo 和 owner 去重，嵌套执行会错）是这一类；`codemode` 自己也是，脚本不能再起脚本。
   - `codemode`：只在脚本里能调，不进 agent 的 `tools`。宿主维护一份可调用工具目录，codemode 从目录里取。
   - `deferred` / `tool_search` 和 `hidden` 暂不做。Durable 的 `control.addTools` 以后可以承载 `deferred`。

3. **MCP 工具默认 `codemode`，取代 ADR-0012 第 5 条。** `~/.agents/mcp.json` 里每个 server 可以写 `exposure: "direct"` 改成直接声明（ADR-0012 第 2 条里"不支持 `exposure`"随之改为支持这一个字段，其余 CLI 特有字段仍不支持）。一个 server 是一个命名空间，说明取自配置的 `description` 或 server 初始化返回的 `instructions`。

4. **嵌套调用直接执行工具，不建 Durable 工具任务。**
   - codemode 从 `api.agent()` 解析出的工具（wrap 已经套上，比如 `writeWithDiff`）和 `codemode` 类目录里找到目标，按 `parameters` 校验参数，再用派生的 `api` 执行：`output`、`details`、`diagnostic` 被截下，`env`、`commit`、文档读取等照常转给原调用。
   - 嵌套调用不进 transcript，没有 intent 记录，也不走 `beforeTool` / `afterTool` 钩子（PiNomad 目前不用这两个钩子）。
   - `codemode` 不声明 `replay: "safe"`。宿主中途崩溃，整段脚本得到 `interrupted`；已经执行的调用不会撤销。中止父调用会经沙箱的 `signal` 取消正在跑的嵌套调用。
   - 结果交给脚本的形式：MCP 工具是它的 `CallToolResult`（含 `isError`、`structuredContent`）；read 读到图片时是图片块；其他工具是文本内容。工具报错时脚本里的调用 reject，错误文本就是工具的错误输出。

5. **工具发现照搬 CLI 的脚本接口。** 脚本里有 `tools.<name>(args)`、`ALL_TOOLS`、`searchTools`（BM25）、`describeTool`、`describeNamespace`，以及 `text`、`image`、`console`、`return`、`exit`。`codemode` 的工具描述内联 `direct` 工具的声明（3000 token 左右的预算），`codemode` 类工具只列命名空间、不内联，所以 server 连上或断开不改变工具声明。

6. **不提供 `store` / `load` 和 `models`。** `store` 要一个跟着 fork 走的可回退文档，`models`（分类、图片模型）目前没有使用场景；都等有需求再加。

7. **一次 codemode 调用在客户端是一张卡片，嵌套调用列在卡片里。** 新增展示类型 `pinomad.codemode`（ADR-0005）：
   - 卡片依次是脚本（默认折叠）、嵌套调用列表、模型实际收到的文本和图片输出。
   - 每个嵌套调用记工具名、参数摘要、状态（进行中 / 成功 / 失败 / 取消）、耗时和错误摘要；脚本运行中经 `api.details()` 更新，客户端实时看到进度。
   - 有展示类型的嵌套调用（比如 edit / write 的 `pinomad.diff`）把它的 details 一起存进来，展开时用同一个渲染器显示；单个和总量都有上限，超出只留摘要。bash 这类工具的原始输出不存，模型能看到的只有脚本自己的输出。
   - 不把嵌套调用拆成独立卡片：它们不在 transcript 里，拆开就得在客户端伪造并不存在的工具调用。

## 考虑过的方案

- **codemode 只在有 `codemode` 类工具时开启（CLI 的行为）**：省掉没有 MCP 时的工具描述开销，但又把 codemode 和 MCP 绑在一起，没有 MCP 时用不了并发读、过滤大输出。
- **默认关闭，按对话开启**：要加设置界面，而且默认关的能力很少被用上。
- **脚本里只开放 read / bash**：改文件必须直接调用，每次修改都有独立的 diff 卡片；但和 CLI 不一致，"批量改一组文件"这类脚本写不了。改用把 diff 收进 codemode 卡片。
- **MCP 默认 `direct`**：就是 ADR-0012 第一版的做法，留下前面说的三样负担。
- **每个嵌套调用建一个 Durable 工具任务**：嵌套调用能各自进 transcript、有 intent 记录、能单独恢复，但 Durable 的工具任务由模型的一轮工具调用驱动，嵌套任务和父工具调用的归属、重放规则都要自己设计，远超第一版需要。
- **复用 CLI 的 `createCodemodeExtension`**：是 `ExtensionFactory`，依赖 `ctx.executeTool` 和 CLI 会话，装不进 Durable registry。

## 后果

- 每个请求多一段 `codemode` 工具描述（内联的声明有预算上限）。
- 脚本里的修改不会各自成卡片，也不在 transcript 里单独出现；要看改了什么，得展开 codemode 卡片。
- 崩溃恢复粒度变粗：一段脚本是一个整体，部分执行过的调用不会重放也不会回滚，模型拿到 `interrupted` 后自己判断。
- 沙箱跑在宿主进程的 worker 里，没有文件系统和网络，只能经工具接触外部，安全边界和直接调用工具相同。
- 以后打包宿主时要显式提供 `pi-codemode` 的 worker 文件和 QuickJS wasm（`workerUrl`、`wasm` 选项）。
