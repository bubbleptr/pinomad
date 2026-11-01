# ADR-0024：移动端改成原生，客户端协议核心用 Rust

- 状态：Accepted（WebRTC 载体和移动端 P2P 栈由 ADR-0033 补充）
- 日期：2026-10-16
- 取代 ADR-0017 §3（"移动端用 Expo……也不用 Swift 原生"）。ADR-0017 §4（`packages/protocol` 必须能在 Hermes 上运行）在 Expo 维护期内继续有效，删除 `apps/mobile` 后失效（已于 2026-10-19 失效）。
- §5 由 ADR-0027 补充：快照里的图片按内容引用传，字节按需取。

## 背景

ADR-0017 选 Expo，主要是为了让移动端直接复用 TypeScript 的 `packages/protocol`，避免协议跨语言重写。做出来之后，用户觉得 Expo 版不好看，而美观度决定他用不用这个 App；移植的工作量他不在意，由 AI 来写。

为此先做了 SwiftUI 的 agent 对话组件 AgentChatKit（流式 Markdown、逐词淡入、代码高亮、agent trace），和 Expo 版用 Release 包并排对比后，用户确认原生的好看。随后试过混合方案（Expo 外壳里只把每轮运行换成 SwiftUI，PR #104，两轮试验，不合并）：技术上可行，但要处理嵌套测高、两种语言之间的快照边界和身份映射；而用户的目标本来就是最终全部换成原生，混合只是多绕一段路。

安卓以后一定会做，也要原生。客户端要用的协议和推导一共约 5000 行：`packages/protocol` 约 2900 行（帧、Noise IK、中继、配对、`RemoteDurable`），`packages/client` 约 1900 行（`cot-view`、对话家族、模型、问题、账号等推导），外加上游 `@earendil-works/chord` 的 delta 应用约 650 行。体积不大，但还在频繁变化（项目前两周这两个包有 59 次提交，其中多少需要同步到移动端没有细算）。iOS 用 Swift、安卓用 Kotlin 各移植一份，协议状态机和推导就有三份；用 Rust 写一份给两个平台共用，这部分只有 TS 和 Rust 两份。省下的只是这部分：两个平台各自的适配层、FFI 接口和二进制构建是新增的持续成本，见"后果"。

## 决策

1. **移动端是原生 App，先做 iOS。** iOS 用 Swift + SwiftUI，放在 `apps/ios`（Xcode 工程用同步文件夹，入库）。只做 iPhone，最低 iOS 26。沿用 bundle id `build.kieran.pinomad`，在 TestFlight 上直接替换 Expo 版。安卓以后放在 `apps/android`，用 Kotlin + Jetpack Compose，共用同一个 Rust 核心。
2. **客户端协议核心用 Rust，放在 `crates/pinomad-core`**（Cargo workspace 在仓库根目录），用 UniFFI 生成 Swift 和 Kotlin 绑定。核心包含：帧编解码、Noise IK 握手（用 `snow` crate，不自己实现密码学）、安全通道的记录层（`pinomad/1` prologue、握手里的 JSON、分片；`snow` 不管这些）、中继和配对链接、`RemoteDurable` 的全部语义、chord delta 的应用、`packages/client` 里移动端用到的推导。
3. **核心不做 I/O，但 `RemoteDurable` 的语义全在核心里。** 平台层只负责兑现 I/O，不写任何协议逻辑：
   - 输入（事件）：连接已打开、收到消息、连接关闭（带关闭码）、发送失败，都带连接代际，旧代际的事件丢弃；计时器到点；App 进入前台/后台；网络变化；界面发起的调用（带操作 ID）。时间由平台给单调时钟。
   - 输出（指令）：打开或关闭连接、发送消息、设置或取消计时器、某个操作 ID 完成或失败、状态已变化。
   - 语义和 TS 现在的 `RemoteDurable` 一致：没连上时调用立即失败；断线时已发出、未回结果的调用全部失败，不自动重发；命令串行执行；重连后等新快照到了再切换；4400/4401 停止重连，1008 照常重连。
   - 核心的事件串行处理，不需要异步运行时；跨 FFI 的是同步调用，指令作为同步调用的返回值给出（`handle(event) -> [Command]`，构造后第一批走 `take()`）。所有指令都由某次 `handle`/`take` 产生，返回值省掉了跨 FFI 回调的重入和线程问题。iOS 用 `URLSessionWebSocketTask`，安卓用平台的 WebSocket，网络行为（ATS、本地网络权限、VPN、前后台）和平台一致。
4. **流的状态是完整的 JSON，字符串按 UTF-16 保存，类型只用来读。** 和 TS 的 `RemoteDurable` 一样，每个流保存宿主发来的完整 JSON 值，`ops` 帧在这份 JSON 上应用；推导用的类型从它解码出来，不认识的字段留在 JSON 里不丢（ADR-0018 §3 要求两端容忍不认识的内容，丢掉的字段之后再收到增量会找不到路径）。宿主发来的字符串可能含有孤立的代理项：设备名按 UTF-16 截到 64（`apps/host/src/devices.ts`），chord 的字符串增量也按 UTF-16 切，中间状态会出现半个 emoji。`serde_json::Value` 遇到这种字符串会直接报错，所以核心用自己的 JSON 值类型，字符串存成 UTF-16 code unit 序列，解析、应用增量、再编码都保持原样；只在交给界面时转成平台字符串，孤立代理项换成 U+FFFD。不认识的帧类型忽略，不认识的展示类型走兜底渲染（ADR-0005）。
5. **界面状态的交付契约**：推导在后台按顺序执行，结果带递增的版本号，到主线程发布；来得太密的更新合并，只发最新的一版。对话条目带稳定的 ID，供 SwiftUI 做增量更新。每次交付整份推导结果还是只交付变化的部分，由第一个任务实测后决定：在真机上用长对话（几百轮、带图片）测流式输出时的延迟、内存和帧率，先定预算再选方案。
6. **TypeScript 是协议和推导的参照，三层测试对齐两边：**
   - 独立的标准向量：Noise 用已有的 `packages/protocol/test/fixtures/noise-ik-vectors.json`（来自独立实现 Cacophony，`snow` 支持固定临时密钥，可以直接跑）。这层不由 TS 生成，防止两边一起错。
   - TS 生成的对照向量：帧编解码；记录层（`pinomad/1` prologue、握手 JSON、65518 字节正文边界、跨分片的 UTF-8、空帧、双向多条记录）；delta 序列应用前后的 JSON（含孤立代理项、UTF-16 截断、"不认识的字段之后又收到增量"）；`deriveChat` 等推导的输入输出（覆盖 `busy`、展示类型映射、重复的调用 ID、partial 转 committed、失败和中断）。向量入库，TS 测试检查它是最新的；它只能发现被用例覆盖到的改动，不能证明两边完全一致。ADR-0018 §5 的契约快照（`host-frames.json`）Rust 也拿来做解析测试。
   - 拒绝路径、时序和互操作：把 `noise.test.ts` 的篡改、重放、乱序、错误方向，以及认证失败后整个会话永久作废、每次握手用新的临时密钥，移植成 Rust 测试；`RemoteDurable` 按决策 3 的事件和指令写确定性的事件序列测试。另有一个 Rust 互操作测试，启动真实的 TS 宿主（临时数据目录）完成配对、握手并同步一个对话，和其他测试一样持续运行。

   升级 `@earendil-works/*`（ADR-0002）时重新生成对照向量，上一版的契约快照保留下来，按 ADR-0018 看差异，不直接覆盖。
7. **协议不为原生客户端改。** 原生客户端遵守 ADR-0018，作为又一个打包的客户端连接宿主；宿主和 Web 不需要知道对面是谁。Web 和桌面端继续用 TS。
8. **推送不再经 Expo，改成直连 APNs**，删除 `apps/mobile` 后不再需要 Expo 账号。APNs 密钥只放在服务端（ADR-0022），宿主经服务端发推送；宿主、服务端和协议的具体改法见 ADR-0025。验收是原生的 TestFlight 包在真机上收到推送。Expo 版至今没做移动端推送，原生版是第一个接上推送的客户端。
9. **旧配对不迁移。** 原生版不读 Expo 版存在钥匙串里的宿主，替换后重新扫码配对，旧设备在 Web 的 Devices 里吊销。只有用户自己在用 TestFlight，迁移代码不值得写。
10. **替换前提和 Expo 维护期：**
    - Expo 版只修严重问题，不加功能，但必须一直能连上宿主：替换完成前协议不涨主版本，实在要涨就同时给 Expo 版出兼容更新。
    - React Native 能连 `ws://` 靠的是 SocketRocket（`docs/mobile-release.md`），`URLSessionWebSocketTask` 不能照搬这个结论：替换前要用 Release 包在真机上验证局域网 IP、MagicDNS 主机名和中继 `wss://` 三种地址都能连上，需要的 ATS 和本地网络权限配置随之确定。
    - 替换的验收清单（Expo 版现有功能、推送、上面的连接验证、决策 5 的性能预算）放在 roadmap。原生版替换出问题时，`apps/mobile` 还在，可以重新打一个 build 号更高的 Expo 包恢复。原生版替换后日常用满一周没有阻断问题，再删除 `apps/mobile`。
11. **iOS 这边的代码组织**：`apps/ios/PinomadCore` 是一个本地 SwiftPM 包，包住 Rust 编出来的 xcframework（含真机和模拟器两个切片，构建产物不入库，由脚本从干净检出生成）、UniFFI 生成的 Swift 绑定和平台层（WebSocket、计时器、钥匙串）；`packages/agent-chat-kit` 从 `bubbleptr/AgentChatKit` 的一个固定提交用 git subtree 一次性导入，保留历史，此后只在 PiNomad 里维护，不单独发版。App 只做组装和界面。
12. **开发和验证**：
    - Rust 核心在 Linux 上就能开发和测试，`cargo test`（含互操作测试）进 `bun run test`；发版的 workflow 也要装 Rust。
    - Rust 工具链用 `rust-toolchain.toml` 锁版本，UniFFI 锁精确版本。
    - 绑定、平台层和界面只能在 macOS 上构建，在 mbp 上做，界面改动用模拟器截图确认。`PinomadCore` 包有 Swift 测试，真正调用生成的绑定，验证指令返回值、线程和类型转换，不只是编译通过。
    - 加一个 PR 触发的 GitHub Actions workflow：Linux 上跑 `cargo test`，macOS 上从干净检出编 xcframework、跑 `PinomadCore` 的 Swift 测试、给模拟器构建 App，都不需要签名凭据。改到 `packages/protocol`、`packages/client`、`crates/`、`apps/ios`、构建脚本、`Cargo.lock` 或这个 workflow 本身的 PR 都要跑它。（2026-11-01 修订：只改 `packages/protocol` 或 `packages/client` 时只跑 Linux 的 `cargo test`，对照向量测试已经覆盖到它们，Swift 只经由 Rust 核心接触这两个包；macOS 那一份只在 `crates/`、`apps/ios`、`packages/agent-chat-kit`、构建脚本、Cargo 文件或 workflow 本身变了时跑，合入 `main` 后也跑一遍。xcframework 和绑定按输入缓存：crate、工具链、构建脚本、部署目标或 runner 镜像任何一个变了就重新从头编。）
    - Kotlin 绑定的冒烟测试等安卓开工时再加，作为安卓的第一件事。

## 考虑过的方案

- **保留 Expo**：协议零移植；但界面要逐处调到接近原生，用户对比后不满意。
- **混合：Expo 外壳 + 每轮运行用 SwiftUI**：试验可行，见 PR #104；但两种语言之间要维护快照边界、身份映射和嵌套测高，而最终还是要全换，等于做两遍。
- **iOS 用 Swift、安卓用 Kotlin，各自移植协议**：没有 FFI 和 Rust 工具链，每个平台调试最直接；但协议状态机和推导有三份实现，协议还在频繁变化，每次都要改三遍、对齐三遍。
- **Kotlin Multiplatform 写共享核心**：安卓那边最顺；但 iOS 要调用 Kotlin/Native 编出来的框架，没有现成可用的 Noise 实现，要自己写密码学。
- **Rust 核心自己做 I/O（tokio + WebSocket 库）**：平台层更薄；但绕开了系统的网络栈（VPN、本地网络权限、前后台挂起都要自己处理），要在移动端跑异步运行时，时序测试也要依赖真实的计时。
- **用 `serde_json::Value` 保存流的状态**：现成、好用；但不接受孤立代理项，宿主正常发出的数据就可能解析失败，见决策 4。
- **Rust 编成 wasm，Web 和桌面端也用它**：客户端只剩一份实现；但宿主一侧（握手的响应方、帧）仍然是 TS，Web 和桌面端现在工作正常，换掉收益小。以后可以再评估。
- **SwiftUI 界面 + 在 JavaScriptCore 里跑现有的 TypeScript 协议**：不用移植；但要自己写 WebSocket、随机数、钥匙串的桥，调试跨两个运行时，协议的行为藏在一个打包好的 JS 文件里，原生侧拿不到类型。用户希望整个客户端都是原生的。
- **解码时只保留客户端用到的字段**：类型最简单，但会破坏 ADR-0018 的向前兼容，见决策 4。
- **读出 Expo 版的旧配对**：存储格式可以读（generic password，`pinomad.hosts` / `pinomad.activeHost`），但还取决于签名后的钥匙串访问组，要拿真实的 TestFlight 包做升级验证；只有一个用户，重新扫码更省事。

## 后果

- 客户端协议状态机和推导有 TS、Rust 两份实现，安卓来了也不增加。决策 6 的三层测试能抓住大部分偏移，但覆盖不到的分支仍可能悄悄不一致。
- 每次改协议或 `packages/client` 的推导，都要同时改 Rust 并重新生成向量；AGENTS.md 要写进这条。
- 新增的持续成本：每个平台一层适配（WebSocket、计时器、钥匙串，iOS 和安卓各写一遍，但不含协议逻辑）；UniFFI 接口要维护，改核心的公开接口要重新生成绑定；xcframework 和以后的安卓库要构建；出问题时可能要跨 Swift 和 Rust 两边调试；一个自己写的 UTF-16 JSON 值类型。
- 开发环境多了 Rust 工具链：omarchy 和 mbp 都要装 `rustup`，mbp 还要 iOS 的编译目标，以后加安卓 NDK 和 JDK。App 里多了一个 Rust 编出来的二进制。
- 删除 `apps/mobile` 后，`packages/protocol` 和 `packages/client` 不再需要能在 Hermes 上运行，但仍要能在浏览器（Web、桌面端）和 Node（宿主，例如推送用的 `diffRunNotices`）上运行。
- iOS 18–25 的设备不支持。
- 发布从 EAS Build 改成 `xcodebuild archive` 上传 TestFlight；`docs/mobile-release.md` 要重写。
- 换成原生后不能像 Expo 那样在 Linux 上热更新调界面，iOS 界面开发依赖 mbp 在线；Rust 核心不受影响。
- 替换时要重新配对一次。
- PR #104 关闭不合并；混合方案的 ADR 草稿作废。
- roadmap M5 第 2 项（推送）的移动端部分改由原生版来做；宿主侧已做的 Expo 发送器（`apps/host/src/push.ts`）按 ADR-0025 改。
