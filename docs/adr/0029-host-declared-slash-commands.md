# ADR-0029：斜杠命令由宿主声明，只在消息开头识别

- 状态：Accepted
- 日期：2026-10-23

## 背景

#143 把 composer 里的两种前缀分开：`$` 提及 Skill，宿主把 Skill 全文拼进发给模型的消息、由模型执行（ADR-0028）；`/` 留给不发给模型、由宿主直接执行的命令（#254）。

pi-durable 没有命令这个概念：`Conversation.compact()`、`reset()` 只是普通方法。斜杠命令在 pi-coding-agent 的 AgentSession 里，PiNomad 不走那条路（ADR-0001、0002）。所以命令要 PiNomad 自己定义。在这之前，客户端只有 `+` 菜单里的一项"压缩上下文"，直接发 `compact` 调用，这一项写死在客户端里。

## 决策

1. **命令由宿主声明**：协议 5.17 加两个调用。`listCommands { conversationId } → { commands }` 按对话列出能用的命令，每项是 `{ name, description, argumentHint?, source, disabled? }`：`name` 不带斜杠；`source` 是 `builtin` 或 `plugin`；`disabled` 是暂时不能用的原因，客户端置灰显示。`runCommand { conversationId, name, args? }` 执行一个列出的命令，`args` 是命令名后面的文字；名字不认识时调用失败，错误信息写明。
2. **客户端不写死命令表，也不从 task 或 pi-coding-agent 的命令自动生成**：`/` 菜单的内容只来自 `listCommands`。宿主低于 5.17 时客户端不显示 `/` 和"命令…"，`+` 里保留原来的"压缩上下文"，走原来的 `compact` 调用；`compact` 调用保持不变，旧客户端照常能用。
3. **只在消息开头识别**：文本在下标 0 是 `/`（前面的空白不跳过），后面直到第一个 Unicode 空白（`White_Space`）的部分和某个列出的名字完全相同（区分大小写），才算命令；其余部分去掉两端空白就是 `args`，为空时不带。`/usr/bin/x`、未知的 `/foo`、`/compactX`、`hello /compact` 都按普通消息发出。草稿里有图片时客户端拒绝执行命令并提示。规则在 `packages/client`（`parseCommandInput`），`crates/pinomad-core` 有一份镜像，用同一张用例表对照。`disabled` 的命令照样识别，怎么处理由界面决定。
4. **命令立即执行，不进 inbox**：不走 steer / follow-up，也不在对话里留一条用户消息。`listCommands` 和 `listSkills` 一样是只读查询，不排在客户端的命令队列后面；`runCommand` 会改对话，和 `compact` 一样排在之前的命令后面，失败变成通知——先发一条消息再 `/compact`，压缩要在那条消息被宿主接受之后才发。
5. **第一期只有内置的 `/compact [说明]`**：映射到 `conversation.compact(说明)`，完成后发和 `compact` 调用一样的通知。`source` 字段给以后的插件命令留了位置，但插件注册命令的机制不在这次范围；`/reset`、`/clear`、`/handoff` 也不做（要不要暴露 `Conversation.reset` 还没定）。

## 考虑过的方案

- **客户端写死命令表**：Web 和 iOS 各写一份，宿主加命令就要等每个客户端发版；新客户端连旧宿主时会列出宿主做不了的命令。能做什么只有宿主知道。
- **从 pi-coding-agent 的斜杠命令或 task 生成**：PiNomad 不用 AgentSession，那边的命令表接不上；task 是 agent 的工作单元，不是用户的入口，两者的生命周期也不一样。
- **`/` 也做成发给模型的提示词模板**（类似 Claude Code 的自定义命令）：这是 `$` Skill 已经承担的事。`/` 只放不经过模型的操作，用户看到 `/` 就知道这件事不会消耗一轮对话。
- **任何空白后面都识别**：Astryx 的 `useTriggerMenu` 默认如此，但路径（`/etc/hosts`）和正文里提到的命令会误判。命令是一条消息的整体意图，只看开头。
- **`runCommand` 也不进命令队列**（#254 最初的写法）：查询不排队是为了不被卡住的命令拖住菜单；执行命令要和前面的发送保持顺序，所以排队。

## 后果

- 加一个内置命令只改宿主，所有 5.17 以上的客户端自动出现；连旧宿主时没有 `/` 菜单，只剩 `+` 里的"压缩上下文"。
- 不是命令的 `/` 开头消息原样发给模型：打错的 `/compactt` 不会报错，会作为普通消息发出。界面可以在开头的 `/` 菜单里提示，但识别规则不猜。
- 列表按对话查询，以后可以按对话状态（例如正在运行）返回 `disabled`，客户端不用改；代价是打开菜单多一次往返，客户端可以缓存。
- 识别规则改动时要同步改 Rust 镜像并重新生成对照向量。
