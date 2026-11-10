# ADR-0047：子代理都在右侧 Tasks，对用户只读加 Stop

- 状态：Accepted
- 日期：2026-11-10
- 修订：ADR-0038 §2、§3、§5（Background 不再进左侧，所有子代理都在右侧 Tasks）；ADR-0046 §4（去掉用户直接聊的通知）、§6（去掉主内容区的输入框和按 `lifecycle` 挪位置）

## 背景

ADR-0046 让用户能在主内容区给子代理发消息。为了让人找得到这个输入框，Background 子代理留在左侧侧栏（ADR-0038 §2），Foreground 子代理被接着聊之后也要从右侧 Tasks 挪到左侧（ADR-0046 §6）。

用下来有两个问题：

- 侧栏里的东西不是一类。顶层对话和 fork 是用户自己带的任务，Background 子代理是模型派出去的工具，却有输入框、也在侧栏里，成了"半个对话"。"Foreground 该不该也进侧栏"这类问题答不清楚。
- 为这个输入框多出三套机制：用户直接聊时给父对话写一行通知并记下 request id（§4）；`subagent_read` 区分 User 和 Delegated；网关识别 submit 的目标是子代理并改建回报任务（§6）。

Claude Desktop 的划分是：子代理是模型的工具，列在右侧的 Background tasks 里，用户只能看和停；用户要亲自指挥的工作是会话，在侧栏里。主对话的 Esc 不停后台子代理，后台子代理在跑时主对话可以是空闲的，这两点 ADR-0046 §2 已经一致。

ADR-0038 否决过"Background 也留在右侧 Tasks"，理由是父对话空闲后它需要稳定入口，以及会出现两个导航位置。之后 ADR-0040 让 Tasks 跟着 root 家族走，打开家族里任何一条对话都能看到它的全部子代理；两个导航位置的问题，这次靠全部放右侧来解决。

## 决策

1. **侧栏只放用户自己带的对话：顶层对话和 fork。子代理一律在右侧 Tasks，** 和后台进程（ADR-0045）并列，不分 Foreground 和 Background。
   - 展示集合仍来自完整家族树，包含 fork 派出的子代理；真实 `parent`、`familyStatus`、`familyUpdatedAt` 的算法不变，根对话那一行照旧反映家族里有子代理在跑。
   - 正在工作的排在前面；空闲、已停止和失败的收在后面，默认折叠，因为子代理不删除（ADR-0046 §7），列表只会变长。
   - ADR-0038 §5 的左侧展开/折叠、Background 计数和树线去掉。

2. **用户对子代理只能看和 Stop，不能发消息。** 要指挥它就跟派出它的对话说，由模型用 `subagent_send` 转达；要亲自带一个任务，开一条对话。
   - 点开子代理是只读的对话内容加 Stop，入口是 Tasks 的详情，以及从那里"在主内容区打开"；子代理卡片和深链也按这个走。主内容区不出现输入框，其余限制照 ADR-0038 §3。
   - Stop 对任何状态的子代理都可用：还在那次调用里时就是对子对话 abort，调用随之失败（ADR-0046 §6 不变）；之后是先记下停止来源再 abort，回报任务给派出者写一行"用户停了它"（ADR-0046 §4 不变）。
   - 宿主拒绝用户对子代理的 submit。

3. **`lifecycle` 留着，只表示归属，不再决定位置。** `foreground` 是还属于那次 `subagent` 调用、父对话的 Esc 会级联停掉它；第一次在原调用之外运行时单向变成 `background`（宿主的这段逻辑不动，`subagent_send` 的校验要靠它）。客户端可以用它标出"随这次运行"，不能用它分栏。

4. **去掉只为用户直接聊而存在的部分。**
   - 宿主：`from: "user"` 的回报任务、"用户和 X 直接聊了 N 轮"的通知、`userRequests` 的登记和清理、`subagent_read` 里的 User / Delegated 标记，以及工具描述和子代理系统提示里"用户可能直接跟它聊"的句子。
   - `subagent_read` 保留，只返回它上次看过之后的回答：父对话压缩上下文后还能重新取到。
   - 模型侧的其余能力不变：名字、`background`、`checkout`、`subagent_send` / `subagent_stop` / `subagent_list`、后台回报、上限、归档和重启（ADR-0046 §1–§3、§5、§7、§8）。

5. **协议升到 5.34。** 5.33 的 feature `subagentMessages` 表示"子代理接受 submit 和 abort"，现在只接受 abort，换成新的 feature `subagentStop`。宿主不再公布 `subagentMessages`，已经发出去的 5.33 客户端会自动退回只读，不会出现发了消息才被拒绝的输入框。

## 考虑过的方案

- **只挪位置，保留输入框**：侧栏干净了，但子代理仍是"半个对话"，上面三套机制一样不少，Tasks 里还要多一种能输入的条目。
- **留在侧栏，改成只读**：侧栏里仍然混着两类东西，而且只读的条目占着导航位置。
- **不改**：功能最多。代价是概念不清，以后做远程子代理（[#685](https://github.com/bubbleptr/pinomad/issues/685)）时"用户直接聊"还要再跨宿主实现一遍。
- **连 `lifecycle` 一起去掉**：界面上不需要它了，但宿主要靠它判断子代理是否还在那次调用里，协议字段留着也不碍事。

## 后果

- 失去的能力：绕过派出者直接纠正某个子代理。
- [#683](https://github.com/bubbleptr/pinomad/pull/683)、[#684](https://github.com/bubbleptr/pinomad/pull/684) 刚做的主内容区输入框、Web 侧栏的 Background 行、iOS 输入框上方的后台子代理条都要撤掉。iOS 没有 Tasks 面板，子代理和后台进程一样列在 Overview 里（ADR-0045 §6），点开是只读加 Stop。
- 客户端的 `backgroundSubagentsOf`（左侧投影）去掉，`taskGroupsOf` 改成返回全部子代理；`crates/pinomad-core` 的 `family.rs` 和 FFI 跟着改，重新生成对照向量。
- 用户停掉一个空闲的子代理时没有回报任务在场，派出者不会收到说明；这是现状，停一个没在干活的子代理本来也没有可说的。
- 官网文档 `usage.zh.md`、`features`、`background-processes` 里关于侧栏位置和"接着聊"的说法随实现的 PR 一起改。
- 计划：[#686](https://github.com/bubbleptr/pinomad/issues/686) 宿主和协议、[#687](https://github.com/bubbleptr/pinomad/issues/687) Web/桌面、[#688](https://github.com/bubbleptr/pinomad/issues/688) iOS。Web 和 iOS 分开做（AGENTS.md）；宿主先合，两端各自依赖它。
