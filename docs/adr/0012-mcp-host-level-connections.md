# ADR-0012：MCP 接入：全局配置、宿主级连接、工具直接声明

- 状态：Accepted
- 日期：2026-10-07

## 背景

ADR-0004 把 MCP 定为早期的外部扩展入口。pi-coding-agent 1.0.4 自带一套完整的 MCP 实现（`createMcpExtension`），但它是 CLI 的 `ExtensionFactory`，依赖 CLI 的会话、`/mcp` 界面和项目信任存储，装不进 Durable 的 registry。上游另有一个独立的客户端包 `@earendil-works/pi-mcp`：不依赖官方 SDK，提供 stdio 和 Streamable HTTP 传输、OAuth 子集，以及把工具结果转成 pi-ai 文本 / 图片块的 `toLlmContent`。

接入前要定几件事：配置从哪读、仓库自带的配置信不信、server 进程跟谁的生命周期走、工具怎么暴露给模型、崩溃后怎么办、要不要做 OAuth、客户端怎么知道 server 连上没有。

## 决策

1. **用 `@earendil-works/pi-mcp`，不复用 CLI 的 MCP 扩展。** 版本和其他 `@earendil-works/*` 一样锁精确版本（ADR-0002）。宿主里的 MCP 桥是核心模块，不放在 `src/extensions/` 下：它管理连接，把已连上的 server 的工具组装成一个名为 `mcp` 的 Durable 扩展装进 registry；工具列表变了就用同名扩展原地重装，新的请求自动用上新列表。

2. **配置只读 `~/.agents/mcp.json`，格式是各家客户端通用的 `mcpServers`。** 和 ADR-0006 一致：跨工具的东西放 `~/.agents`，`~/.pi` 只复用模型认证和 settings。
   - stdio server：`command`、`args`、`env`、`cwd`；HTTP server：`url`、`headers`。`enabled: false` 的 server 不连接。
   - `env` 和 `headers` 的值可以用 `${NAME}` 引用宿主进程的环境变量；引用了不存在的变量，这个 server 报配置错误。
   - 不认识的字段一律忽略，从别的客户端复制过来的配置能直接用。CLI 特有的 `exposure`、`toolExposure`、`auth.provider`、`!cmd` 都不支持。
   - 宿主启动时读一次。改了配置要重启宿主（ADR-0009 的 `restart` 会等空闲）。

3. **第一版不读项目级配置。** 项目级 `mcp.json` 等于让仓库在宿主上不经模型就起任意进程。项目是用户手动登记的，但仓库内容未必可信。以后做项目信任确认时再加。

4. **宿主级连接：每个 server 在宿主里只起一份，所有对话共用。**
   - 宿主打开后在后台连接，不阻塞启动；没连上之前，对话里没有这个 server 的工具。宿主关闭时关掉所有连接，stdio server 按 MCP 规范关闭（关 stdin → SIGTERM → SIGKILL）。
   - stdio server 的默认工作目录是用户主目录，相对的 `cwd` 也按主目录解析。不向 server 声明 roots。
   - server 中途断开时标记为失败，撤下它的工具。第一版不自动重连。
   - server 发出 `notifications/tools/list_changed` 时重新拉取工具列表。

5. **第一版只做直接声明，codemode 是下一步。** 每个 MCP 工具都作为普通工具声明给模型，名字是 `mcp__<server>__<tool>`：名字中 `[A-Za-z0-9_]` 以外的字符换成 `_`，总长截到 64 个字符。换名后撞名的工具跳过，并在状态里报错。
   - 这和 Pi CLI 的默认不同：CLI 里 server 的默认 `exposure` 是 `codemode`，MCP 工具不直接声明，模型在 QuickJS 沙箱里写脚本，经 `searchTools` / `describeTool` 找到工具再调用。好处是工具声明不随 server 连接变化（不打断 prompt cache）、工具多也不撑大上下文、脚本能并发调用和过滤大结果。
   - 第一版先不做，是因为 CLI 的 codemode 同样是 `ExtensionFactory`，要基于 `@earendil-works/pi-codemode` 重写成 Durable 工具，而且有几件事要单独定：脚本里能调哪些工具（只开放 MCP，还是连 bash / edit 也开放）、一次脚本里的多次调用在 Web 上怎么呈现、默认 exposure 用哪种。另写 ADR、单独一个 PR，做完后默认 exposure 打算和 Pi CLI 对齐为 codemode。
   - 直接声明的代价：工具多的 server 会占不少上下文；server 在后台连上时工具声明会变，那一轮的 prompt cache 失效。

6. **结果与重放。**
   - MCP 工具一律不声明 `replay: "safe"`：无从知道它们是否幂等。宿主中途崩溃，模型拿到 `interrupted`。
   - 结果用 `toLlmContent` 转成文本和图片块，MCP 的 `isError` 映射为错误结果。`structuredContent` 不映射到展示类型（ADR-0005），没有 content 块时 `toLlmContent` 会把它转成 JSON 文本。
   - Web 的工具卡片要能显示结果里的图片。这套渲染以后 read 读图片（等上游）也会用到。

7. **不做 OAuth。** HTTP server 只支持在 `headers` 里写死凭据（可以引用环境变量）。server 回 401 时状态报"需要登录，暂不支持"。宿主没有界面，授权链接要经客户端打开、回调要回到宿主，和远程访问（ADR-0008）纠缠在一起，留到有具体需求时再设计。

8. **状态经协议的宿主级流 `mcp` 推给客户端。** 快照内容是配置文件路径、配置错误，以及每个 server 的名字、状态（连接中 / 已连接 / 失败 / 已停用）、错误信息和工具数。客户端晚连上也能看到之前的失败。新增流属于协议变更，`PROTOCOL_VERSION` 加一（ADR-0009）。

## 考虑过的方案

- **复用 pi-coding-agent 的 `createMcpExtension`**：依赖 CLI 的 `ExtensionAPI`、会话和 `/mcp` 界面，装不进 Durable registry，配置解析也没有导出。
- **读 `~/.pi/agent/mcp.json`，和 Pi CLI 共用配置**：和 ADR-0001"不兼容 CLI 配置"的取向相反；CLI 特有的字段（codemode、`auth.provider`）PiNomad 也不支持，共用一份文件反而容易让人以为都生效。
- **读项目级配置，登记项目时确认信任**：要改协议和 Web，第一版用不上。
- **按 cwd（worktree）或按对话起 server**：能支持和项目相关的 server，但进程数随对话增长，回收时机也难定。第一版想接的 server（文档检索、浏览器、GitHub 之类）都是全局的。
- **这一版就和 Pi CLI 一样默认走 codemode**：行为和 CLI 一致，但要先定上面第 5 条列的几个问题，工作量也比连接管理本身大，拆开做更好评审。
- **只加 `deferred` + `tool_search`**：Durable 的 `control.addTools` 能让下一轮多声明工具，做起来便宜，但只解决上下文占用，不解决组合和过滤结果，和 CLI 的默认用法也不一样。
- **只用现有的 warning 通知报状态**：通知是瞬时的，客户端晚连上就看不到之前的连接失败。

## 后果

- 依赖工作目录的 server（比如 filesystem server 传 `.`）跟不上各对话的 worktree，要用就在配置里写绝对路径。
- MCP 工具绕过 worktree 隔离（ADR-0010）：server 能读写哪里由 server 自己决定。
- MCP server 跑在宿主机器上，不经过对话的执行环境。将来代码改在远端机器上执行（路线图"代码在别的机器上跑"），MCP server 仍在宿主本机。
- 改配置、server 崩溃后都要重启宿主才能恢复；配置热加载和手动重连记在路线图。
- 宿主的安全边界不变：配置文件只有宿主机器上的用户能写。
