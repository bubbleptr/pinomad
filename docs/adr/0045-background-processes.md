# ADR-0045：后台进程由宿主在内存里运行，在 Tasks 里展示

- 状态：Accepted
- 日期：2026-11-08
- 补充：ADR-0040 §1、ADR-0041
- 修订：ADR-0040 §6（Tasks 图标的活动点把运行中的后台进程算进去）

## 背景

宿主提供的 `bash` 工具来自上游 `@earendil-works/pi-durable`，每次调用都等命令退出才返回。agent 要起 dev server 或 `tail -f` 之类的监控命令，只能自己写 `cmd &`、`nohup` 或 `tmux`。这样跑起来的进程不在宿主视线里：没有列表、看不到输出、停不掉，对话归档时也不会收尾。

`GLOSSARY.md` 里的 "Background" 已经专指有独立对话的 Background 子代理（ADR-0038），这里由 agent 启动、宿主跟踪的长期命令叫"后台进程"。要定的是：生命周期用不用 Durable task、宿主崩溃后怎么交代状态、列表存哪、什么时候回报模型，以及归档和升级怎么收尾。

## 决策

1. **后台进程由宿主在内存里运行，不建 Durable task；工具是独立扩展，运行时是和终端并列的宿主服务。**
   - OS 进程只活在这一代宿主进程里。如果每个进程建一个 Durable task，task 的 checkpoint、abort 处理器和持久文档会变成三份重复的生命周期；宿主缺 pty 时，标了 restart 的旧 task 还会一直等定义，让闲时升级永远等下去。
   - 按 ADR-0004 的插件边界分两层：模型工具（`process_start`、`process_output`、`process_stop`、`process_list`）放在独立的内置扩展里，不包装、不改上游 `bash`，Foreground 子代理不装这个扩展；进程管理是和终端并列的宿主服务，由网关接流、调用、归档、关闭和升级，扩展只调注入的运行时接口。以后挪成外部插件时，工具跟着插件走，运行时作为宿主能力留在宿主。

2. **用 pty 运行，停止发给整个进程组（SIGTERM → SIGKILL 并等待）；宿主崩溃后状态是"失去跟踪"（`lost`），不声称已停止、不按旧 pid 杀。**
   - 和终端一样用懒加载的 `@lydell/node-pty` 起 `$SHELL -lc <command>`，固定尺寸、不接受输入，共用带上限的 `seq` 输出缓冲（ADR-0041 §1、§3）。缺 pty 时 `hello` 不带 `processes`，扩展不注册工具。
   - `node-pty` 自带的 `kill()` 只发给 shell 本身，SIGHUP 也可能被忽略。停止时先在内存里记下停止原因（`agent` / `user` / `archive` / `shutdown`，先记下的优先），再给整个进程组发 SIGTERM，超时还在就发 SIGKILL，一直等到进程退出。
   - 子进程仍可能 `setsid` 脱离进程组，所以宿主崩溃后不能保证进程已经退出。下次启动时（不依赖 pty），文档里仍处于 `starting` 或 `running` 的条目统一结算成 `lost`，界面如实说明宿主重启后已失去跟踪、进程可能仍在运行，不说"已停止"，也不按旧 pid 去杀。

3. **列表放在 root 对话的持久文档 `pinomad.processes`，不从 `taskGraph` 推导。**
   - `watchTaskGraph()` 的节点只有 `phase` 字符串，task 一结束就从图里消失，存不下命令、退出码和停止原因；而且后台进程不建 Durable task。
   - 文档挂在家族的 root 对话上（`history: "latest"`、`fork: "initial"`），家族内所有读写和订阅都落到 root，Fork 不会复制出第二份。状态有 `starting`、`running`、`exited`、`stopped`、`failed`、`lost`，已结束的保留最近 20 条。列表来自文档，`hello` 里没有 `processes` 时历史列表照常显示；输出流 `process:<id>` 和停止调用 `stopProcess` 只在 `hello.processes` 存在时可用。

4. **只有进程自己退出才回报模型，和文档更新同一次提交，`whenBusy: "steer"`；被停止、宿主关闭、立即升级期间都不回报。**
   - 进程自己退出（之前没有记下停止原因）时，宿主在同一次 `conversation.commit()` 里先调 `submit(tx, { type: "input", whenBusy: "steer", requestId })` 附上退出码和末尾输出，再把文档更新成 `exited`。`whenBusy: "steer"` 在对话空闲时直接启动一次运行，正在运行时排成 steer，不需要宿主先在外面判断忙闲。监控命令写成"事件发生就退出"的单次命令，靠退出回报唤醒模型，不做按行匹配回调。
   - 被停止（agent、用户、归档、关闭）只更新文档，不回报：agent 自己停的直接看工具结果；用户停的，agent 之后调 `process_list` 或 `process_output` 能看到，也不往转录里写模型看不到的纯展示记录。
   - 宿主正常关闭时先进入关闭状态再发信号，关闭状态下的退出一律不回报。立即升级安装期间进程退出照常记进文档，但不回报，安装失败恢复后也不补报，避免绕过升级排空（ADR-0043 §3）。

5. **属于发起它的对话，按 root 家族每家族最多 8 个；归档（范围同终端）先封住再停、等退出后清检出；闲时升级等进程结束，立即升级停掉它们。**
   - 每个进程记录 `owner` 为发起它的对话，工作目录是该对话的执行检出。上限按 root 家族算，每家族最多 8 个未结束的进程（`starting`、`running` 和正在停止的都算）；检查上限、内存登记和把 `starting` 写进文档在同一段同步代码加一次提交里完成，避免并发启动越界。
   - 归档（root 或 Fork，范围同终端，即 `conversationSubtree`）先封住这个范围不再接受新进程，再停掉范围内所有未结束的进程并等它们退出，最后才清理检出。
   - 闲时升级（ADR-0043 §5）的 `busy` 加上"有运行中的后台进程"，不悄悄杀掉用户的 dev server；立即升级在确认时提示会停掉后台进程，安装开始时按正常关闭停掉它们。

6. **修订 ADR-0040 §6：Tasks 图标的活动点算上运行中的后台进程。**
   - Web/桌面端在右侧 Tasks 里加 Processes 分组，和 Foreground 子代理并列，点开是只读输出和 Stop；Tasks 首行计数加上运行中的后台进程。Tasks 不可见时，聊天区头部 Tasks 图标上的活动点同时反映运行中的 Foreground 子代理和运行中的后台进程。iOS 在 Overview 里列出后台进程并提供 Stop。

## 考虑过的方案

- **每个后台进程建一个 Durable task**：OS 进程活不过宿主重启，用 task 管生命周期会让 task checkpoint、abort invocation 和文档变成三份重复状态；`abortTask` 不等待 abort 处理器跑完，归档清检出前还得自己等进程退出；缺 pty 时，标了 restart 的旧 task 结算不了，会让闲时升级永远等下去。
- **包装上游 `bash` 工具，加 `run_in_background` 参数**：不改上游默认工具的签名和行为；启动、读增量输出、停止和列举拆成一组独立的 `process_*` 工具，职责清楚，也不必让每次普通命令调用都多背一套分支参数。
- **让 agent 操控终端页面，或做成只读终端标签**：操控交互式终端需要发送按键、读屏幕状态等更多工具，对模型更难用；做成只读终端标签又会把 agent 起的进程混进用户的终端标签栏，生命周期和自动回报规则也和用户终端不同。
- **把运行时放进扩展，并给扩展加归档、关闭、升级等通用钩子**：ADR-0004 的三个公开条件还没满足，现在为单个内置功能设计通用生命周期钩子是提前设计插件宿主接口。工具按扩展边界写，运行时和 `terminals` 一样作为宿主服务由网关直接接线。

## 后果

- 协议升次版本号（5.31），新增 `process:<id>` 输出流、`stopProcess` 调用、`hello.processes` 能力位和 `pinomad.processes` 展示类型，只加不改（ADR-0018）；Rust 核心同步调用名、门控和文档解析。
- 已结束进程的输出缓冲留在宿主内存里，随 20 条历史淘汰、家族归档或宿主重启释放，全宿主合计设 64 MiB 上限；超出上限或宿主重启后仍看得到列表条目，但详情显示输出已不可用。
- 宿主重启会停掉后台进程（崩溃时失去跟踪），界面上要向用户说明。
