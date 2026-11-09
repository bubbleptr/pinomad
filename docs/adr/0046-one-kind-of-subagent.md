# ADR-0046：子代理只有一种——有名字、能接着聊，派出时选等不等

- 状态：Accepted
- 日期：2026-11-10
- 修订：ADR-0038 §1（`lifecycle` 可以从 foreground 单向变成 background）、§3（主内容区可以给子代理发消息和 Stop）；ADR-0010 §5（子代理可以有自己的 worktree）
- 设计讨论：[子代理设计](https://claude.ai/artifact/PH32TaXxXqTuxNqVYAAtFy)

## 背景

ADR-0038 给子代理定了 `lifecycle`（foreground / background）和左侧侧栏的展示，但没有实现后台执行：现在的 `subagent` 只能前台派一次、答完就结束（[#151](https://github.com/bubbleptr/pinomad/issues/151)）。

几个现状：

- 上游 Durable 1.5.0 有 `{ background: true }` 的任务边界：父对话的 Esc 和空闲等待碰不到它，`abort({ background: true })` 能碰到。上游示例 22 用一个后台锚点任务拥有子对话，每条消息配一个后台回报任务，回答回来时作为输入发给父对话，request id 保证重启后不重发。
- ADR-0045 的后台进程已经定下"自己退出才用 `steer` 回报模型"这套规则；但它的进程活不过宿主重启，Durable 里的子代理却能。
- 第一版草案是两种固定的子代理：前台一次性的 `subagent`，加上后台常驻的 `subagent_start` 一组工具。"等不等它"和"能不能接着聊"两个维度有四种组合，只用到两种，模型和用户却要记两套工具和规则。
- Claude Code 只有一种子代理：每个都会返回 agent ID，`SendMessage` 能接着聊；前台还是后台只是运行方式，跑到一半能按 Ctrl+B 转到后台；接着聊的一律在后台跑。普通子代理从空上下文开始，继承父对话历史的只有 fork。

## 决策

1. **只有一种子代理。** 每个子代理都有名字，答完变空闲，之后还能接着发消息、能停。派出时用 `background` 决定这一次等不等它：不带就阻塞到回答，回答是工具结果；带上就立刻返回，回答之后回报给父对话。
   - 工具：`subagent` 新增 `name`、`background`、`checkout`；另有 `subagent_send`、`subagent_stop`、`subagent_read`、`subagent_list`，对任何子代理都能用。不做 `subagent_start` 和 `wait`：阻塞等结果就是不带 `background` 的 `subagent`。
   - `name` 可选，不给就由宿主从 `description` 生成；在 root 家族里唯一，侧栏和回报都用它。
   - 子代理从空上下文开始，只拿到 `task`；它继承的是父对话的模型、工具和工作目录这类 agent 配置，不是历史。这一点和 fork 不同。
   - `subagent` 可以安全重跑（名字在创建它的那次提交里登记，重跑会找到它）；`subagent_send`、`subagent_stop` 不重跑：重跑一次 stop 可能停掉之后的新工作，模型看到调用被打断，可以用 `subagent_list` 查。

2. **归属按上游示例 22 来，前台派出的照旧归那次调用。**
   - 后台派出的子对话由一个立刻结束的后台锚点任务拥有；前台派出的照旧归那次 `subagent` 调用，Esc 照旧能级联停掉它。
   - 之后每条消息，不管是父对话发的还是用户发的，都由一个归父对话所有的后台回报任务投递，并等它的回答。父对话的 Esc 和空闲等待碰不到这些任务。
   - `ConversationRecord.owner.conversationId` 仍然是派出者，ADR-0038 的真实 parent 不变。
   - 前台子代理在调用结束后还能接着跑，依赖 Durable 允许给 owner task 已经结束的对话再提交。实现时先验证；不成立就修订本条。

3. **状态记在派出它的对话的 `pinomad.subagents` 文档里**（`history: "latest"`、`fork: "initial"`，fork 不会复制出第二份）。
   - 每个子代理记：子对话、检出、状态（`working` / `idle` / `stopped` / `failed`）、还没结算的回报任务、已经报过的回答、`subagent_read` 读到了哪。
   - 状态由回报任务在结算的那次提交里写，和告诉父对话的那条输入是同一次提交，所以重启后既不漏报也不重报。几条消息合成一个回答时只报一次；其中有父对话发的，就按唤醒的方式报。

4. **告诉父对话的方式按消息是谁发的来定。**
   - 父对话派的消息答完或失败：一条 `whenBusy: "steer"` 的输入，带上最后一条回答或失败原因，和 ADR-0045 §4 一样，宿主不用先判断忙闲。
   - 用户直接发的：只给父对话 `write` 一行通知（"用户和 reviewer 直接聊了 2 轮"），不唤醒它、也不带回答原文；父对话要看内容就调 `subagent_read`，返回它上次看过之后的用户消息和回答，不含工具调用，有长度上限。
   - 模型自己停的不写；用户停的写一条说明。

5. **执行检出由派出时选，修订 ADR-0010 §5。** `checkout` 必填，`"shared"` 或 `"worktree"`，没有默认值；工具描述写明会改文件的用 worktree，只读的用 shared。
   - worktree 用 ADR-0010 那套机制：从父对话检出的 HEAD 开一个 `pinomad/` 分支，未提交的改动不带过去，记录存在 Durable 里，归档时清目录、留分支（§1、§2、§6、§7）。非 Git 项目、没有提交的仓库和 Chat 只能用 `"shared"`。
   - 回报里带分支名；合并由父对话或用户用 git 做，宿主不替模型决定（ADR-0010 §3）。
   - fork 的规则（ADR-0019）不变。

6. **界面上的修订（ADR-0038）。**
   - §1：`lifecycle` 不再是创建后就固定。前台派出的子代理第一次在原调用之外运行时（被 `subagent_send` 或用户接着聊），`SubagentDoc.lifecycle` 单向改成 `background`，从右侧 Tasks 挪到左侧侧栏，之后不再变回去。它仍然记在文档里，不从 taskGraph 推导。
   - §3：主内容区给子代理开输入框和 Stop。fork、重试、取回编辑和改模型仍然不开。用户的 submit 和 abort 由网关识别目标是子代理：submit 改成建一个 `from: "user"` 的回报任务，abort 之前先记下停止来源。
   - 前台派出的子代理还在那次调用里时，输入框不可用；Stop 就是对子对话 abort，那次调用随之失败，和 Esc 一样，父对话看到的是工具出错。调用结束之后才走上面的回报任务。

7. **上限、归档、重启。**
   - 每个 root 家族最多 8 个正在工作（有未结算的回报任务）的子代理。空闲的不算，因为它们永远不会自己结束。
   - 子代理不删除。归档时先对子树 `abort({ background: true })` 并等空闲，再清检出；取消归档后子代理是空闲的，还能接着用。
   - 重启和升级交给 Durable：没有 ADR-0045 那样的 `lost` 状态。正在工作的子代理是 live task，闲时升级自然会等它；空闲的不挡升级。

8. **子代理里不装 subagent 系列、question 和 processes。** ADR-0023 §9 的"子代理里不能再派子代理"不变。

## 考虑过的方案

- **两种固定的子代理**（前台一次性的 `subagent`，加上后台常驻的 `subagent_start` 一组，和 `process_*` 一样拆开）：每种的规则都简单，但两套工具、两套规则，四种组合里只用到两种。Claude Code 只有一种子代理也够用。
- **用户直接聊的回答原文写进父对话，或者每答一次都唤醒父对话**：前者让父对话的上下文越聊越大，后者让它空跑很多轮。
- **宿主监视子对话，看到它变空闲再回报，不建回报任务**：少一种任务，但监视不持久，宿主重启期间发生的转换会丢，还要另写补偿逻辑。
- **`checkout` 默认 `"shared"`**：派一个会改文件的任务时漏写一个参数，就会悄悄变成两边同时改一个目录。
- **`lifecycle` 保持创建时的值**：一个还在接着聊的前台子代理会一直待在只放"这次运行"的 Tasks 里，用户找不到它的输入框。

## 后果

- 协议：用户发消息和 Stop 复用现有的 submit 和 abort，`ConversationSummary.lifecycle` 5.26 就有了，可能不需要新的调用。实现时确认是否要升 `PROTOCOL`，并确认旧客户端看到可以交互的子代理时只是显示成只读、不会出错；Rust 核心跟着同步。
- 两条 Durable 假设还没核实：§2 的"前台子代理在调用结束后还能接着跑"，§4 的"带模型内容的 `write` 在父对话空闲时不会自己开一轮"。
- 上限 8 个照搬后台进程的数字，用一段时间再看。
- Web 和 iOS 分开做（AGENTS.md）。iOS 的导航当时由 ADR-0038 留到以后，这次随 iOS 的 issue 一起设计。
- 计划在 [M12 子代理](https://github.com/bubbleptr/pinomad/milestone/10)：[#675](https://github.com/bubbleptr/pinomad/issues/675) 宿主、[#676](https://github.com/bubbleptr/pinomad/issues/676) worktree、[#677](https://github.com/bubbleptr/pinomad/issues/677) Web/桌面、[#678](https://github.com/bubbleptr/pinomad/issues/678) iOS。
- 以后可能做：跑到一半把前台子代理转到后台（Claude Code 的 Ctrl+B）、具名 Agent 的定义固定 `checkout`、子代理里起后台进程或再派子代理、回报在父对话里单独渲染。
