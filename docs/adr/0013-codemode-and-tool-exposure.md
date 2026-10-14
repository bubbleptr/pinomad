# ADR-0013：codemode 作为通用工具，工具暴露方式和来源正交

- 状态：Accepted
- 日期：2026-10-08
- 2026-10-14 修订：Durable 1.2.0 带上了当初缺的两样东西——`callers` 工具暴露声明和 `api.executeTool()` 嵌套调用管线，以及上游自己的 `pi-durable/codemode` 扩展（确定性重放，脚本能在重启后接着跑）。本 ADR 的实现改为直接用上游：暴露方式落到 `callers`，嵌套调用是上游工具任务，提示词段和发现接口全部用上游的。自研的沙箱驱动、嵌套执行器和 `ScriptTool` 目录删除。

## 背景

ADR-0012 第一版把 MCP 工具全部直接声明给模型，并把 codemode 留作下一步。重新对照 Pi CLI（pi-coding-agent 1.0.4 的 `docs/codemode.md`、`docs/extensions.md`）后发现，codemode 并不是 MCP 的附属品：

- `codemode` 是一个通用工具：模型写一段 JavaScript，在 QuickJS 沙箱里调用会话里的其他工具，只有脚本的输出进入上下文。没有 MCP 也有用：并发跑多个 read / bash、在大输出进入上下文前先过滤。
- 工具的**暴露方式（exposure）**是每个工具自己的属性，和工具从哪来无关：`direct`（声明给模型，脚本也能调）、`model-only`（只给模型，脚本不能调）、`codemode`（只在脚本里能调）、`deferred`（经 `tool_search` 加载）、`hidden`。MCP 只是把自己的工具默认标成 `codemode`。

两者正交，codemode 的价值是让 MCP 甩掉几样负担：大量工具声明占上下文、server 在后台连上时声明变化打断 prompt cache、结果太大。

Durable 1.0.4 没有这两样东西：模型看到哪些工具只由 agent 的 `tools` 决定，没有 exposure；工具也没有 CLI 那样的 `ctx.executeTool()` 嵌套调用管线。所以第一版自己实现了它们。1.2.0 补齐了：`ToolRegistration.callers`（`"model"` / `"tools"` / 默认两者）、`ToolExecutionApi.executeTool()` 嵌套调用（独立工具任务、重放策略、`pi.live.nestedTools` 进度）、`deferred` / `tool_search`，以及 `@earendil-works/pi-durable/codemode`——一个 replay-safe 的 `codemode` 工具和它的提示词段。

## 决策

1. **codemode 是内置扩展，所有对话默认开启。** 和 CLI 的 `on` 模式一样：read / bash / edit / write 照常声明给模型，codemode 额外可用。不做 CLI 的 `only` 模式（把其他工具都藏到脚本后面）。沙箱用 `@earendil-works/pi-codemode`，锁精确版本（ADR-0002）。子对话继承父对话的扩展，子代理里也能用。

2. **暴露方式落到上游的 `callers`：**
   - `direct`：`callers` 缺省（模型和脚本都能调）。内置的 read / bash / edit / write / `todo_write` 是这一类。
   - `model-only`：`callers: ["model"]`。`ask_user_question`（要阻塞等用户回答）和 `subagent`（依赖自己工具任务的 memo 和 owner 去重，嵌套执行会错）是这一类；上游的 `codemode` 工具自己也是，脚本不能再起脚本。
   - `codemode`：`callers: ["tools"]`，不进模型看到的工具列表，但 `executeTool()` 能调。
   - `deferred` / `tool_search` 和 `hidden` 暂不做；上游已有 `deferred`，需要时直接开。

3. **MCP 工具默认 `codemode`，取代 ADR-0012 第 5 条。** `~/.agents/mcp.json` 里每个 server 可以写 `exposure: "direct"` 改成直接声明（ADR-0012 第 2 条里"不支持 `exposure`"随之改为支持这一个字段，其余 CLI 特有字段仍不支持）。实现上每个 MCP 工具只有一份注册：`callers` 按 exposure 决定；`structuredOutputSchema` 声明成 `CallToolResult` 形状，所以脚本拿到的是原始 `CallToolResult`（含 `isError`、`structuredContent`），模型拿到 `toLlmContent` 映射的文本和图片块。一个 server 是一个命名空间：`{ name: <server>, description, instructions, prefix: "mcp__<server 清洗后的名字>__" }`，server 连接 / 重列 / 掉线时经 `onNamespaces` 回调重装 codemode 扩展。

4. **嵌套调用是上游 `executeTool()` 工具任务，脚本靠确定性重放挺过重启。**
   - 脚本里的 `tools.<name>(args)` 是真实的嵌套工具调用：有自己的任务、校验、钩子和重放策略，结果不进 transcript，只回到调用方。
   - 上游 codemode 工具是 `replay: "safe"`：宿主重启后脚本按日志从头重放，已完成的嵌套调用按键重连不重跑；崩溃时还在跑的嵌套调用按它自己的 `replay` 策略处理。重放拒绝（脚本分叉、版本或指纹变化、超时过期）会得到错误结果。
   - 结果交给脚本的形式：MCP 工具是它的 `CallToolResult`；声明了 `structuredOutputSchema` 的工具（比如 bash 的 `{ output, truncated, exitCode }`）出错也带值返回，脚本查 `exitCode`；其他工具是文本输出。没有结构化输出的工具报错时脚本里的调用 reject。

5. **工具发现和提示词段全用上游的。** 脚本里有 `tools.<name>(args)`、`ALL_TOOLS`、`searchTools`、`describeTool`、`describeNamespace`，以及 `text`、`image`、`console`、`return`、`exit`。`codemode` 工具描述是固定文本；随对话变化的 `codemode` 提示词段按可调用工具渲染（有 token 预算），命名空间按 `prefix` 归组。

6. **`store` / `load` 和 `models.*` 随上游一起提供。** `store(key, value)` / `load(key)` 按对话存 JSON 值（fork 看到分叉点的值）；`models.*`（模型目录、分类、图片生成）默认开，内部是 `pi.codemode.*` 嵌套工具，不进 `tools` 也不进发现接口。

7. **一次 codemode 调用在客户端是一张卡片，嵌套调用列在卡片里。** 展示类型 `pinomad.codemode`（ADR-0005）：
   - 卡片依次是脚本（默认折叠）、嵌套调用列表、模型实际收到的文本和图片输出。
   - 结果 `details.calls` 记每次调用的名字、参数摘要、状态、耗时和错误摘要，只在调用结束时写一次；脚本运行中的进度客户端读 `pi.live.nestedTools`（按 `parentCallId` 归属，`pi.*` 内部工具不显示）。
   - 嵌套调用的展示 details（比如 diff）不再收集——上游结算时丢弃嵌套结果；旧 transcript 里已存的条目仍按旧 schema 渲染。
   - 不把嵌套调用拆成独立卡片：它们不在 transcript 里，拆开就得在客户端伪造并不存在的工具调用。

## 考虑过的方案

- **codemode 只在有 `codemode` 类工具时开启（CLI 的行为）**：省掉没有 MCP 时的工具描述开销，但又把 codemode 和 MCP 绑在一起，没有 MCP 时用不了并发读、过滤大输出。
- **默认关闭，按对话开启**：要加设置界面，而且默认关的能力很少被用上。
- **脚本里只开放 read / bash**：改文件必须直接调用，每次修改都有独立的 diff 卡片；但和 CLI 不一致，"批量改一组文件"这类脚本写不了。
- **MCP 默认 `direct`**：就是 ADR-0012 第一版的做法，留下前面说的三样负担。
- **保留自研的嵌套执行器（1.2.0 之前的实现）**：嵌套调用不进 transcript、崩溃即 `interrupted` 的语义是我们自己定的；上游 `executeTool` 管线给出了更强的版本（任务、重放、live 进度），维护它没有理由。

## 后果

- 每个请求多一段 `codemode` 提示词段（上游按 `inlineBudget` 控制内联声明的体积）。
- 脚本里的修改不会各自成卡片，也不在 transcript 里单独出现；要看改了什么，得展开 codemode 卡片。嵌套调用的 diff 不再能展开看——这是相对自研版丢掉的呈现。
- 崩溃恢复变细了：一段脚本不再整段 `interrupted`，而是重放日志续跑；脚本分叉、版本或指纹变化、超时过期时以错误结果收尾。
- 沙箱跑在宿主进程的 worker 里，没有文件系统和网络，只能经工具接触外部，安全边界和直接调用工具相同。
- 打包宿主时 worker 文件和 QuickJS wasm 由 `pi-codemode` 的默认路径解析；打包进单文件时需要 `workerUrl` / `wasm` 选项（当前 npm 包外置依赖，不用处理）。
