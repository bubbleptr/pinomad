# #345 PR0b — iOS P2P 栈可行性 spike

这是 #345 的 0b 可行性实验，不是产品实现：**不开 PR、不合入、不作为后续产品 PR 的底座**。
目标是回答 iOS 的 WebRTC 栈选型：候选 str0m，备选 Google WebRTC xcframework。

## 更正（2026-10-26，重要）

第一版 PR0b 评论把“DataChannel 重复交付”归因给 str0m，这是错的。核对 PR0a 和
`node-datachannel` 0.33.4 的语义后确认：`sendMessageBinary` 返回 false 表示**消息已经入队**，
只是没有立即写出。第一版 `peer.mjs` 在 false 时没有消费队列，下一轮又发同一份密文，
于是制造了相邻重复记录（Noise 因此报 decrypt error）。错误在 Node 对端，不在 str0m。

修正后只用模拟器和本机重跑：IPv4 5 次、IPv6 5 次、传输中进后台再回前台 3 次，共 13 次全部完成，
0 次重复、0 次解密失败；Node 每次 `writeFalse` 7–12 次，全部按 bufferedAmount 背压正常排空。
因此**撤回“转验证 Google WebRTC”的建议，str0m 可以锁定**。

## 结论摘要

- `str0m 0.24.1` + `str0m-rust-crypto 0.6.0` 在 iOS 26.5 模拟器编译、建连、跑完 4 MiB 真实 Noise 记录；
  首轮真机链路也建立成功，但按本轮要求**没有重跑真机**。
- 4 MiB 真实 Noise 业务帧 -> 65 条记录，逐字节校验 `matched=true`；iOS `Channel::write` 返回 false
  约 1,737 次，仍按低水位逐批发完，没有重新 seal。
- 模拟器 IPv4 / IPv6 各 5 次，全部 host-host；3 次传输中后台恢复也全部完成，没有重复记录。
- Node 侧 `writeFalse` 7–12 次/次，最大 buffered amount 327,675 字节，最大队列 44 条；说明背压确实触发。
- `node-datachannel` 的 false 必须当成“已入队”，**消费当前记录并前进**，不能重试；
  发送节奏由 `bufferedAmount()` 高水位（256 KiB）+ `onBufferedAmountLow`（64 KiB）控制。
- iOS 侧 str0m `Channel::write` 的 false 是真正没接收，继续用同一份密文重试是对的，不需要改。
- iOS 不需要 `NSBonjourServices`，也不需要 multicast entitlement；`NSLocalNetworkUsageDescription` 已在 Info.plist。
- **建议：锁定 str0m；不需要转 Google WebRTC**。重复问题已归因并修正，PR4 的主要剩余工作是平台层和生命周期，不是协议正确性。

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
- `node/bulk-probe.mjs`：Node-to-Node 的 65×65,535 字节对照；IPv4/IPv6 均无重复，证明 libdatachannel 自身收发正常。

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

`RTC_SPIKE_BIND=::` + `RTC_SPIKE_PORT=8766` 可跑 IPv6 版本。Node 侧不按时间节流：`bufferedAmount()` 达到 256 KiB 时暂停，`onBufferedAmountLow`（64 KiB）唤醒；`sendMessageBinary` 返回 false 时该记录已经入队，必须前进而不是重试。

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

本机 DNS 会把 `stun.cloudflare.com` 解析到 `198.18.0.0/15`，那里没有 STUN 服务。
`Resolver.swift` 检测到该网段后回退到 Cloudflare 发布的 `162.159.207.0` / `2606:4700:49::`；
这是实验环境的绕行，不是产品应保留的硬编码。

## 证据

按本轮要求只跑模拟器和本机；**没有重跑真机**。`evidence/` 里是 13 次运行：

- `summary.csv`：每轮的 result / duplicate / Node sent / writeFalse / maxBuffered / maxQueue。
- `ipv4-1..5.app.log` / `.node.log`：模拟器 IPv4，5 次全部 COMPLETE，65 条，matched=true，host-host。
- `ipv6-1..5.app.log` / `.node.log`：模拟器 IPv6，5 次全部 COMPLETE，65 条，matched=true，host-host。
- `background-1..3.app.log` / `.node.log`：传输中（Node 回显阶段）进后台再回前台，3 次全部 COMPLETE，无重复/解密失败。
- `host-probe-ipv4.log`：Mac 上用同一个 `Engine` + BSD socket 再跑一次 4 MiB，65 条 matched=true，iOS 侧 false=1,744。
- Node 每轮 `writeFalse` 7–12 次，`maxBuffered=327,675`，`maxQueue` 42–44；这是真实触发背压的证据。
- 对照：`node/bulk-probe.mjs` 在 IPv4 / IPv6 各跑 65 × 65,535 字节，接收端 0 重复；libdatachannel 自身收发正常。
- 旧的第一版证据已从当前树删除；`evidence/README.md` 说明了错误归因和修正。

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
2. **Node 宿主的载体适配器语义是 PR1 的必改项**：`sendMessageBinary` 的 false 是“已入队”，必须消费并前进；
   用 `bufferedAmount()` 高水位 + `onBufferedAmountLow` 控制，不能按时间节流，也不能重试同一记录。
3. **iOS 侧不要改**：str0m `Channel::write` 的 false 是“未接收”，同一份密文重试是正确的；本次 13/13 证明
   iOS 发送路径和 Noise 记录层在背压下保持一致。iOS `write_false` 约 1,737 次，属于正常低水位行为。
4. 后台/恢复 3/3 完成且无重复；产品仍按现有协调器代际规则处理更长的挂起和网络切换，但不再需要
   把“可靠通道重复交付”当成 str0m 的阻断项，也不需要密文去重。
5. 建议锁定 str0m；不需要转 Google WebRTC。PR4 约 3–4 周，主要工作量在 Swift 平台层、生命周期、
   设置界面和网络切换测试，而不是协议正确性。
6. 不需要 Bonjour 或 multicast entitlement；但 iOS 27 的“无线数据”权限是首次启动的硬前置。
