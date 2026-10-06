# ADR-0006：宿主默认提供编码工具，上下文只从项目和 `~/.agents` 读取

- 状态：Accepted
- 日期：2026-10-06

## 背景

骨架阶段的宿主没有给 agent 任何工具和执行环境，系统提示词也是空的。接上真实模型只能聊天，既不能读文件，也不能跑命令。要做到自己能日常使用，需要先定三件事：用哪些工具、执行前要不要审批、AGENTS.md 和 Skills 从哪里读。

## 决策

1. **执行环境**：宿主为每个工作目录建一个 `NodeExecutionEnv`（Durable 的 `HarnessOptions.env`），同一个 cwd 的对话共用一个环境，宿主关闭时统一清理。这是 ADR-0003 中"宿主以本机 shell 和代码仓库作为执行环境"的直接落地，不提供关闭开关。
2. **编码工具**：先直接装 Durable 自带的 `CodingTools`（read / write / edit / bash），作为内置扩展 `coding` 注册（ADR-0004）。grep / find / ls 和读图片以后由第一方补齐。
3. **默认不审批**：和 Pi CLI 一样，工具直接执行。宿主目前只监听 127.0.0.1，并且需要 token。审批闸门以后做成可选项，复用 `pinomad.approval`（ADR-0005）。
4. **上下文**：由内置扩展 `context` 提供系统提示词的几个分段：PiNomad 自己的开场说明、工作目录、项目上下文、Skills。每次请求都重新从文件系统读取，修改 AGENTS.md 或 Skill 文件后不用重启。
   - AGENTS.md 读两类：`~/.agents/AGENTS.md`（全局），以及从文件系统根目录到 cwd 沿途的 AGENTS.md / CLAUDE.md（项目，靠近 cwd 的排在后面）。
   - Skills 从 `<cwd>/.agents/skills` 和 `~/.agents/skills` 读取，同名时项目的生效。
   - AGENTS.md 和 Skills 不从 `~/.pi` 读（ADR-0001）。宿主仍然复用 pi 的两类设施（ADR-0002）：`~/.pi/agent` 下的模型认证，以及 pi 的 settings.json，用来读默认模型、思考等级、重试、压缩和代理配置（`SettingsManager.create(cwd)`，同时会读项目下的 `.pi/settings.json`）。PiNomad 要不要有自己的设置文件，等做设置界面时再决定。
   - 文件加载复用 `pi-coding-agent` 导出的 `loadProjectContextFiles`、`loadSkills`、`formatSkillsForPrompt`。

## 后果

- 宿主进程能执行任意命令，安全边界完全依赖"只监听本机 + token"。做远程访问之前，必须先定好认证方式和审批策略（ADR-0003 遗留项）。
  - 认证已由 ADR-0008 决定；可选的审批闸门仍未做，见 `docs/roadmap.md`。
- 只扫描 `<cwd>/.agents/skills`：在仓库子目录里启动时，看不到仓库根目录下的 Skills。
- Skill 文件格式有误时目前直接忽略，不会提示用户。
