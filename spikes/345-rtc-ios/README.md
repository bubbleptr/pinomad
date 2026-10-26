# #345 PR0b — iOS P2P 栈可行性 spike

这是 #345 的 0b 可行性实验，不是产品实现：**不开 PR、不合入、不作为后续产品 PR 的底座**。
目标是回答 iOS 的 WebRTC 栈选型：候选 str0m，备选 Google WebRTC xcframework。

## 结论摘要

- `str0m 0.24.1` + `str0m-rust-crypto 0.6.0` 在 iOS 26.5 模拟器和 iPhone 17 Pro（iOS 27.0）真机都能编译；
  `Swift UDP -> Rust STUN/str0m (UniFFI) -> node-datachannel(0.33.4)/libdatachannel` 能建立 DataChannel。
- 正常路径下 4 MiB 真实 Noise 业务帧被 seal 成 65 条记录，逐字节校验通过；`Channel::write` 在背压下返回 false
  1737 次，记录仍全部发完，没有重新 seal。同一 Wi-Fi 选中的是 host-host；IPv4 和 IPv6 都通。
- **阻断性问题**：可靠有序的 DataChannel 上观察到了**重复交付**。后台恢复时记录密文连续重复，
  正常 IPv6 真机也复现过一次（记录 #38 与 #37 首 8 字节完全相同），Noise 接收方向因此永久毒化。
- 一个相邻密文去重保护能把这次后台传输跑完，但它抑制了 **291 次**重复记录；这说明不是偶发单包，
  而是挂起/恢复后的 SCTP 重传风暴。去重只能作为实验保护，不能当作产品保证。
- `node-datachannel` 作为 answerer 时不能无节制地连续 `sendMessageBinary`：一次灌 4 MiB 会在约 18 条记录后
  损坏/丢失消息。Node 侧以 20 ms/条节奏发送后通过；这是宿主侧适配项。
- iOS 不需要 `NSBonjourServices`，也不需要 multicast entitlement：实验只发单播 UDP + HTTP，没有 mDNS / multicast。
  `NSLocalNetworkUsageDescription` 已在 Info.plist 中。iOS 27 首次联网还会弹“使用无线数据”的权限。
- **建议：暂不锁定 str0m，转去验证 Google WebRTC xcframework**。基础链路和 sans-I/O 形状都成立，但
  “可靠通道重复交付”直接违反 Noise 记录层的载体契约，且尚未定位到是 str0m/sctp-proto 还是本驱动；
  在这个问题有上游修复或可证明的去重/断线策略之前，不应把它作为 PR4 的产品栈。详细判断见 #345 的 PR0b 评论。

## 组成

```
SwiftUI App (iOS)                          Node answerer (macOS)
  UDPSocket (BSD, DispatchSourceRead)       node-datachannel 0.33.4
        |                                          |
        v                                          v
  SpikeController (serial queue)  HTTP POST /offer  peer.mjs
        |  UniFFI                                  |  length-prefixed stdio
        v                                          v
  rtc-core (Rust, sans-I/O)                 rtc-noise-peer (Rust, real
    STUN client + str0m 0.24.1              pinomad-core Noise responder)
    Noise (pinomad-core)
```

- `rtc-core/`：独立的 Cargo workspace，不加入根 workspace；`str0m`、STUN、Noise 和 4 MiB 帧逻辑都在这里。
  `engine.rs` 没有任何 socket/线程/计时器；所有输入是同步方法，所有输出是 `Vec<SpikeAction>`。
- `ios/`：最小 SwiftUI 测试 App，bundle id `build.kieran.pinomad.rtcspike`。UDP 用 BSD socket，
  因为 `NWConnection` 是面向单个 peer 的连接，无法用一个本地端口接收来自多个 ICE 候选的 STUN/DTLS/SCTP。
- `node/peer.mjs`：只做一次性 HTTP 信令 + libdatachannel answerer；Noise 不在这里重写，
  而是通过长度前缀管道交给 `rtc-noise-peer`，确保 DataChannel 里跑的是 `pinomad-core` 的真实记录。
- `rtc-core/src/bin/rtc-probe.rs`：在 Mac 上用同一 `Engine` + BSD socket 的主机侧联调工具。
- `node/bulk-probe.mjs`：Node-to-Node 的 65×65,535 字节对照；IPv4/IPv6 均无重复，用来把问题收敛到 str0m 接收侧。

## 锁定的版本

| 组件 | 版本 | 发布 |
| --- | --- | --- |
| Rust | 1.99.0 | `rust-toolchain.toml` |
| str0m | 0.24.1 | 2026-10-03 |
| str0m-rust-crypto | 0.6.0 | 2026-08-08 |
| dimpl（传递依赖） | 0.7.6 | 2026-10-16 |
| UniFFI | 0.32.2 | 2026-09-23 |
| node-datachannel | 0.33.4 | 2026-09-12 |

`rtc-core/Cargo.lock` 和 `node/package-lock.json` 都入库。DTLS/SRTP provider 显式选择
`str0m_rust_crypto::default_provider()`，不启用 OpenSSL。注意：`dimpl` 的 `rcgen` 证书生成路径仍会拉入
`aws-lc-rs`，因此静态库不是纯 RustCrypto；DTLS/SRTP 的实际 provider 仍是 `str0m-rust-crypto`。

## 复现

前置：macOS + Xcode 27、Rust 1.99、Node 25、`xcodegen`、`curl`。

### 1. 构建 Rust 静态库和 Swift 绑定

```sh
cd spikes/345-rtc-ios
./ios/scripts/build-core.sh
```

产物：`ios/Vendor/RTCSpikeCore.xcframework`、`ios/RTCSpike/Generated/rtc_spike_core.swift`（都不入库）。

### 2. 构建并启动 Node answerer

```sh
cd spikes/345-rtc-ios/node
npm ci
cd ..
cargo build -p rtc-spike-core --bin rtc-noise-peer
cd node
RTC_SPIKE_BIND=0.0.0.0 RTC_SPIKE_PORT=8765 RTC_SPIKE_SEED=7 node peer.mjs
```

`RTC_SPIKE_BIND=::` + `RTC_SPIKE_PORT=8766` 可跑 IPv6 版本。Node 侧固定 20 ms/条节流，原因见上。

### 3. 模拟器

```sh
cd spikes/345-rtc-ios/ios
MBP_LAN_IP=192.0.2.225  # 换成 mbp 的局域网地址
xcodegen generate
xcodebuild -project RTCSpike.xcodeproj -scheme RTCSpike -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/rtcspike-sim-dd CODE_SIGNING_ALLOWED=NO build
xcrun simctl install 'iPhone 17 Pro' /tmp/rtcspike-sim-dd/Build/Products/Debug-iphonesimulator/RTCSpike.app
SIMCTL_CHILD_RTCSPIKE_SERVER="http://$MBP_LAN_IP:8765" \
  SIMCTL_CHILD_RTCSPIKE_STUN='stun.cloudflare.com:3478' \
  SIMCTL_CHILD_RTCSPIKE_HOLD_MS=5000 \
  xcrun simctl launch 'iPhone 17 Pro' build.kieran.pinomad.rtcspike
```

### 4. 真机

```sh
cd spikes/345-rtc-ios/ios
xcodebuild -project RTCSpike.xcodeproj -scheme RTCSpike -configuration Debug \
  -destination 'id=00008150-001608822678401C' -derivedDataPath /tmp/rtcspike-device-dd \
  DEVELOPMENT_TEAM=9KZ32XLVQW -allowProvisioningUpdates build
xcrun devicectl device install app --device 00008150-001608822678401C \
  /tmp/rtcspike-device-dd/Build/Products/Debug-iphoneos/RTCSpike.app
DEVICECTL_CHILD_RTCSPIKE_SERVER="http://$MBP_LAN_IP:8765" \
  DEVICECTL_CHILD_RTCSPIKE_STUN='stun.cloudflare.com:3478' \
  xcrun devicectl device process launch --device 00008150-001608822678401C \
  build.kieran.pinomad.rtcspike
```

真机首次启动需在手机上允许“无线数据”；之后 `devicectl copy from` 取证据：

```sh
xcrun devicectl device copy from --device 00008150-001608822678401C \
  --source Documents/rtcspike.log --domain-type appDataContainer \
  --domain-identifier build.kieran.pinomad.rtcspike --destination /tmp/rtcspike.log
```

### 5. 主机侧同一 `Engine` 的探针

```sh
cd spikes/345-rtc-ios
cargo build -p rtc-spike-core --bin rtc-probe
./target/debug/rtc-probe --server http://127.0.0.1:8765 \
  --bind "$MBP_LAN_IP" --stun 162.159.207.0:3478 --seed 7
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RTCSPIKE_SERVER` | `http://127.0.0.1:8765` | 一次性 HTTP 信令地址，真机必须改成 Mac 的局域网地址 |
| `RTCSPIKE_STUN` | `stun.cloudflare.com:3478` | 显示用；实际解析由 Swift 的 `getaddrinfo` 完成 |
| `RTCSPIKE_STUN_ADDR` | 空 | 覆盖解析结果，用于本机 DNS 被重写时 |
| `RTCSPIKE_FAMILY` | `auto` | `ipv4` / `ipv6` / `auto` |
| `RTCSPIKE_BIND` | 自动选 en0 | 强制本地 IP |
| `RTCSPIKE_HOLD_MS` | `5000` | 完成后保持连接的毫秒数，便于观察释放 |
| `RTCSPIKE_DEDUPE` | `1` | 设为 `0` 关闭相邻重复密文抑制，用于复现原始失败 |

本机 DNS 会把 `stun.cloudflare.com` 解析到 `198.18.0.0/15`，那里没有 STUN 服务。
`Resolver.swift` 检测到该网段后回退到 Cloudflare 发布的 `162.159.207.0` / `2606:4700:49::`；
这是实验环境的绕行，不是产品应保留的硬编码。

## 证据

`evidence/` 里是实际运行日志（时间戳为 Unix 秒）：

- `simulator-ipv4.log`：iOS 26.5 模拟器，4 MiB / 65 记录，matched=true，host-host；`RTCSPIKE_DEDUPE=1` 下 0 次重复。
- `device-ipv4.log`：iPhone 17 Pro / iOS 27.0，srflx 已收集，选中 host-host，matched=true。
- `simulator-ipv6.log`：模拟器 IPv6；STUN v6 因 Mac 路由不可达，host-host 仍通。
- `device-ipv6-success.log`：真机原生 IPv6 成功路径；映射地址等于 host，最终 host-host。
- `device-ipv6-raw-duplicate.log`：真机原生 IPv6 的原始失败：记录 #37/#38 重复，Noise 毒化，失败识别并释放。**没有开后台**。
- `simulator-background-mid-transfer.log`：`RTCSPIKE_DEDUPE=0`，传输中后台挂起，记录 #37/#38 重复，Noise 毒化，失败识别并释放。
- `simulator-background-mid-transfer-deduped.log`：同一场景打开去重，完成 65 条，但抑制了 291 条重复记录。
- `device-background-after-complete.log`：大帧收尾阶段进后台再回前台，连接未再报错。
- `node-unthrottled-burst.log`：Node 不限速时只发出 16 条 log 后停止，对应 iOS 第 18 条记录解密失败。
- `node-throttled-background.log`：20 ms 节流后同一路径可完成。
- `host-probe-ipv4.log`：Mac 上用同一个 `Engine` + BSD socket 的联调，4 MiB / 65 记录，matched=true，deduped=0。
- 对照：`node/bulk-probe.mjs` 在 IPv4 / IPv6 各跑 65 × 65,535 字节，接收端 0 重复；说明 libdatachannel 自身的收发不是重复来源。

## 体积

- `libpinomad_core.a`（产品核心，iOS device release）：24 MiB；`strip -S -x` 后 7.6 MiB。
- `librtc_spike_core.a`（同一产品核心 + str0m + STUN + 测试引擎）：40 MiB；strip 后 21.9 MiB。
- 未 strip 的归档差约 16 MiB，strip 后约 14.3 MiB（含 aws-lc-rs/证书生成等传递依赖；链接后会被 dead-strip）。
- SDP 实际协商 `a=max-message-size:262144`，65,535 字节记录有足够余量。
- Release 模拟器 App（含全部资源）：7.0 MiB。真机 Release 未单独打包；Debug 包包含 `RTCSpike.debug.dylib`。

## 未覆盖 / 需要用户手动补测

- **Wi-Fi → 蜂窝路径切换**：需要关闭/打开手机 Wi-Fi，不能在本次任务里改用户设置。手动步骤：
  保持 App 前台并完成一次 4 MiB 传输 → 关闭 Wi-Fi → 等 10 s → 观察日志中 `sendto` 错误或 ICE/DTLS 失败；
  App 会在 10 s channel 期限或 30 s bulk 期限失败并释放。
- **IPv6-only / NAT64**：本次只验证了原生 IPv6。NAT64 需要 macOS Internet Sharing 的 NAT64 模式或
  运营商 IPv6-only Wi-Fi；没有在用户的日常手机上改网络设置。替代办法：在 mbp 上开 Internet Sharing
  （NAT64），iPhone 连该网络，再用 `RTCSPIKE_FAMILY=ipv6` 重跑；重点看 STUN 能否拿到 v6 映射、
  host 候选是否仍可用、失败是否在 10 s 内被识别。
- **TURN / relay 候选**：明确不在本次范围。
- **prflx**：本次 LAN 路径没有观察到；需要不同 NAT 或对称 NAT 条件。

## 设计影响

1. `str0m` 的 sans-I/O 形状和 ADR-0024 的平台层契约吻合；Swift 只需一个串行队列、一个 UDP fd、一个 timer。
2. 产品化必须补：`Channel::write` 低水位泵送的实测参数（本次 128 KiB 低水位 + 512 KiB SCTP buffer 可用，
   但 false 次数偏高）；`max-message-size` 检查；Node 宿主的发送节流。
3. **重复交付是当前 Go/No-Go 的核心**：正常 IPv6 真机也出现过一次重复，后台挂起后是重传风暴。
   相邻密文去重能跑完，但不能证明一般情况；应把挂起/网络切换当成连接代际结束，重新走 ICE/Noise，
   且把“载体 exactly-once”列为上游必须修复项。
4. 如果 PR4 前不能定位/修复重复来源，按备选方案验证 Google WebRTC xcframework 的 DataChannel + 4 MiB 大帧，
   再决定产品栈；在当前证据下建议**不要锁定 str0m**。
5. 不需要 Bonjour 或 multicast entitlement；但 iOS 27 的“无线数据”权限是首次启动的硬前置。
