# ADR-0051：Inbox 模式：事件进项目的 Inbox，一个 worker 依次取任务，每项任务一个对话

- 状态：Accepted
- 日期：2026-11-15
- 修订：ADR-0011 §1（Inbox 的运行加 auto mode，不再一律直接执行）、ADR-0049 §7（插件可以做事件源）
- 补充：ADR-0040 §1（Inbox 模式下 Tasks 页多出 Inbox 的设置）
- 被补充：[ADR-0052](0052-inbox-memory-outbox-credentials.md)（§5：记忆和固定上下文；§9：`notify` 经发件箱投递）
- 设计记录：[定稿文档](https://claude.ai/artifact/YHeeoeJCSssbuisqFGw3ys)、[界面画布](https://claude.ai/artifact/PdBwd7zfGqm333LJnzfHiC)

## 背景

现在每次运行都由用户发消息触发。越来越多的 agent 框架改成事件驱动：bug、定时任务、GitHub 事件进一个收件箱，后台的 worker 取出来处理，用户只在值得的时候被叫到。Anthropic 的 [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) 把这套结构拆成收件箱、worker、计时器、记忆、发件箱和延后的工具调用。

PiNomad 已经有其中一半：对话就是能恢复的 worker，Durable 的 `pi.inbox` 按 `requestId` 去重，一条对话同时只有一次运行，`ask_user_question` 是持久化的延后调用，推送经服务端到手机。缺的是对话之上的那一层：事件从哪进来、谁来取、后续事件回到哪、什么时候打扰用户。

最早的草案是"一个 watch 一条长对话"：订阅挂在对话上，事件按到达顺序进同一条对话。用户纠正了这一点：重点是事件触发 worker 去跑，典型场景是提了几个 bug，它们进 Inbox，worker 去拿任务。

## 决策

1. **新增 Inbox 模式，每个项目一个 Inbox。** 侧栏顶部是模式切换（编码 / Inbox）。Inbox 模式下每个项目一行，项目下按"等你 / 进行中 / 待处理 / 已完成"列出任务，主区是选中任务的对话，右侧面板照旧。worker 在哪个目录干活由项目决定，不同项目之间可以并行。Chat 没有 Inbox。

2. **一行是一项任务，每项任务一个普通对话。** 事件挂在任务上：第一个事件开出任务，后续事件补进去，已完成的任务被后续事件重新打开。状态不单独存，由任务和对话推出：有未处理的事件是待处理，对话在跑是进行中，有待答的提问是等你，关掉的是已完成或已跳过。Inbox 的对话只在 Inbox 模式里列出，不进编码模式的侧栏。
   - 实现时改（#806）：已跳过要单独记一个 `skipped` 标记，因为跳过和完成都只是"关掉"，从事件和对话推不出区别；它和"失败"一样，下一个事件重新打开任务时清掉。推导在 `packages/client/src/inbox.ts`（`inboxTaskState`），先看关掉的方式（失败、跳过、完成）；没关的先看对话当下的状态（有待答提问是等你，在跑是进行中），再看 worker 的标记（停在提问上、有一批在途），最后是待处理：对话在跑时新到的事件留给下一批，任务仍算进行中；回答之后 `waiting` 要等这次运行结束才清，这段时间按对话的状态算进行中。`inbox` 宿主流（5.38）给每个已注册的项目一项，带任务和事件、thread、处理规则和未到点的跟进；worker 的 batch 只以 `inFlight` 露出。

3. **一个 Inbox 一个 worker，一次只开跑一项。** worker 是宿主上的一个 Durable 任务，没活时睡着。它取出一项任务所有未处理的事件，合成一次运行；运行中来的事件排队，下一次再处理。一项停在"等你"时 worker 接着取下一项，回答后原对话直接接着跑：Git 项目里每项任务有自己的 worktree（ADR-0010），互不干扰；非 Git 项目没有这层隔离，有一项在等你时整个 Inbox 暂停。
   - 实现时改（#803）：worker 是宿主代码，不是 Durable 任务。Durable 的任务必须挂在某个对话上，而 Inbox 没有自己的对话；睡着的任务也只能按时间醒，等不了文档变化。worker 的每一步都提交到会话级的 `pinomad.inbox` 文档，两次提交之间唯一的副作用（接纳一条提交）用先记下的 request id 去重，所以重启后不重复、不丢。

4. **事件带 `thread`，按 thread 回到原任务。** Inbox 记着 thread → 任务；对不上的事件开新任务。开出任务的那个事件自带的 thread（比如一个 issue）在建对话时自动登记；之后才出现的（比如 agent 开的 PR）由 agent 调 `inbox_follow` 登记。agent 给自己设的跟进（`wake_me_at`）直接带任务 id。

5. **事件只以转义的 `<event>` 块进对话，只带摘要和指针。** 细节由 agent 自己去取。每个新对话开始时加载这个 Inbox 的处理规则和项目的 AGENTS.md；每项任务一个短对话，照常自动压缩。

6. **点项目名进入它的收件对话，用户经它提交任务。** 每个项目一条长期的收件对话：用户把事情说给 agent，它追问、拆分、把重复的补进已有任务，然后用 `inbox_submit` 放进 Inbox；也可以在这里问进度。收件对话只有只读工具、提问和 `inbox_submit`，自己不修。它按用户的话写的任务算用户写的；引用了外部原文（比如 issue 正文）的算外部写的。不做"一句话直接提交"的输入框。
   - 实现时改（#804）：收件对话在用户发第一条消息时才建（建对话要带第一条消息），不随 Inbox 一起建；在项目目录里，不开 worktree。只读工具目前只有 `read`，没有只读的搜索。`inbox_submit` 的 `external` 由 agent 标注，标了就按外部写的算。系统提示里的任务列表每次请求重新渲染。

7. **Inbox 的运行由 auto mode 把关（修订 ADR-0011 §1）。** 每次工具调用先过分类器：安全的直接跑，危险的拦下，拿不准的变成 `ask_user_question` 等用户。分类器知道这次运行有没有外部写的内容（issue、PR 评论、webhook），有就判得更严。编码模式不变，仍然直接执行。ADR-0011 放弃审批闸门的理由是"人在场时逐条批准打断太多"；Inbox 的运行是人不在场时由外部事件触发的，没人看着、内容可能来自陌生人，这个理由不成立。
   - 实现时定（#805，设计记录见 [auto mode 方案](https://claude.ai/artifact/HF7GkH2DD7rWFsciixGqrF)）：挂在 Durable 的 `beforeTool` 钩子上，只管 Inbox 任务的对话（收件对话和记忆整理不管）。先过规则表：只读工具和只读命令放行，`sudo`、强推、改 git 配置或远端、`curl | sh`、删家目录直接拦；运行里有外部内容时，联网和装依赖的命令交给用户。规则判不了的交给分类器（宿主有 Haiku 5.5 就用它，否则用默认模型），只给它工具名、参数、任务标题和信任标记，出错按"问用户"。钩子写不了文档，所以"问用户"是拦下调用并让 agent 用 `ask_user_question` 问，题干必须原样引用这次调用；用户选"Allow"后，同一调用放行一次。每次判断记在对话级的 `pinomad.auto-mode` 文档里（保留最近 100 条）。

8. **计时器单独存放，到点只往 Inbox 写一个事件，不直接开跑。** 定时事件源和 `wake_me_at` 都这样。宿主判断空闲（自动升级、空闲重启）时不算睡着的 Durable 任务，否则只要有计时器就永远等不到空闲。
   - 实现时改（#803）：worker 不是 Durable 任务，不会因为睡着的任务挡住空闲判断，空闲判断不用改。计时器存在会话级的 `pinomad.inbox-timers` 文档里，宿主按最早的到点时间定一个闹钟（最长一分钟复查一次）；到点时在同一次提交里写 Inbox 事件（事件 id 带到点时间，重启后不重复）并把跟进标为完成、把定时推到下一次，宕机期间错过的几次只补一次。

9. **新增 `notify` 工具；Inbox 的运行不推默认的 Finished。** 一次运行有三种结局：通知用户、安静结束、停下来提问。提问照旧推"Waiting for your answer"。
   - 实现时补（#803）：推送只带固定的 "Update for you"，`notify` 写的正文留在宿主，记在会话级的 `pinomad.outbox` 文档里，推送照 ADR-0025 §8 只带标题和固定文字。Failed 照旧推。Web 和桌面端的系统通知要等协议里有 Inbox 的快照（#806）才能区分，在那之前仍会显示 Finished。
   - 实现时补（#806）：Web 和桌面端从 `inbox` 流取出各任务的对话，`diffRunNotices` 对它们不发 Finished；提问和 Failed 照旧。收件对话是用户在场时的普通对话，照常发 Finished。

10. **事件源挂在 Inbox 上：定时、插件、局域网 webhook（修订 ADR-0049 §7）。** 插件可以声明事件源，由宿主轮询或由插件推送。第一期不做公网入口：webhook 只开在局域网和 tailnet 上的 `POST`（HMAC 签名）。经服务端转发 webhook 会让服务端看到明文，和"服务端只转密文"（ADR-0008、0022）冲突。GitHub 这类外部服务靠插件轮询。
   - 实现时定（#808，5.39）：事件源存在会话级的 `pinomad.inbox-sources` 文档里，`inbox` 流给每个项目带上 `sources`，客户端用 `addInboxSource`、`setInboxSourceEnabled`、`removeInboxSource`、`resetInboxWebhookSecret` 管理。设计稿添加对话框里的"受限工具 / 全部工具"就是事件的 `trusted`，只影响 auto mode 判得严不严（第 7 条），不是两套工具（见"没选的方案"）；它由用户添加时选，插件和请求体都改不了，定时算用户写的。
   - 插件和 webhook 事件源要求有沙箱（ADR-0052 §7）：没有时添加和重新打开都被拒，`inbox.externalSources` 告诉客户端。
   - 定时事件源是计时器文档里的一个计时器（`source:<id>`），按所选时区的墙上时间算下一次（每天、工作日、每周或五段 cron），不再是固定周期。每次到点开一项以事件源命名的新任务，不用 thread 串成一项。春季拨快跳过的时间在拨快那一刻触发，秋季重复的只触发第一次；宕机错过的只补一次。它不算跟进，不出现在 `followUps` 里，`cancelFollowUp` 也拒绝它。
   - 插件用 `source()` 声明事件源：轮询（`poll`，默认五分钟、一分钟到一天，游标和事件在同一次提交里存下，崩溃只会重复一次轮询，重复的事件按 id 去掉）或推送（`listen`）。事件 id 前面加上来源和事件源 id，谁也占不了别人的或宿主的 id。`followedOnly` 的事件只送给已经跟着这个 thread 的任务，其余丢掉：PR 评论和 CI 结果不该每条开一项任务，应该回到开或跟着这个 PR 的任务。插件没加载时事件源保留，上面显示原因。
   - webhook 是两个监听端口（loopback 和局域网的 0.0.0.0）上的 `POST /inbox/<项目的记忆目录名>/events`，带 `X-Pinomad-Source`、`X-Pinomad-Timestamp` 和 `X-Pinomad-Signature`（`sha256=` 加上对 `<timestamp>.<body>` 的 HMAC-SHA256）。只接本机、RFC 1918、`100.64.0.0/10`（tailnet）和 IPv6 唯一本地地址来的请求，带转发头的一律拒绝（反向代理后面可能是公网）。时间戳窗口五分钟，窗口里的重放带的是同一个事件 id，去重后不起作用；请求体上限 64 KB。来源不明、已关闭、签名不对和时间戳过期都回同一个 401。密钥由宿主生成，存在 `secrets.json` 里插件名取不到的 `@inbox-webhooks` 名下，只在添加和重置时返回一次；URL 用配对邀请同样的局域网地址，不用 `publicUrl`。

11. **Inbox 的设置放在 Tasks 页（补充 ADR-0040 §1）。** Inbox 模式下 Tasks 页多出这个 Inbox 的处理规则、事件源和跟进；侧面板仍是 Tasks、Changes、Terminal 三个 Surface，不加第四页。

## 后果

- 宿主多一类长期活着的 Durable 任务（每个 Inbox 一个 worker，加上计时器）。空闲判断要改成不算睡着的任务，这一条要先于 worker 落地。
  - 由第 3 条的实现修订作废：worker 是宿主代码，空闲判断不改。另一条照旧成立：等你的任务有待答提问，提问本来就算忙（`service/idle.ts`），会挡住自动升级和空闲重启，直到用户回答。
- auto mode 是整个计划里最大的未知数：分类器用哪个模型、规则怎么写、编码模式以后要不要也能开，都还没定。在它落地前，Inbox 的运行不能接外部事件源。
- 一个 Inbox 会短暂有两个对话同时在跑（worker 正在跑的那项，加上刚被回答、接着跑的那项）。
- 协议要加 Inbox 的快照和调用，升次版本号；`packages/client` 的状态推导和 Finished 推送规则要同步到 `crates/pinomad-core`。
- Web 和桌面端先做，iOS 单独一个 PR。
- 每项任务都从新对话开始，比长对话更依赖记忆：每个 Inbox 的笔记和整理留到之后。
  - 由 [ADR-0052](0052-inbox-memory-outbox-credentials.md) 接上：记忆、整理、发件箱和凭据都在那里。

## 没选的方案

- **一个 watch 一条长对话**：所有事件进同一条对话按顺序跑。几个 bug 的上下文混在一起，一项卡住全部卡住；用户想的是"任务排队、一项项处理"，不是跟一个对话一直聊。
- **每个宿主一个 Inbox**：worker 得先判断任务属于哪个项目，几个项目的任务还要排同一条队。
- **侧栏只列 Inbox、主区放任务表格**：总览更全，但看一项要多点一下，从对话回到列表也要多一步。
- **单独的提交表单**：说不清的事没法追问，一段话里的几件事也没法拆开。
- **按内容来源固定给"受限 / 全部"两档工具**：修 bug 必须能写文件，受限档做不了事；全部档又等于让外部内容直接指挥 shell。
- **经服务端转发公网 webhook**：服务端会看到明文。
