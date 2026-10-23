# ADR-0028：用户从 `$` 菜单选中的 skill，由宿主把全文展开进消息

- 状态：Accepted
- 日期：2026-10-23
- 推翻 issue #143 的做法（`$name` 由模型按系统提示词里的规则自己去读）；补充 ADR-0006 §4

## 背景

#143 做的 `$name` 提及只是普通文本：输入框按词法规则高亮已知的名字，系统提示词里有一条固定规则，要求模型把 `$name` 当成明确请求，先用 read 工具读那个 skill 的文件。用户已经明确调用了，生效与否还要看模型：模型可能不读、读错，或者在代码和引号里自己判断"这不算请求"。标了 `disable-model-invocation` 的 skill 被 `listSkills` 和提示词一起过滤掉，`$` 菜单里没有，用户也调不了，而这个标记本来只表示"别让模型自己挑它"。

对照过三家 harness 的源码（2026-10-23）：Claude Code、Codex、pi-coding-agent 在用户明确调用 skill 时，都由 harness 读出 SKILL.md 全文放进上下文，不让模型自己去读。放法不同：Codex 作为单独的一条 user 角色消息注入；pi 的 `/skill:name` 把 `<skill name="…" location="…">` 块拼在这条消息前面，后面跟用户的参数。怎么算"调用"也不同：pi 要求 `/skill:` 写在消息开头；Codex 只认候选框里用 Enter / Tab 选中的那一项，选中后在输入框里变成一个 chip，手打的 `$name` 只是文字。

## 决策

1. **只有从 `$` 菜单选中的 skill 才算调用**（照 Codex）。选中后在输入框里是一个 chip，可以放在句子任何位置，发送时序列化成 `$name` 留在文本里；手打的 `$review`——包括引号、代码里的——只是文字。客户端把选中的名字放进 `submit` / `createConversation` 新增的 `skills` 参数（去重，按在文本里出现的顺序；协议 5.16，`FEATURE_SINCE.boundSkills`）。新客户端总是带上，没选就是空数组。
2. **宿主在写入时展开**。把用户文本写成 `pi.user` 的路径——`submit`、`createConversation`，以及走 `submit` 的带提示词 fork——都先经过同一个函数。带了 `skills` 的，按 `skills` 的顺序逐个展开，不看文本；空数组什么都不展开。没带 `skills` 的旧客户端，退回按文本匹配：用 `skillMentionRanges`（#143 输入框高亮用的词法规则）找出提及，按首次出现的顺序去重。每个 skill 一块，格式和 pi 的 `_expandSkillCommand` 完全一样：

   ```
   <skill name="review" location="/…/review/SKILL.md">
   References are relative to /…/review.

   （SKILL.md 去掉 frontmatter 后 trim 过的正文）
   </skill>
   ```

   多块之间空一行，最后空一行接用户的原文，`$name` 原样保留。没有要展开的 skill 时文本不变；图片照旧是后面的单独内容块。
3. **名字按 `listSkills` 的同一份清单查**，不另外扫描。`skills` 里有当前作用域没有的名字时，跳过它并给客户端发一条 warning notice。已有对话用它的工作目录；新对话发第一条消息时还没有检出，用草稿 `$` 菜单的作用域（项目 + 检出方式，或 Chat 的用户 skill）。worktree 草稿读的是项目里 HEAD 已提交的 skill，`location` 指向项目目录里的文件。
4. **内联在 `pi.user` 里，不用自定义 entry kind，也不拆成单独一条消息**。自定义 entry 在旧客户端上整条消息都不显示，而且要另做一层把它转成模型消息；内联的话旧客户端最多在气泡里看到原始块。单独一条消息（Codex 的做法）在这里是两次输入：各占一个 submission，排队、转向、撤回都得成对处理，客户端还要把两条重新配对。和 pi 一致也意味着模型看到的格式与它在 pi 里见过的相同。
5. **显示时剥掉，同时给出展开了哪些 skill**。`packages/client` 的 `stripSkillBlocks` 返回 `{ text, skills }`：只剥文本最开头、形状和上面完全一致的块（名字是 `[a-z0-9-]+`，`location` 不含引号和换行，正文到第一个 `\n</skill>` 为止），每块后面必须是空行加非空的剩余文本，否则留在文本里；`skills` 是剥掉的块的名字。消息气泡用 `text` 显示、只高亮名字在 `skills` 里的 `$name`；排队预览用 `text`；编辑排队消息时 `queuedInput` 回填 `text`，并按 `skills` 恢复 chip。`crates/pinomad-core` 同步（快照里的用户条目和 `QueuedInput` 都带 `skills`），iOS 只经核心读用户文本。宿主侧读用户文本的地方——摘要标题的首条消息回退、自动起名的输入——也剥。`packages/protocol` 的 `transcript()` 不剥：它没有界面调用方，报告的是模型看到的记录，而且 protocol 不能依赖 client。
6. **`disable-model-invocation` 只从提示词的 skill 列表里去掉**（`formatSkillsForPrompt` 本来就过滤）。`listSkills`、`$` 菜单和展开都包括它；项目里标了这个的 skill 仍然遮住用户目录里的同名 skill。
7. **删掉提示词里的 `$name` 规则**。模型自己挑 skill 的那部分（提示词里的列表加 read 工具）不变。
8. **展开不会让发送失败**。skill 文件读不出来时这一个不展开，其余照常，并给发送的客户端发一条 error notice；作用域本身列不出来（比如检出目录没了）时原文照发，发一条 warning notice。
9. 协议只多一个可选参数 `skills`（5.16）。旧宿主不认识它：客户端对 5.16 以下的宿主不发，`$name` 文字照常发出去。

## 考虑过的方案

- **保留 #143 的提示词规则**：不碰消息内容，但用户的明确调用仍然要看模型配不配合，`disable-model-invocation` 的 skill 也还是调不了。
- **按文本里的 `$name` 词法匹配**（本 ADR 的第一版）：不用改协议，但代码里的 `` `$review` ``、"别用 $review" 也会展开，用户只能靠输入框高亮提前发现。现在只留作旧客户端的退路。
- **像 pi 一样只认开头的调用**（`/skill:name` 必须在消息开头）：不会误触发，但 skill 只能放在句首，和 `$` 菜单可以插在句中的用法不一致。
- **按位置绑定**（`skills` 带上每个 chip 在文本里的偏移）：气泡能只高亮 chip 那一处，但偏移要跟着文本的每次编辑走，排队消息编辑、重发都要维护；按名字绑定已经够区分"调用了谁"。
- **Codex 式单独一条 user 消息**、**pi-durable 自定义 entry**：见决策 4。

## 后果

- 手打完整的 `$review` 但没从候选框选中，不会触发。
- 气泡按名字高亮：同一条消息里同名的 skill 既有 chip 又有手打的 `$review` 时，两处都会高亮（气泡只知道名字，不知道位置）。
- 不带 `skills` 的旧客户端走词法退路：代码里的 `` `$review` ``、"别用 $review" 也会展开。
- 旧客户端（旧版 iOS、旧的 Web 缓存）连新宿主时，气泡和排队消息编辑里会看到原始的 skill 块。
- 用户手打出和展开格式完全相同的开头块，显示时会被剥掉；skill 正文里如果有一行 `</skill>` 后面跟着空行，显示会从那里截断，把正文剩下的部分当成用户文本。
- worktree 新对话的第一条消息里，`location` 指向项目目录而不是 worktree，内容读的是项目目录里的当前文件，不一定等于 HEAD。
- 每次调用都把全文放进上下文：同一个 skill 在后面的消息里再选一次，会再展开一次。编辑排队消息后重新发送也会按当时的 skill 文件重新展开。
