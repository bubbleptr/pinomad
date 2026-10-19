# iOS 发版（xcodebuild + TestFlight）

iOS 端在 mbp 本地 `xcodebuild archive` 出包、`-exportArchive` 导出上传 TestFlight，只面向内部测试。**签名必须在 mbp 本机会话里做**：SSH 会话里登录钥匙串是锁着的，codesign 会报 `errSecInternalComponent`。

## 前置条件

- Apple Developer Program 付费账号，团队 `9KZ32XLVQW`；Xcode 里登录的 Apple ID 在 App Store Connect 里有权限（App Manager 及以上），上传就用这个账号，不需要 API key。
- `apps/ios/scripts/build-core.sh` 已经跑过，xcframework 和 UniFFI 绑定在位（都不入库）。

## 发版流程

从最新的 `origin/main` 检出打包：`git rev-list --count HEAD` 只有在 main 上才单调递增，特性分支上算出来的数可能和以后 main 上的重复。

1. Archive：

   ```sh
   xcodebuild -project apps/ios/Pinomad.xcodeproj -scheme Pinomad -configuration Release \
     -destination 'generic/platform=iOS' -archivePath <dir>/Pinomad.xcarchive \
     DEVELOPMENT_TEAM=9KZ32XLVQW \
     CURRENT_PROJECT_VERSION=$(git rev-list --count HEAD) \
     -allowProvisioningUpdates archive
   ```

   archive 本身是开发签名（`aps-environment=development`、`get-task-allow=true`），这是正常的，不要在这一步检查推送环境。

2. 先导出到本地核对。ExportOptions plist 写 `method=app-store-connect`、`destination=export`、`teamID=9KZ32XLVQW`、`signingStyle=automatic`，然后：

   ```sh
   xcodebuild -exportArchive -archivePath <dir>/Pinomad.xcarchive \
     -exportOptionsPlist <ExportOptions.plist> -exportPath <dir>/export \
     -allowProvisioningUpdates
   ```

   解开 ipa（`Payload/Pinomad.app`）核对：`aps-environment=production`、`get-task-allow=false`（`codesign -d --entitlements`）、签名身份为 `Apple Distribution`（云端托管的分发证书），嵌入的 profile 为 `iOS Team Store Provisioning Profile: build.kieran.pinomad`（`security cms -D -i embedded.mobileprovision`）。

3. 上传：同一个 archive 再跑一次 `-exportArchive`，ExportOptions 的 `destination` 改成 `upload`。

xcarchive 里带 dSYM，崩溃符号化靠它；放 `/tmp` 重启会丢，要留符号就把 archive 放到固定位置。

## 版本号

- 用户可见版本是 `apps/ios/Pinomad.xcodeproj/project.pbxproj` 里的 `MARKETING_VERSION`，改版本就提交。原生版从 `0.2.0` 起，和已结束的 Expo `0.1.x` 线分开。
- 构建号不入库：archive 时命令行注入 `CURRENT_PROJECT_VERSION=$(git rev-list --count HEAD)`，main 上单调递增，不用为每次上传提交；构建号只需在同一版本号下唯一。

## 版本和发版节奏

npm 包（宿主、中继、Web）和桌面端共用版本号和 `v*` tag，一起发布（ADR-0016、ADR-0020）。移动端是另一条发布线（ADR-0017 §5），不跟着一起发：

- **版本号独立**：`MARKETING_VERSION` 自己涨，不跟 `v*` tag。移动端的界面是另一套代码，App Store 又要求版本号只增不减，绑定 tag 会让宿主的每个补丁都逼着移动端发版。
- **能不能配合看协议版本，不看 App 版本**（ADR-0018）：主版本号相同就能连；同一主版本内只新增，新增一次次版本号加一。
- **大部分改动可以错开发**：
  - 宿主新增功能：先发宿主，旧的移动端不用新功能，照常能用。
  - 移动端用宿主的新功能：按宿主的次版本号判断，不够就隐藏或提示升级宿主；先发移动端也行，连旧宿主时这个功能不出现。
  - 只改移动端界面、不碰协议：随时发。
- **主版本号升级才要一起升**：先把移动端新包提交到 TestFlight 或审核，可用以后再打 `v*` tag 发宿主和桌面端；窗口期里旧的移动端会提示更新 App。
- 功能对应的次版本号集中记在 `packages/protocol/src/frames.ts` 的 `FEATURE_SINCE` 表里，各端都按它判断，不在各处散落数字比较。

## TestFlight 测试员

内部测试只对 App Store Connect 团队用户开放。iPhone 上 TestFlight 用的是 App Store 登录的 Apple ID；该 Apple ID 不在团队里会显示「此 App 不可用于你的账户」。要在 App Store Connect → 用户和访问 里邀请它，并加进这个 App 的内部测试组（内部测试无需 Beta 审核）。

## 出口合规

PiNomad 的 secure channel 是 Noise IK 协议，用的都是标准算法：X25519、ChaCha20-Poly1305、BLAKE2s，原生版实现是 Rust 的 `snow` crate（`crates/pinomad-core`），用途是保护和宿主之间的通信。维护者的回答是不使用需要申报的加密，`apps/ios/Pinomad/Info.plist` 里设了 `ITSAppUsesNonExemptEncryption=false`，App Store Connect 不再逐个构建询问。以后如果加了别的加密用途，要重新评估这个声明。

## ATS 与 `ws://` 主机名

App 用 `URLSessionWebSocketTask` 连宿主，受 ATS 约束，所以 `Info.plist` 保留 `NSAllowsArbitraryLoads=true`（2026-10-19 决定）。收窄到 `NSAllowsLocalNetworking` 只放行 IP、短名和 `.local`，会挡掉用户自己的域名，比如 `ws://nas.home.arpa`、动态 DNS，以及 `http://` 的 `publicUrl`。和宿主的连接有 Noise IK 端到端加密，账号请求在代码里由 `isSecureServerOrigin` 强制 https，ATS 在这一层没有额外的安全收益。

代价是上架 App Store 时要在审核说明里交代这项豁免：明文 WebSocket 只用于连用户自建的宿主，内容由 Noise 端到端加密；账号请求走 https。

## 已知限制

- 二维码配对只能真机验证，模拟器没相机。
