# ADR-0028：用户用 `$name` 明确调用 skill 时，由宿主把全文展开进消息

- 状态：Accepted
- 日期：2026-10-23
- 推翻 issue #143 的做法（`$name` 由模型按系统提示词里的规则自己去读）；补充 ADR-0006 §4

## 背景

#143 做的 `$name` 提及只是普通文本：输入框按词法规则高亮已知的名字，系统提示词里有一条固定规则，要求模型把 `$name` 当成明确请求，先用 read 工具读那个 skill 的文件。用户已经明确调用了，生效与否还要看模型：模型可能不读、读错，或者在代码和引号里自己判断"这不算请求"。标了 `disable-model-invocation` 的 skill 被 `listSkills` 和提示词一起过滤掉，`$` 菜单里没有，用户也调不了，而这个标记本来只表示"别让模型自己挑它"。

对照过三家 harness 的源码（2026-10-23）：Claude Code、Codex、pi-coding-agent 在用户明确调用 skill 时，都由 harness 读出 SKILL.md 全文放进上下文，不让模型自己去读。放法不同：Codex 作为单独的一条 user 角色消息注入；pi 的 `/skill:name` 把 `<skill name="…" location="…">` 块拼在这条消息前面，后面跟用户的参数。

## 决策

1. **宿主在写入时展开**。把用户文本写成 `pi.user` 的路径——`submit`、`createConversation`，以及走 `submit` 的带提示词 fork——都先经过同一个函数：用 `skillMentionRanges`（输入框高亮用的同一条词法规则）找出提及，按首次出现的顺序去重，每个 skill 一块，格式和 pi 的 `_expandSkillCommand` 完全一样：

   ```
   <skill name="review" location="/…/review/SKILL.md">
   References are relative to /…/review.

   （SKILL.md 去掉 frontmatter 后 trim 过的正文）
   </skill>
   ```

   多块之间空一行，最后空一行接用户的原文，`$name` 原样保留。没有提及时文本不变；图片照旧是后面的单独内容块。
2. **名字按 `listSkills` 的同一份清单查**，不另外扫描。已有对话用它的工作目录；新对话发第一条消息时还没有检出，用草稿 `$` 菜单的作用域（项目 + 检出方式，或 Chat 的用户 skill）。worktree 草稿读的是项目里 HEAD 已提交的 skill，`location` 指向项目目录里的文件。
3. **内联在 `pi.user` 里，不用自定义 entry kind，也不拆成单独一条消息**。自定义 entry 在旧客户端上整条消息都不显示，而且要另做一层把它转成模型消息；内联的话旧客户端最多在气泡里看到原始块。单独一条消息（Codex 的做法）在这里是两次输入：各占一个 submission，排队、转向、撤回都得成对处理，客户端还要把两条重新配对。和 pi 一致也意味着模型看到的格式与它在 pi 里见过的相同。
4. **显示时剥掉**。`packages/client` 的 `stripSkillBlocks` 只剥文本最开头、形状和上面完全一致的块（名字是 `[a-z0-9-]+`，`location` 不含引号和换行，正文到第一个 `\n</skill>` 为止），每块后面必须是空行加非空的剩余文本，否则原样返回。消息气泡、排队预览、编辑排队消息时的回填都用它，`crates/pinomad-core` 同步，iOS 只经核心读用户文本。宿主侧读用户文本的地方——摘要标题的首条消息回退、自动起名的输入——也剥。`packages/protocol` 的 `transcript()` 不剥：它没有界面调用方，报告的是模型看到的记录，而且 protocol 不能依赖 client。
5. **`disable-model-invocation` 只从提示词的 skill 列表里去掉**（`formatSkillsForPrompt` 本来就过滤）。`listSkills`、`$` 菜单和展开都包括它；项目里标了这个的 skill 仍然遮住用户目录里的同名 skill。
6. **删掉提示词里的 `$name` 规则**。模型自己挑 skill 的那部分（提示词里的列表加 read 工具）不变。
7. **展开不会让发送失败**。skill 文件读不出来时这一个不展开，其余照常，并给发送的客户端发一条 error notice；作用域本身列不出来（比如检出目录没了）时原文照发，发一条 warning notice。
8. 不改线上类型，不升 `PROTOCOL`。

## 考虑过的方案

- **保留 #143 的提示词规则**：不碰消息内容，但用户的明确调用仍然要看模型配不配合，`disable-model-invocation` 的 skill 也还是调不了。
- **像 pi 一样只认开头的调用**（`/skill:name` 必须在消息开头）：不会误触发，但和 #143 已有的输入框行为（任意位置高亮）不一致，用户看到高亮了却不生效。
- **Codex 式单独一条 user 消息**、**pi-durable 自定义 entry**：见决策 3。

## 后果

- `$` 规则是纯词法的：代码里的 `` `$review` ``、"别用 $review" 也会展开。靠输入框高亮让用户发送前看到哪些会生效。
- 旧客户端（旧版 iOS、旧的 Web 缓存）连新宿主时，气泡和排队消息编辑里会看到原始的 skill 块。
- 用户手打出和展开格式完全相同的开头块，显示时会被剥掉；skill 正文里如果有一行 `</skill>` 后面跟着空行，显示会从那里截断，把正文剩下的部分当成用户文本。
- worktree 新对话的第一条消息里，`location` 指向项目目录而不是 worktree，内容读的是项目目录里的当前文件，不一定等于 HEAD。
- 每次提及都把全文放进上下文：同一个 skill 在后面的消息里再提一次，会再展开一次。编辑排队消息后重新发送也会按当时的 skill 文件重新展开。
