# ADR-0033：WebRTC P2P 与信令连接——选型、载体契约与简化切换

- 状态：Accepted
- 日期：2026-10-26
- 补充 ADR-0032 §3–6（P2P 并行准备、模式过滤、切换、P2P 错误作用域）、ADR-0024 §3 / §11（新载体、平台职责、有界切换排队）、ADR-0016（原生依赖的可选包分发）和 ADR-0008（载体与信令连接）；ADR-0022、ADR-0015 不变。

## 背景

ADR-0032 给了远程访问多候选：本机 loopback、relay、direct WebSocket，串行尝试，任意时刻只有一条活动业务连接。它明确把“长期 WebRTC 的并行建连”留给 #345。Web 客户端是长期入口，而浏览器只开放 WebRTC 这一种 P2P 能力；没有 P2P 时，所有远程流量都经过服务端，延迟和带宽都由中继决定，服务端也永远看得到连接的元数据。

约束：

- Noise 记录层（TS 的 `secure-channel.ts`、Rust 的 `secure_channel.rs`）要求载体有序、可靠、按消息；nonce 递增，乱序、丢失或重复会永久毒化接收方向。载体不能悄悄重发或重排记录。
- 设备准入、吊销和配对已经由 Noise IK 关口和设备表保证；P2P 不能另起一套身份或授权。
- 浏览器、Node 宿主和以后的 iOS 必须共用同一套线上语义，但各自的 WebRTC 库对“发送是否已被接收”的返回值定义不同。
- 服务端（`apps/server`）不参与信令，也不保存 SDP；否则每次连接都要多一个可信组件和一套状态。
- 没有 TURN；P2P 失败必须能识别、释放资源并落回 relay，而不是伪装成设备未授权。

## 决策

1. **WebRTC DataChannel 作为第四种载体，宿主作答、客户端 offer，不引入 TURN。** 业务帧仍然先经过 Noise IK 和安全记录层，再放进 DataChannel；宿主把 DC 当成和 WebSocket 一样的载体交给同一个 IK 关口。SDP 被篡改只会导致连不上或 Noise 失败，冒充不了宿主。选 WebRTC 是因为浏览器原生支持且不需要第二套中继；iroh 的 QUIC 多路径在原生端更优雅，但浏览器没有直连能力，还要再跑一套中继，不取。TURN 明确不在本阶段。

2. **信令走安全通道，信令连接有独立 prologue，不新增服务端信令接口。** `hello.rtc?: { stun, signalOnly: true }` 声明宿主能力；`rtcOffer { attempt, sdp } -> { sdp }` 在活动业务连接或信令连接上发起，不走串行命令队列。信令连接使用 `pinomad-signal/1`，业务连接仍是 `pinomad/1`。新宿主先按业务 prologue 解 msg1，失败再用同一条 msg1 和新的 responder 按信令 prologue 解；用途由握手决定，之后不可变。这样旧宿主会在注册任何连接之前认证失败并关闭，完整 hello 不会经过 relay；信令连接只拿到最小 hello（`protocol` + `rtc`），只接受 `rtcOffer` 和 `ping`，从不创建业务 `GatewayClient`、不订阅、不进入广播集合。设备准入与业务连接一致：只接受已登记、未吊销的设备，信令连接不接受配对。

3. **载体契约按各库的真实语义定义，不假装返回值都一样。** 每连接一个 FIFO 发送器，一个业务帧 seal 出的多条记录连续入队，不得与其他帧交错。node-datachannel 的 `sendMessageBinary` 返回 false 表示**已入队**，照样算发出，绝不重发；str0m 的 `Channel::write` 返回 false 表示**未接收**，稍后用同一份密文重试，不得重新 seal；浏览器 `send()` 总是入队。背压以 `bufferedAmount` 高水位 256 KiB、低水位 64 KiB 驱动；不因队列总量关闭载体，只有持续 10s 没有任何泵送进展才关闭。DataChannel 必须 reliable + ordered。单条记录最多 65535 字节；建立时检查对端 SDP 的 `max-message-size`：缺失按 65536，0 表示不限，其它值必须 ≥ 65535，否则该载体失败。

4. **宿主 Peer 有明确的生命周期和配额。** 每个 Peer 带客户端生成的 `attempt` id；同一设备同一 attempt 重复请求返回同一个 Peer 的答案。每设备同时最多 2 个、全宿主最多 8 个 Peer；未完成 Noise 的 Peer 20s 超时。宿主收集本地候选 2s，到期提交已有候选，丢弃 relay 类型，零候选失败；SDP 里的候选去重后再回给客户端（非 trickle）。DataChannel 打开后交给同一个 IK 关口，Noise 完成后 Peer 归属转给该 DC 安全连接，信令连接关闭只清理尚未完成的 Peer。吊销设备时关闭它的信令连接和未完成 Peer；已完成 Peer 的 DC 是业务连接，由同一轮吊销关闭。DC/ICE 关闭对客户端是候选级失败（类 1006），不是 unauthorized；宿主端不因此修改任何设备或配对记录。

5. **切换是简化的：新载体认证通过才关闭旧载体，不承诺同步失败可无损退回旧连接。** 准备期允许两条物理连接，任意时刻只有一条逻辑活动业务连接；后台 P2P 不订阅、不发业务命令。升级依次经过 signal → ice → noise → warm，warm 以收到 hello 和一次 DC 上的 ping/pong 为准，整体 25s。提交前在同一段同步代码里复查无在途操作、关闭旧连接的新调用入口，再在 DC 上 ping 一次（3s）；失败则解除屏障，交接队列按序发回旧连接。交接时先退休旧代际再关闭旧载体；交接队列绑定新代际，授权后进入密文 FIFO，进入后结果未知、不再承诺取消。同步屏障除宿主流外还要等当前/侧栏对话及文档流的首份快照；某流收到 `ended` 算满足。同步失败时未发出的交接项立即失败并永久移除，不带入普通重连，随后走普通重连轮。已发出未回的调用按 ADR-0032 以 `Disconnected` 拒绝，不重放。存活用应用层 `ping`/`pong`：pong 回带探测 id 并绑定连接代际，假在线预算 15s，P2P 活动时按固定 5s 节奏探测；模式为 Auto / Direct only / Relay only，默认 Auto，冷却 30s 起翻倍、上限 10min。冷启动 P2P 仍依赖至少一条可达的信令路径；P2P 不是服务端故障时的独立恢复路径。

6. **移动端用 str0m，不用 Google WebRTC。** iOS（以后安卓）用 str0m 0.24.1 + str0m-rust-crypto 0.6.0，sans-I/O，不依赖 OpenSSL；UDP、网卡枚举、计时器由 Swift 平台层负责，STUN binding 收集在 Rust，经 UniFFI 暴露。PR0b 的模拟器 IPv4 / IPv6 / 后台切换 13/13 轮无重复；早先的“重复交付”是 Node 对端把已入队当拒收后重发造成的，已更正。不需要 Bonjour / multicast entitlement。

7. **宿主原生依赖延迟加载、平台包可选。** `node-datachannel` 锁 `0.33.4`（libdatachannel 0.24.5，MPL-2.0），列在 `apps/host` 的 dependencies；平台包由它的 optionalDependencies 按 os/cpu 带入。加载失败时宿主不声明 `hello.rtc`，记一条指名缺少的 `@node-datachannel/<platform>` 诊断，`host` / `server` / `--version` 照常工作。`apps/cli/build.ts` 合并 `optionalDependencies` 到 external 和发布清单，省略可选包时主模块仍在。

8. **STUN 列表放在宿主设置里。** `settings.json` 的 `rtcStun`（字符串数组）默认 `["stun:stun.cloudflare.com:3478"]`，经 `hello.rtc.stun` 下发，宿主 answerer 也用它；空数组表示只用 host 候选。这个 PR 不做客户端设置界面，客户端支持在后续版本推出。

## 考虑过的方案

- **iroh（QUIC 多路径，中继即路径）**：原生端优雅、天然多路径；但浏览器没有直连能力，要额外跑一套 iroh 中继，且现有服务端和信令都要再改一遍。Web 是长期入口，选浏览器能用的 WebRTC。
- **服务端信令接口（WebSocket / HTTP 交换 SDP）**：可以把信号和业务完全分开，但服务端要多存连接状态、多一个可信组件，还要定义鉴权；宿主已经有认证过的安全通道，信令放在里面不需要新信任边界。独立 prologue 让旧宿主在注册前失败，已经解决了“旧宿主误注册业务连接”的问题。
- **复用业务连接做信令、不引入信令 prologue**：Direct only 在业务连接建立前没有可用通道；旧宿主会先注册一条业务连接再发现不支持 RTC，完整 hello 还会经过 relay。独立 prologue 的代价只是多一条握手路径。
- **保留旧业务连接做无损回退（双业务状态）**：同步失败时旧连接上的订阅、图片引用和未完成操作都还在，看似平滑；但要让两套连接同时保持业务状态，切换语义、图片引用和“当前连接”都要复制一份，ADR-0032 已经把“新连接同步失败可无损退回”列为非目标。失败就走普通重连。
- **trickle ICE / 无限等待候选**：2s 收集和 10s ICE 预算里，Linux 的 `.local` 解析可能吃掉 5s；trickle 让信令连接必须在整个 ICE 期间保持、并且要处理晚到候选和重传。非 trickle 的 2s 提交在 PR0 实测里够用，晚到候选直接丢弃并记诊断。
- **把所有库的 `false` 统一映射成“未接收、稍后重试”**：node-datachannel 的 false 是已入队，重试会插入重复记录，Noise 立即 invalid tag；PR0 已实测。契约宁可分成三态，也不在业务层重发。
- **按队列总量关闭载体**：大帧（8 MiB）本来就会超过高水位，队列总量不能说明故障；只有持续没有泵送进展才是停滞。
- **TURN**：能提高跨 NAT 成功率，但引入第三方带宽和凭据管理；本阶段先用 relay 业务连接兜底，P2P 失败不算 unauthorized。
- **把 SDP 放进 ClientHello 字段**：握手载荷很小，塞 SDP 会把握手和候选收集耦合；最终仍要一条可重试的调用。`rtcOffer` 是普通调用，失败可以重试。

## 后果

- 协议升 minor（5.23）：新增 `hello.rtc`、`rtcOffer`、`ping` 和 `SIGNAL_PROLOGUE`；业务 hello 的 `session` / `models` / `docs` / `toolPresentations` 在信令 hello 里缺席，客户端必须先知道通道用途再读这些字段。旧宿主不认识 `rtcOffer`，按 ADR-0018 回 unsupported；旧客户端忽略 `hello.rtc`。
- 宿主多一个原生依赖和一条延迟加载路径；`--omit=optional` 安装仍能启动，只是没有 P2P。平台包体积约 9 MB（linux-x64），npm tgz 约 3.4 MB。
- P2P 不是服务端故障时的独立恢复路径：冷启动仍要先有一条 relay 或 direct WebSocket 信令路径。Direct only 的承诺是业务数据不经过 PiNomad 服务端；外部 tailnet 是否自行中继（DERP）不在承诺内。
- 客户端协调器（候补、屏障、存活发起方、冷却、模式）在后续 PR；本 PR 只定义协议、宿主应答端、信令连接和 ADR。Web/桌面与 iOS 的 RTC 载体也在后续 PR。
- 没有 TURN 时，不同 NAT 后的连通性仍可能失败；Auto 会落回 relay，Direct only 报告“直连不可用”。`.local` 解析慢、解析到 VPN 地址都只进诊断，不据此关闭 `hello.rtc`。
- 并发与计时需要可注入的时钟/期限；宿主 Peer 的配额和超时用确定性测试覆盖，真实 ICE/Noise 路径在普通 Node 进程里做集成测试（vitest 的 worker 池收不到 node-datachannel 的原生线程回调）。
