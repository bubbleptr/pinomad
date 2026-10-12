# 具名代理与 workflow：上游 1.0.4 已有什么，PiNomad 要补什么

研究日期：2026-10-13。对应 issue [bubbleptr/pinomad#65](https://github.com/bubbleptr/pinomad/issues/65)。**本文只盘点事实和取舍，不做选型。** 结论只针对已安装的 `@earendil-works/*@1.0.4`（ADR-0002 锁定的版本），另外对照了上游仓库 main 分支（2026-10-12 的 [`7bd01fb`](https://github.com/earendil-works/pi/commit/7bd01fb92485c06f92ecfff7ccf3197148bc16af)）以及三家同类产品的一手文档。没有修改产品代码。

## 版本与路径约定

- 上游仓库取自 `package.json` 的 `repository` 字段：`git+https://github.com/earendil-works/pi.git`，目录 `packages/durable`、`packages/coding-agent`。npm 元数据记录 1.0.4 的 `gitHead = 7c10bd4337495ee613f2224843ecdf349b80d1df`（`npm view @earendil-works/pi-durable@1.0.4 gitHead`，pi-coding-agent 相同）。下文中的 GitHub 链接都锁定在这个提交。
- 本地路径缩写（相对仓库根目录）：
  - `<durable>` = `node_modules/.bun/@earendil-works+pi-durable@1.0.4+75f1f2ee6e38d518/node_modules/@earendil-works/pi-durable`
  - `<coding-agent>` = `node_modules/.bun/@earendil-works+pi-coding-agent@1.0.4+b7b4099cc6b8d229/node_modules/@earendil-works/pi-coding-agent`
  - `<subagent-ex>` = `<coding-agent>/examples/extensions/subagent`
- 发布包只带 `dist`（编译产物）和文档，没有 `src`；`dist/*.d.ts` 的行号是本地文件的行号。

## 结论速览

| 问题 | 事实 |
| --- | --- |
| 上游有没有"具名代理"的概念 | 1.0.4 的 Durable 和 coding-agent 核心都**没有**。Durable 只有每条对话的 `pi.agent`（model / thinkingLevel / extensions / tools / instructions / cwd），没有名称、没有发现机制、没有文件格式。coding-agent 的 README 明说默认不带子代理和 plan mode。 |
| 上游有没有 workflow 的概念 | **没有**。`<durable>/dist` 里搜不到 "workflow"。可以拿来搭的积木有：`defineTask` 的多 phase 持久状态机、子任务及其等待策略、任务拥有的子对话、`onYield` 钩子。 |
| 最接近的上游实现 | coding-agent **示例**扩展 `examples/extensions/subagent`：`agents/*.md`（frontmatter 为 `name` / `description` / `tools` / `model`），single / parallel / chain 三种模式，chain 用 `{previous}` 占位；"workflow" 是 `prompts/*.md` 提示词模板，靠它让模型去调 chain。它为每个子代理起一个 `pi` 子进程，不是 Durable。 |
| main / Unreleased 里有没有新东西 | 没有具名代理或 workflow 功能。和这件事相关的是 Durable Unreleased 里的嵌套工具调用（`api.executeTool`）、`callers` / `modelTools`、deferred tools，以及可在重启后续跑的 Durable 版 codemode。另外 1.1.0（2026-10-07）已发布。"给扩展一个一等的子代理 spawn API"的 issue 以 not planned 关闭。 |
| PiNomad 能直接用的导出 | `parseFrontmatter`、`getAgentDir`、`CONFIG_DIR_NAME`、`loadSkills` / `formatSkillsForPrompt`。`loadPromptTemplates` / `substituteArgs` / `expandPromptTemplate` 在 `dist` 里有，但没有从包根导出，`exports` 也只开放了 `"."`。示例的 `discoverAgents` 不是包的导出。 |

## 1. 上游 1.0.4 源码里有什么

### 1.1 pi-durable：有每对话 agent 的数据形状，没有"具名"

**每条对话自己的 agent。** `AgentState` 存的是名字，不是对象。字段有 `model`、`thinkingLevel`、`extensions`（数组表示精确选择，`{add, remove}` 表示在宿主默认上增删）、`tools`（数组表示"只提供这些"，`{remove}` 表示去掉一部分）、`instructions`（渲染在所有扩展分段之后）和 `cwd`。`AgentChange` 是对应的修改，传对象，`null` 清空。见 `<durable>/dist/harness/types.d.ts` 第 246–275 行。

- `createConversation()`、`fork()`、`root()` 接受同一份 `agent` 修改，在创建它的那次提交里生效。被任务拥有的对话（比如子代理）从拥有者所在对话的 agent 复制一份起步。见 `<durable>/README.md` 第 190–210 行。
- 模型、提示词和工具在一次请求准备时就定了，修改从下一次请求起生效（同上，第 210 行）。
- 对照：一个"具名代理定义"需要的字段（提示词、模型/provider、思考等级、工具白名单）和 `AgentState` 能一一对上；**名称、描述、从哪些文件发现、谁来调用**在 Durable 里都没有。

**扩展、钩子、任务。** 一个 `Extension` 可以带 `tools`、`sections`、`hooks`、`wraps`、`tasks`（`types.d.ts` 第 204–213 行；README 第 126–145 行）。钩子只能挂在内置任务上（`types.d.ts` 第 539–564 行，README 第 383–402 行）：

| 任务 | 钩子 | 能做什么 |
| --- | --- | --- |
| Generation | `beforeRequest` / `afterResponse` / `onYield` / `afterTools` | 替换这一次请求的消息；最终回答时返回 `{ continue }` 追加一条用户消息让运行继续；一轮工具全部结束后观察结果 |
| Tool | `beforeTool` / `afterTool` | 拦下调用或改写参数；替换结果 |
| Compaction | `beforeCompact` | 拒绝本次压缩或自己给摘要 |

想让钩子只在部分对话里生效，就只在那些对话里选它所在的扩展，比如 `configure({ extensions: { add: [Guard] } })`（README 第 402 行）。

**子代理与子任务（workflow 的积木）。**

- 对话可以归一个任务所有：工具在 `api.commit()` 里用 `ownership: { kind: "task", taskId }` 创建子对话，再通过 `api.conversation(id)` 驱动。中止调用会连带中止子对话；子对话空闲之前父对话也不算空闲；`{ background: true }` 的任务是边界，它拥有的工作不受父对话中止的影响。见 README 第 413–458 行。PiNomad 的 `subagent` 工具就是照这个写的（`apps/host/src/extensions/subagent.ts`）。
- `defineTask` 定义的是带 phase 的持久状态机，每一步存检查点，可以写 `migrate`（`<durable>/dist/tasks.d.ts`；`<durable>/dist/types.d.ts` 第 187–210 行）。任务可以拥有子任务，并提交 `waiting` 状态等它们，策略是 `allSettled` 或 `failFast`（README 第 460–485 行）。`failFast` 不补偿已经完成的任务，见 [pi-durable-evidence.md](pi-durable-evidence.md)。
- 官方示例里和这个问题最相关的是（1.0.4 提交）：
  - [`22-subagent-foreground.ts`](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/test/examples/22-subagent-foreground.ts)：前台子代理。
  - [`23-subagent-background.ts`](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/test/examples/23-subagent-background.ts)：一个 `subagent` 工具负责 spawn / message / wait / stop / list，子代理由后台锚任务拥有，回答由后台 reporter 任务作为 follow-up 回帖给父对话（README 第 458 行）。spec 提到持久后台子代理"按子代理的名字在应用自己的注册表文档里去重"（[spec.md 第 3307–3309 行，main](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)）。这里的名字是实例名，不是预定义的代理类型。
  - [`27-plan-mode.ts`](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/test/examples/27-plan-mode.ts)：只读的 plan mode 写成一个带自有文档的扩展，用 `configure()` 切换。
  - [`28-reviewer.ts`](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/test/examples/28-reviewer.ts)：评审对话有自己的模型（`small`）、精确的扩展列表 `[CodingTools, Reviewer]`、只有 `read` 一个工具、自己的 `cwd`（worktree）。`Reviewer` 扩展用一个角色分段，再用 `onYield` 做"没写 `No further findings.` 就再看一遍"的循环（第 31–44、77–90 行）。这是上游给出的最接近"具名评审代理 + 循环"的写法，但定义写死在代码里。
- `grep -rli workflow <durable>/dist` 没有结果：Durable 没有 workflow、编排脚本或预定义代理之类的 API。

### 1.2 pi-coding-agent（Pi CLI）：核心不带子代理，示例里有一套具名代理和 workflow

**核心不带。** README 第 19 行："Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way."（`<coding-agent>/README.md`）。`docs/` 下也只在 `extensions.md`、`skills.md` 里把 "workflow" 当普通词用，没有对应功能。

**示例扩展 `subagent`**（随包发布在 `<subagent-ex>`，不在包的 `exports` 里）：

- 结构：`index.ts`（工具）、`agents.ts`（发现）、`agents/{scout,planner,reviewer,worker}.md`、`prompts/{implement,scout-and-plan,implement-and-review}.md`（`<subagent-ex>/README.md` 第 14–30 行）。
- **代理文件格式**：Markdown 加 YAML frontmatter，正文就是系统提示词。识别的字段只有 `name`、`description`（这两个必填，缺了直接跳过）、`tools`（逗号分隔的字符串或 YAML 数组）、`model`（`<subagent-ex>/agents.ts` 第 11–19、34–39、88–102 行）。**没有思考等级字段**；不写 `model` 时，模型和思考等级都沿用发起它的会话（`index.ts` 第 300–306 行；README 第 140 行）。
- **发现位置**：用户级 `~/.pi/agent/agents/*.md`（`getAgentDir()/agents`）总是加载；项目级是从 cwd 往上找到的**最近一个** `.pi/agents/`（`CONFIG_DIR_NAME`），只有 `agentScope: "project" | "both"` 时才加载，`both` 时项目级覆盖同名的用户级（`agents.ts` 第 116–147 行）。每次调用都重新扫描，会话中途改文件就能生效（README "Limitations"）。项目级代理默认要用户确认，因为它们是仓库控制的提示词（README "Security Model"）。
- **调用**：工具参数三选一：`{agent, task}`、`{tasks: [...]}`（并行，最多 8 个，同时跑 4 个）、`{chain: [...]}`（顺序执行，`task` 里的 `{previous}` 换成上一步的最终输出）。chain 遇到第一个失败的步骤就停（`index.ts` 第 1–14、33–34、442–468、552–596 行；README "Tool Modes"）。模型靠工具描述里的代理列表和名字选代理；示例 README 写的用法就是自然语言，比如 "Use scout to find…"。
- **执行方式**：每次调用起一个 `pi --mode json -p --no-session` 子进程，带上 `--model`、`--thinking`（仅在继承时）、`--tools` 和 `--append-system-prompt <临时文件>`，任务文本作为 `Task: …` 传入（`index.ts` 第 300–341 行）。不是 Durable，也没有恢复能力。
- **"Workflow" 就是提示词模板**：`prompts/implement.md` 的正文是"Use the subagent tool with the chain parameter to execute this workflow: 1. scout … 2. planner … ({previous}) 3. worker …"，`$@` 换成用户参数，通过 `/implement <query>` 调用（`<subagent-ex>/prompts/*.md`）。步骤顺序靠模型照着文字执行，没有代码层面的保证。
- 上游 issue 显示这个示例一直有人在改：数组形式的 `tools`（[#7598](https://github.com/earendil-works/pi/pull/7598)）、继承父会话配置（[#7897](https://github.com/earendil-works/pi/pull/7897)）、嵌套深度不受限（[#8195](https://github.com/earendil-works/pi/issues/8195)）。给调用方加 `model` / `thinking` 覆盖的 PR [#8969](https://github.com/earendil-works/pi/pull/8969) **没有合并**（2026-09-01 关闭）。

**示例扩展 `preset.ts`**（`<coding-agent>/examples/extensions/preset.ts` 第 1–58 行）：在 `~/.pi/agent/presets.json` 和 `<cwd>/.pi/presets.json` 里定义具名预设，字段为 `provider`、`model`、`thinkingLevel`、`tools`、`instructions`，项目级覆盖全局。用 `--preset`、`/preset <name>` 或 Ctrl+Shift+U 切换**当前会话**。注释里的例子正好是 `plan`（openai-codex，只读工具）和 `implement`（anthropic，读写工具）。这是"换模型做下一阶段"的手动版本，没有子代理。

**提示词模板 = 斜杠命令**（`<coding-agent>/docs/prompt-templates.md`）：

- 格式：`<name>.md`，文件名就是命令名；frontmatter 可写 `description`（不写就取第一行非空文本）和 `argument-hint`；正文支持 `$1`、`$@` / `$ARGUMENTS`、`${1:-default}`、`${@:N}`、`${@:N:L}`，参数按 shell 规则处理引号。
- 位置：`~/.pi/agent/prompts/`、项目的 `.pi/prompts/`，只看一层 `.md`；settings 的 `prompts`、`--prompt-template`、Pi 包也能加。项目级要先授予项目信任（`docs/configuration.md` 第 9–36 行；`docs/cli.md` 第 204–207 行）。
- 加载实现在 `<coding-agent>/dist/core/prompt-templates.d.ts`（`loadPromptTemplates`、`substituteArgs`、`expandPromptTemplate`、`parseCommandArgs`），但 `dist/index.d.ts` 只导出了 `type PromptTemplate`（第 20 行），`dist/index.js` 里没有这几个函数，`package.json` 的 `exports` 只开放 `"."`（以及 source-only 的 `./client`、`./experimental/plugin`）。**PiNomad 没法按公开 API 导入它们。**

**斜杠命令**（`docs/slash-commands.md`）：内置命令，加上扩展的 `pi.registerCommand()`、每个提示词模板、`/skill:name`。

**Skills**（`docs/skills.md`）：遵循 Agent Skills 规范。frontmatter 有 `name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`（实验性）、`disable-model-invocation`。启动时只把名字、描述和路径放进系统提示词，需要时再读 `SKILL.md`。项目的 `.agents/skills/` 会**从 cwd 一路往上找到仓库根目录**（第 61 行）。这段祖先遍历在 `DefaultPackageManager` 里（`<coding-agent>/dist/core/package-manager.js` 第 291–307、2023–2026 行，`collectAncestorAgentsSkillDirs`），**不在** PiNomad 调用的 `loadSkills()` 里：后者只扫给定的路径，加上 `includeDefaults` 时的 `~/.pi/agent/skills` 和 `<cwd>/.pi/skills`（`dist/core/skills.js` 第 354–356 行）。PiNomad 现在给它传的是 `<cwd>/.agents/skills` 和 `~/.agents/skills`（`apps/host/src/extensions/context.ts` 第 111–125 行），这就是 roadmap 里"看不到仓库根目录 Skills"的原因。

**扩展**（`docs/extensions.md`）：TypeScript 模块，默认导出一个接收 `ExtensionAPI` 的工厂，用 jiti 加载，不用编译。位置是 `~/.pi/agent/extensions/`、`.pi/extensions/`（单个文件，或带 `index.ts` 的目录），也可以用 `-e`。能力有 `pi.on()` 生命周期事件、`registerTool`、`registerCommand`、`registerFlag`、`sendUserMessage`、`appendEntry`、切换模型/工具/思考等级、`registerProvider`、`registerMcpServer`、`registerVirtualModel`（第 13–86 行）。`turn_end` / `agent_before_settle` 可以请求再跑一次模型（第 95–131 行）。ADR-0002 / 0004 已决定不引入这套机制；它和 Durable 的 `defineExtension` 不兼容（ADR-0013 背景）。

**其他相邻示例**：

- `plan-mode/`：`/plan` 只读模式加步骤跟踪。
- `handoff.ts`：`/handoff <goal>` 生成一条交接提示词，开一个新会话。
- `jev-router.ts`：一个虚拟模型，规划阶段用强模型，第一次成功 `edit` 之后切到便宜模型（`docs/virtual-models.md`；`jev-router.ts` 第 2–10、91–107 行）。这是"plan 用 A 模型、implement 用 B 模型"的一种路由写法，发生在单个会话内部。

**Pi 包**（`docs/packages.md`）：把扩展、skills、prompts、themes 作为一个 npm 或 git 单元分发；项目包要先过项目信任。第三方包 [`pi-subagents`](https://github.com/nicobailon/pi-subagents)（npm 0.77.0，描述是 "single-agent delegation and scripted multi-agent workflows"）在示例之上扩展了很多：frontmatter 有 `thinking`、`skills`、`allowedAgents`、`maxSubagentDepth`、`systemPromptMode`、`async` 等几十个字段（[docs/agents.md "Frontmatter reference"](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md)）；workflow 是在沙箱里跑的 JavaScript（`runs.run` / `runs.all` / `runs.lanes`，不能访问文件系统和 shell），还能用 `/prompt-workflow` 把提示词模板编译成脚本（[docs/workflows.md](https://github.com/nicobailon/pi-subagents/blob/main/docs/workflows.md) "Scripted workflows"、"Repeatable workflows"）。它把旧的 `chain` / `.chain.md` 废弃了，改为脚本（同文件 "Migrating old chain shapes"）。**这是第三方实现，只读了 README 和文档，没有读源码。**

### 1.3 其他上游包

`pi-agent-core`、`pi-codemode`、`pi-mcp` 的 README 里没有 subagent 或 workflow 相关内容（`grep -c`）。`pi-ai` 只在介绍里把 "agentic workflows" 当普通词用（README 第 5、1557 行）。

### 1.4 PiNomad 能直接调用的导出

| 符号 | 来源 | 能否从包根导入 | 用途 |
| --- | --- | --- | --- |
| `parseFrontmatter` / `stripFrontmatter` | `<coding-agent>/dist/index.d.ts` 第 39 行 | 能 | 解析代理或 workflow 的 `.md` frontmatter（真正的 YAML 解析器，`agents.ts` 第 27–33 行注释） |
| `getAgentDir` / `CONFIG_DIR_NAME` | `dist/index.d.ts` 第 2 行 | 能 | Pi 的 `~/.pi/agent` 和 `.pi`；ADR-0006 规定上下文不从 `~/.pi` 读 |
| `loadSkills` / `loadSkillsFromDir` / `formatSkillsForPrompt` | `dist/index.d.ts` 第 23 行 | 能（PiNomad 已在用） | 不带祖先遍历 |
| `loadPromptTemplates` / `substituteArgs` / `expandPromptTemplate` / `parseCommandArgs` | `dist/core/prompt-templates.d.ts` | **不能** | 模板加载和 `$1` / `$@` 替换要自己实现或复制 |
| `discoverAgents` / `formatAgentList` | `<subagent-ex>/agents.ts` | **不能**（示例文件，不在 exports 里） | 约 150 行，复制或参照 |
| `AgentChange` / `configure` / `createConversation({ agent })` / `defineTask` / `hook(GenerationTask, …)` | `<durable>` 包根 | 能 | 把一份定义落到子对话上；多步编排；评审循环 |

## 2. 上游 main 与 CHANGELOG Unreleased（截至 2026-10-12）

- **1.1.0 已发布（2026-10-07）**，和这个问题相关的有：`ToolExecutionApi.models` / `HookApi.models`，工具和钩子可以直接调模型；`Conversation.context(context, { at })`；任务记录带 `startedAt` / `endedAt`；工具结果和助手消息带 `durationMs`（[durable CHANGELOG 1.1.0](https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md)）。coding-agent 1.1.0 给 `--tools` 加了 `+name` / `-name`（[coding-agent CHANGELOG 1.1.0](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)）。
- **Durable Unreleased**（[CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md)）：
  - `ToolExecutionApi.executeTool(name, args, context, { key?, progress? })`：嵌套调用成为调用方拥有的 `pi.tool` 任务，走校验、`ToolTask` 钩子和 replay 策略；replay-safe 的调用方重跑时按 key 重新挂上它的嵌套调用。
  - `ToolRegistration.callers`（`model` / `tools`）和 `pi.agent.modelTools`：区分"谁能调这个工具"和"给模型声明哪些工具"。
  - deferred tools 和 `@earendil-works/pi-durable/tool-search`。
  - `@earendil-works/pi-durable/codemode`：脚本通过嵌套调用使用对话里的工具，靠结果日志做确定性重放，**重启后能接着跑**；脚本里有 `models.*`、`store()` / `load()`。
  - `TaskOptions.abandonOnRestart`、`TaskRuntime.abortOwned` / `ownedTasks`。
  - 破坏性变更：`ToolExecutionResult.content` 改名为 `output`。
  - 这些都还没有发布版本。
- **推论（未验证）**：ADR-0013 把 `subagent` 定为 `model-only`，理由是"依赖自己工具任务的 memo 和 owner 去重，嵌套执行会错"。上游的嵌套调用会给每次调用建一个独立的 `pi.tool` 任务，有自己的 `taskId` 和 owner，这条理由可能就不再成立，于是"在 codemode 脚本里编排多个子代理"有了上游支撑。目前没有实测。
- **coding-agent Unreleased**：删掉了未发布的实验性 server / client / plugin 栈（`src/experimental`、`./experimental/plugin` 导出等），见提交 [`7472cda`](https://github.com/earendil-works/pi/commit/7472cda0d6e51dfbf53c03f46b47aa42ac64bf64)（2026-10-12）。1.0.4 包里的 `examples/plugins/pi-example-plugin`（Chord facet 插件，需要 `PI_EXPERIMENTAL=1`）属于这个栈。issue [#10815](https://github.com/earendil-works/pi/issues/10815)（open）提到的 `src/experimental/durable/subagent.ts` 也随之删除，main 上的 `packages/coding-agent/src/experimental` 只剩 `source-resolver.ts`（GitHub contents API）。
- main 上的 `examples/extensions/subagent/agents.ts`、`index.ts` 和 1.0.4 **逐字节相同**（`diff`）。
- 相关 issue：[#7808](https://github.com/earendil-works/pi/issues/7808) "First-class subagent spawn API for extensions"（提议 `pi.spawnChild({prompt, model?, tools?, systemPrompt?, outputSchema?, maxTurns?…})`）**以 not_planned 关闭**；关闭评论是新贡献者 issue 的自动关闭模板，不代表维护者的技术立场。[#8970](https://github.com/earendil-works/pi/issues/8970)（调用时指定 model / effort）也是 not_planned。
- main 的 `packages/` 是 `agent, ai, chord, codemode, coding-agent, durable, env, evals, mcp, telemetry, tui`，没有专门管代理定义或 workflow 的包。

## 3. Pi CLI 一览：格式与发现位置

| 资源 | 格式 | 用户级 | 项目级 | 调用 | 出处 |
| --- | --- | --- | --- | --- | --- |
| 提示词模板 | `<name>.md`，frontmatter `description`、`argument-hint` | `~/.pi/agent/prompts/` | `.pi/prompts/`（需信任） | `/<name> args` | `docs/prompt-templates.md` |
| Skill | `<dir>/SKILL.md`（Agent Skills 规范） | `~/.pi/agent/skills/`、`~/.agents/skills/` | `.pi/skills/`；`.agents/skills/` 从 cwd 往上到仓库根 | 模型自动读取；`/skill:name` | `docs/skills.md` 第 41–85 行 |
| 扩展 | `.ts` / `.js` 或带 `index.ts` 的目录 | `~/.pi/agent/extensions/` | `.pi/extensions/`（需信任） | 注册的工具、命令、事件 | `docs/extensions.md` 第 13–52 行 |
| 子代理（示例） | `.md`，frontmatter `name`、`description`、`tools`、`model` | `~/.pi/agent/agents/` | 最近的 `.pi/agents/`（要 `agentScope`） | `subagent` 工具：single / parallel / chain | `<subagent-ex>` |
| 预设（示例） | JSON `{name: {provider, model, thinkingLevel, tools, instructions}}` | `~/.pi/agent/presets.json` | `.pi/presets.json` | `--preset`、`/preset` | `preset.ts` 第 1–38 行 |
| 系统提示词 | `SYSTEM.md`（替换）/ `APPEND_SYSTEM.md`（追加） | `~/.pi/agent/` | `.pi/` | 自动 | `docs/configuration.md` 第 19–33 行 |
| 单次运行覆盖 | CLI 参数 `--model`、`--thinking`、`--tools`（支持 `*`、`+`、`-`）、`--append-system-prompt`、`-p`、`--mode json`、`--no-session` | — | — | 子进程式子代理就靠这些 | `docs/cli.md` 第 45–128 行 |

## 4. 同类产品

### 4.1 Claude Code

**子代理**（[Create custom subagents](https://code.claude.com/docs/en/sub-agents)）：

- 格式：Markdown 加 YAML frontmatter，正文是系统提示词。子代理只拿到这份提示词和基本环境信息，不带 Claude Code 自己的系统提示词。必填只有 `name`、`description`。
- 可选字段：`tools`、`disallowedTools`、`model`（`sonnet` / `opus` / `haiku` / `fable`、完整 ID 或 `inherit`）、`permissionMode`、`maxTurns`、`skills`（预载完整内容）、`mcpServers`、`hooks`、`memory`、`background`、`omitClaudeMd`、`effort`、`isolation: worktree`、`color`、`initialPrompt`、`experimental.cacheTtl`。不认识的字段静默忽略。
- 位置和优先级：managed settings > `--agents` JSON（只在本次会话有效）> `.claude/agents/`（从 cwd 往上到仓库根，离 cwd 近的优先）> `~/.claude/agents/` > 插件的 `agents/`（用 `plugin:sub:name` 命名空间）。会递归扫描子目录，身份只看 `name`。文件监听热更新。插件代理不支持 `hooks`、`mcpServers`、`permissionMode`。
- 模型解析顺序：调用时传的 `model` 参数 > frontmatter 的 `model` > `CLAUDE_CODE_SUBAGENT_MODEL` > 主对话的模型。**没有按子代理单独设的 thinking**，跟随主对话；`effort` 字段可以覆盖会话的 effort。
- 调用：模型按 `description` 自动委派（工具是 `Agent`，参数 `subagent_type`）；自然语言点名；`@"name (agent)"` 或 `@agent-<name>` 保证委派到这个代理；`claude --agent <name>` 或 settings 的 `agent` 让整个会话以这个代理运行。
- "Chain subagents"一节只是让模型按顺序调用，没有专门的语法。

**Skills 与旧的自定义命令**（[Extend Claude with skills](https://code.claude.com/docs/en/skills)）：

- `.claude/commands/<name>.md` 已经并入 skills，和 `.claude/skills/<name>/SKILL.md` 一样都生成 `/<name>`。
- frontmatter 有 `description`、`when_to_use`、`argument-hint`、`arguments`、`disable-model-invocation`、`user-invocable`、`allowed-tools`、`disallowed-tools`、`model`（只对本轮生效）、`effort`、`context: fork`（在子代理里跑这个 skill）配合 `agent`（选用哪个子代理类型）和 `background`、`hooks`、`paths`、`shell` 等。
- 替换变量有 `$ARGUMENTS`、`$ARGUMENTS[N]`、`$N`。

**动态 workflow**（[Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows)）：

- 一份 JavaScript 脚本，由 Claude 编写、运行时在后台执行。`agent()` 起一个子代理（可以带 JSON `schema`），`pipeline()` 对列表里每一项起一个，`parallel()` 并发跑一组；还有 `phase()`、`log()` 和 `args` 全局变量。
- 脚本开头是 `export const meta = { name, description }`。用 `/workflows` 保存到 `.claude/workflows/` 或 `~/.claude/workflows/` 后，就能用 `/<name>` 调用；插件里的 workflow 会带命名空间。
- 运行时让 `Date.now()`、`Math.random()` 抛错，保证重跑时 `agent()` 调用序列不变。会话内可以恢复：已完成的 agent 返回缓存的结果，第一个提示词不同的 agent 以及它之后的所有 agent 都重跑。
- 限制：运行中不能接收用户输入；脚本本身不能访问文件系统和 shell；不能 `import()`；默认同时 16 个 agent；每次运行最多 1000 个。
- 脚本可以给某个阶段指定模型，按子代理的模型解析顺序算作"调用时传的 model"（"Cost"一节）。`agent()` 选项的确切名称（比如怎么指定子代理类型）文档正文没有列出，**未核实**。
- 文档里有一张表比较子代理、skills、agent teams 和 workflow，区别在"谁决定下一步"：前三者由 Claude 逐轮决定，workflow 由脚本决定（"When to use a workflow"）。

**Hooks**（[Hooks reference](https://code.claude.com/docs/en/hooks)）：

- 事件包括 `PreToolUse`、`PostToolUse`、`SubagentStart`、`SubagentStop`、`Stop`、`UserPromptSubmit`、`UserPromptExpansion`、`PreModelSwitch`、`WorktreeCreate` 等几十个。
- 处理器类型有 `command`、`http`、`mcp_tool`、`prompt`、`agent`。
- 可以写在 `~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json`、managed、插件的 `hooks/hooks.json`、skill frontmatter（被调用后对整个会话生效）、子代理 frontmatter（只在该子代理运行期间生效，`Stop` 会转成 `SubagentStop`）。
- `Stop` 钩子连续续跑上限是 8 次。

### 4.2 OpenAI Codex CLI

- **自定义代理**（[Subagents](https://developers.openai.com/codex/subagents)）：
  - 每个代理一个独立的 TOML 文件，放在 `~/.codex/agents/` 或项目的 `.codex/agents/`。必填 `name`、`description`、`developer_instructions`，其余写任意 `config.toml` 键，比如 `model`、`model_reasoning_effort`、`sandbox_mode`、`mcp_servers`、`skills.config`，不写就继承父会话。
  - 文档说这些文件是"spawned sessions 的配置层"，"format may evolve"。
  - 内置代理有 `default`、`worker`、`explorer`，同名时自定义的覆盖内置。
  - 文档的字段表里**没有工具白名单字段**，能力边界靠 `sandbox_mode`、`mcp_servers` 等配置表达。
- **模型与 effort 解析**：调用时显式给的值 > `[agents]` 默认值 > 父会话；代理文件里写了 `model` / `model_reasoning_effort` 就以文件为准（同页 "Custom agents"）。
- **全局设置** `[agents]`：`enabled`、`max_concurrent_threads_per_session`、`default_subagent_model`、`default_subagent_reasoning_effort` 等。旧的写法是 `agents.<name>.description` 加 `agents.<name>.config_file`（指向一个 TOML 配置层），见 [Configuration Reference](https://developers.openai.com/codex/config-reference)。
- **工具**：`spawn_agent`、`send_input`、`resume_agent`、`wait_agent`、`close_agent`（`features.multi_agent`，同上）。
- **调用**：本地版本只在用户直接要求或项目/skill 指令要求时才 spawn，比如 "spawn two agents…"、"Have pr_explorer map…"；CLI 用 `/agent` 在不同代理线程间切换。
- **自定义提示词**（[Custom Prompts](https://developers.openai.com/codex/custom-prompts)）**已废弃**，建议改用 skills：`~/.codex/prompts/*.md`，只看一层，frontmatter 为 `description`、`argument-hint`，支持 `$1`–`$9`、`$ARGUMENTS`、`$NAME`（以 `KEY=value` 传入），通过 `/prompts:<name>` 调用，修改后要重启。
- **Skills**（[Agent Skills](https://developers.openai.com/codex/skills)）：
  - 扫描 cwd 到仓库根目录之间每一层的 `.agents/skills`，以及 `$HOME/.agents/skills`、`/etc/codex/skills`。
  - 同名的不合并，两个都会出现。
  - 可选的 `agents/openai.yaml` 声明调用策略（`allow_implicit_invocation`）和依赖。
- **Hooks**（[Hooks](https://developers.openai.com/codex/hooks)）：
  - 写在 `hooks.json` 或 `config.toml` 的 `[hooks]` 里，有 `~/.codex/` 和 `<repo>/.codex/` 两层，项目层要信任后才生效。
  - 事件有 `PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStart`、`SubagentStop`、`Stop`、`SessionStart`、`SessionEnd`、`Interrupt`。
  - 同一事件匹配到的多个 command hook 并发启动。

### 4.3 opencode

- **代理**（[Agents](https://opencode.ai/docs/agents/)）：
  - 两种写法：`opencode.json` 的 `agent.<name>`，或 Markdown 文件 `~/.config/opencode/agents/<name>.md`、`.opencode/agents/<name>.md`，**文件名就是代理名**。
  - 字段：`description`（必填）、`mode`（`primary` / `subagent` / `all`，默认 `all`）、`model`（`provider/model-id`）、`prompt`（可写 `{file:./x.txt}`）、`temperature`、`top_p`、`steps`（最大迭代次数）、`disable`、`hidden`（不出现在 @ 补全里）、`color`、`permission`（`edit` / `bash` / `task` 等，取值 `ask` / `allow` / `deny`，支持 glob，最后一条匹配的规则生效）；`tools` 已废弃，改用 `permission`。其他键原样传给 provider，比如 `reasoningEffort`。
  - 子代理不写 `model` 时用调用它的主代理的模型。
- **调用**：主代理用 Tab 切换；子代理由主代理按描述通过 Task 工具调用，或用户 `@name`；`permission.task` 控制一个代理能调用哪些子代理，`deny` 的会从 Task 工具描述里消失；子代理会建子会话，可以在父子会话之间导航。内置主代理是 build / plan，子代理是 general / explore / scout。
- **命令**（[Commands](https://opencode.ai/docs/commands/)）：
  - `~/.config/opencode/commands/<name>.md`、`.opencode/commands/<name>.md`，或 JSON 的 `command.<name>`。
  - 字段：`template`（Markdown 写法里就是正文）、`description`、`agent`（由哪个代理执行；如果是子代理，默认作为子任务调用）、`subtask`（强制作为子代理运行，不污染主上下文）、`model`。
  - 支持 `$ARGUMENTS`、`$1…`、``!`cmd` `` 注入 shell 输出、`@file` 引用文件。
- 没有找到 opencode 有类似 Claude Code workflow 的脚本编排功能。只查了 agents / commands 两页，**未全面核实**。

### 4.4 字段对照

| 维度 | Pi 示例 `subagent` | Claude Code | Codex | opencode | Durable `AgentState` | PiNomad `subagent`（现状） |
| --- | --- | --- | --- | --- | --- | --- |
| 文件格式 | `.md` + YAML | `.md` + YAML；或 `--agents` JSON | 独立 `.toml` | `.md` + YAML；或 JSON | 无（存在 `pi.agent` 文档里） | 无（调用参数） |
| 名字从哪来 | `name` 字段 | `name` 字段 | `name` 字段 | 文件名 / JSON 键 | — | — |
| 提示词 | 正文，`--append-system-prompt` | 正文，替换系统提示词 | `developer_instructions` | 正文或 `prompt` | `instructions`（追加在扩展分段之后） | 固定的 `INSTRUCTIONS` 常量（`subagent.ts` 第 27–28 行） |
| 模型 | `model`（字符串） | `model` 别名 / ID / `inherit` | `model` | `provider/model-id` | `ModelRef {provider, modelId}` | 参数 `provider/modelId`（第 58、83–91 行） |
| 思考 / effort | 无（只继承） | `effort`；thinking 继承 | `model_reasoning_effort` | 透传 `reasoningEffort` 等 | `thinkingLevel` | 参数 `thinkingLevel`（会按模型 clamp） |
| 工具 | `tools` 白名单 | `tools` / `disallowedTools` | 无；用 `sandbox_mode` | `permission`（`tools` 已废弃） | `tools` 数组或 `{remove}`；`extensions` | 继承父对话，去掉 `subagent` 和 `question` |
| 发现 | `~/.pi/agent/agents`、最近的 `.pi/agents` | managed / CLI / 祖先 `.claude/agents` / `~/.claude/agents` / 插件 | `~/.codex/agents`、`.codex/agents` | `~/.config/opencode/agents`、`.opencode/agents` | — | — |
| 按名调用 | 模型按工具描述里的列表选 | 模型自动；`@agent-x`；`--agent` | 模型在被要求时 spawn | 模型经 Task 工具；`@x`；Tab | — | — |
| 多步 / workflow | 提示词模板驱动 `chain`，`{previous}` | 动态 workflow 脚本；skill `context: fork` | skill / 提示词驱动 | command 的 `agent` / `subtask` | `defineTask` phase + 子任务 | 无 |
| 隔离 | 独立 `pi` 进程，同一个 cwd | 同一个 cwd；可选 `isolation: worktree` | 子会话 | 子会话 | 由宿主 `env` 和 `cwd` 决定 | 共用父对话检出（ADR-0010 §5） |

## 5. 分类：直接用 / 要自建 / 等上游

**上游已经提供、PiNomad 可以直接用的**

- 把一份定义落到子对话上：`createConversation({ ownership: {kind:"task"}, agent })` 或 `configure(tx, id, AgentChange)`，可以设 `model`、`thinkingLevel`、`extensions`、`tools`、`instructions`、`cwd`（`types.d.ts` 第 246–275 行）。PiNomad 的 `subagent` 已经在用 `configure` 设置 `extensions.remove`、`instructions`、`model`、`thinkingLevel`（`subagent.ts` 第 103–108 行）。
- 拥有关系、级联中止、重启不重复派活：ownership 索引加 `requestId`（README 第 413–458 行；`subagent.ts` 第 70–78、131 行）。
- 多步持久编排的底层：`defineTask` 的 phase、子任务、`waiting` 加 `allSettled` / `failFast`（README 第 460–485 行）。
- 评审循环：`hook(GenerationTask, { onYield })`，只在选了这个扩展的对话里生效（`28-reviewer.ts` 第 33–44 行）。
- 解析 frontmatter：`parseFrontmatter`。Skills 加载：`loadSkills` / `formatSkillsForPrompt`。

**PiNomad 要自己建的（上游没有现成的公开 API）**

- 代理定义的文件格式、字段校验、发现位置、同名优先级、热加载和格式错误的提示（Pi 示例的 `discoverAgents` 可以参照，但不是导出）。
- 名字到运行时对象的映射：`AgentChange.tools` 要的是 `ToolRegistration` 对象，不是名字。PiNomad 的 `codemode` 类工具（比如 MCP）本来就不在 agent 的 `tools` 里（ADR-0013 §2），所以白名单怎么覆盖这类工具是 PiNomad 自己的语义（**推论**）。
- `subagent` 工具按名字调用的参数和描述（列出可用代理），以及"用户直接点名"（类似 `@agent` / 斜杠命令）在协议和客户端上的入口。
- 提示词模板的加载和 `$1` / `$@` 替换（上游函数没有导出）。
- workflow 本身：怎么写（提示词模板、声明式步骤、脚本）、存在哪里、怎么调用、步骤之间怎么传值、出错时怎么停、怎么在界面上呈现。
- 祖先目录的 Skills（以及代理）发现：上游的祖先遍历在不导出的 `DefaultPackageManager` 里。

**要等上游，或者上游正在变的**

- 嵌套工具调用、`callers` / `modelTools`、deferred tools、Durable 版 codemode（含重启后续跑和 `models.*`）：都在 Unreleased，还没有发布版本。升级要按 ADR-0002 显式评审，而且有破坏性改名（`content` → `output`）。
- 上游没有表示要做一等的具名代理或 workflow API：#7808 not planned，subagent 示例在 main 上没有改动。**这一条只是根据 issue 和 CHANGELOG 的推断。**

## 6. 取舍（只列事实，不做选择）

- **文件格式**：
  - `.md` 加 YAML（Pi 示例、Claude Code、opencode）提示词写起来方便，`parseFrontmatter` 现成可用。
  - TOML（Codex）能复用整套配置键，但官方自己说"heavier than a dedicated agent manifest"。
  - JSON 放在设置文件里（opencode、Claude `--agents`）可以集中管理，但长提示词要转义或用 `{file:}`。
- **名字从哪来**：用 `name` 字段（Pi 示例、Claude、Codex）可以随便改文件名，也允许子目录；用文件名（opencode、Pi 提示词模板）不会重名，但改名就是改身份。
- **发现位置**：
  - ADR-0006 规定上下文只从项目和 `~/.agents` 读，不读 `~/.pi`。
  - Pi 示例用 `~/.pi/agent/agents` / `.pi/agents`，Claude 用 `.claude/agents`，Codex 用 `.codex/agents`，opencode 用 `.opencode/agents`。
  - `.agents/` 目前只被 Agent Skills 规范和 Codex、Pi 的 skills 统一使用，没有看到跨产品统一的 `.agents/agents` 约定（**未核实是否存在**）。
  - 只看 cwd 会重复 ADR-0006 里"子目录启动看不到仓库根"的问题；往上遍历要定义同名时谁优先（Claude 是离 cwd 近的优先，Pi 示例只取最近的一个目录）。
- **项目级定义的信任**：项目里的代理和 workflow 是仓库控制的提示词，可能带工具权限。
  - Pi 示例默认不加载，要确认；Claude 的项目代理 hooks 要先信任工作区；Codex 和 Pi 的项目配置都要先信任。
  - PiNomad 现在默认不审批（ADR-0011），也没有项目信任的概念。
- **谁来选代理**：
  - 模型按描述选：省事，但描述会占上下文（Claude 在超过 15k token 时警告），模型也可能选错或不选。
  - 用户点名（`@` 或斜杠命令）：结果确定，但要做客户端入口，而且 Web / 桌面 / iOS 三端都要做（AGENTS.md "界面改动按端分开做"）。
  - 整个会话以某个代理运行（Claude `--agent`、Pi 预设、opencode 主代理）：对应的是 Durable 的 `configure`，不需要子对话。
- **workflow 的表示**：
  - 提示词模板驱动模型调用 chain（Pi 示例）：实现最少，但步骤顺序和"换模型评审"都靠模型自觉遵守，重跑不一定一致。
  - 声明式步骤列表（opencode command 的 `agent` / `subtask` 是单步版本）：可以校验，表达力有限。
  - 脚本（Claude 动态 workflow、pi-subagents）：编排写在代码里、可重复，但要沙箱、确定性约束（Claude 禁用 `Date.now` / `Math.random`）和一套脚本 API。PiNomad 已经有 QuickJS codemode 沙箱（ADR-0013），只是 `subagent` 目前不能在脚本里调。
  - Durable `defineTask`：重启后能从检查点继续，但每种 workflow 都是代码里定义的任务类型；用户写的 workflow 要先翻译成任务输入，而不是任务定义（**推论**）。
- **步骤之间怎么传值**：`{previous}` 字符串替换（Pi 示例）简单，但只能线性传递；脚本变量（Claude）能 fan-out / fan-in；JSON `schema` 输出（Claude `agent({schema})`、上游 Unreleased 的 `structuredOutput`）能做结构化分支。
- **耐久性**：
  - 子进程式子代理（Pi 示例）宿主一重启就丢。
  - Durable 子对话归任务所有，重启时会被找回来（PiNomad 现状）。
  - Claude workflow 只能在同一会话内恢复，而且会从第一个变化或失败的 agent 起把后面全部重跑。
  - Durable `failFast` 不补偿已完成的步骤（ADR-0002 后果）。
- **多 provider 的模型命名**：`provider/modelId`（opencode、PiNomad 现状、Durable `ModelRef`）不会有歧义；别名（Claude 的 `sonnet`、`opus`）可移植，但要一张映射表。定义里写死的模型在另一台宿主上可能没有凭据（Pi 预设遇到这种情况只警告）。PiNomad 的 `subagent` 已经会拒绝不在列表里的模型（`subagent.ts` 第 83–91 行）。
- **思考等级**：Pi 示例和 Claude 都不支持按代理设 thinking（只能继承，Claude 有 `effort`）；Durable 和 PiNomad 都有 `thinkingLevel`，换模型时还要 clamp。
- **工具白名单和检出**：子代理和父对话共用检出（ADR-0010 §5），并行写只靠描述约束（roadmap）。只读白名单（比如 reviewer 只给 `read`）能减少冲突，但 Pi 的 `reviewer.md` 自己就写了 "tool permissions are not perfectly enforceable"，因为 bash 可以写文件。Claude 另外提供了 `isolation: worktree`。
- **嵌套深度**：PiNomad 的子代理去掉了 `subagent` 扩展，不能递归。workflow 里如果有"子代理再派子代理"，就要改这条，或者由宿主来编排；Codex 默认 `max_depth = 1`，Pi 示例有过深度不受限的 issue（#8195）。

## 7. 未核实与局限

- Claude Code 动态 workflow 里 `agent()` 的完整选项（怎么指定子代理类型、模型参数名）正文没有列出；只读了 workflows、sub-agents、skills、hooks 四页。
- Codex 自定义代理没有工具白名单字段，这是根据文档字段表得出的结论；没读 Codex 源码。旧写法 `agents.<name>.config_file` 和新写法独立 TOML 文件之间的关系、优先级没有深究（有一个相关 issue：[openai/codex#14579](https://github.com/openai/codex/issues/14579)）。
- opencode 是否有脚本式 workflow 没有全面检索。
- `pi-subagents` 只读了 README 和 docs，没读源码，也没运行过。
- 上游 Unreleased 的嵌套调用能否让 `subagent` 在 codemode 里安全使用，只是推论，没有实测。
- Durable 示例 22/23/27/28 读的是 1.0.4 提交上的源码，没有在本地运行。
