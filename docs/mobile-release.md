# 移动端发版（EAS + TestFlight）

iOS 端走 EAS 云端构建 + 本地提交，只面向 TestFlight 内部测试。一切 eas 命令在 `apps/mobile` 下用 `bunx --bun eas-cli …` 运行；`eas.json` 已配好 `base`（`bun: 1.3.12`）、`simulator`（云端模拟器包）、`production`（`autoIncrement` 远端自增构建号）。

## 前置条件

- Apple Developer Program 付费账号，账号加入的开发团队有分发权限。
- Expo 账号 `kieranx`：`bunx --bun eas-cli login`（首次可用 `--device` 设备码流程）。`app.json` 已带 `owner: "kieranx"` 和 `extra.eas.projectId`，不用再跑 `eas init`。
- 该 Apple ID 在 App Store Connect 里有权限（App Manager 及以上）。

## 第一次发布

```sh
cd apps/mobile
bunx --bun eas-cli build -p ios --profile production
```

首次会问 Apple ID 登录 + 双因子验证码，然后由 EAS 托管创建分发证书和 provisioning profile（`credentialsSource: remote`）。

```sh
bunx --bun eas-cli submit -p ios --latest
```

`submit` 会确保 App Store Connect 上的 App 记录存在：不存在则按 bundle id（`build.kieran.pinomad`，和维护者其他 Expo 项目同一前缀）创建，并交互询问 app 名称、公司名（首次必填）和 SKU；要跳过这一步可以在 `submit.production` 里配 `ascAppId`。`--auto-testflight-setup` 会自动建好一个内部 TestFlight 测试组并放行该构建。

构建出现在 TestFlight 后，在 App Store Connect → TestFlight → 内部测试里把测试员加入 App Store Connect Users 组即可（内部测试无需 Beta 审核）。

## 以后发版

- 用户可见版本号改 `app.json` 里的 `expo.version`。
- 构建号由远端自增（`appVersionSource: "remote"` + `autoIncrement: true`），不用手动改。
- 重复 `build` + `submit` 两步即可。

## 版本和发版节奏

npm 包（宿主、中继、Web）和桌面端共用版本号和 `v*` tag，一起发布（ADR-0016、ADR-0020）。移动端是另一条发布线（ADR-0017），不跟着一起发：

- **版本号独立**：`expo.version` 从 0.1.0 起自己涨，不跟 `v*` tag。移动端的界面是另一套代码，App Store 又要求版本号只增不减，绑定 tag 会让宿主的每个补丁都逼着移动端发版。
- **能不能配合看协议版本，不看 App 版本**（ADR-0018）：主版本号相同就能连；同一主版本内只新增，新增一次次版本号加一。
- **大部分改动可以错开发**：
  - 宿主新增功能：先发宿主，旧的移动端不用新功能，照常能用。
  - 移动端用宿主的新功能：按宿主的次版本号判断，不够就隐藏或提示升级宿主；先发移动端也行，连旧宿主时这个功能不出现。
  - 只改移动端界面、不碰协议：随时发。
- **主版本号升级才要一起升**：先把移动端新包提交到 TestFlight 或审核，可用以后再打 `v*` tag 发宿主和桌面端；窗口期里旧的移动端会提示更新 App。
- 功能对应的次版本号集中记在 `packages/protocol` 的 `since` 表里（第一次涨次版本号时建），各端都按它判断，不在各处散落数字比较。

## 出口合规

PiNomad 的 secure channel 是 Noise IK 协议，用的都是标准算法：X25519、ChaCha20-Poly1305、BLAKE2s，实现来自 `@noble/curves`、`@noble/ciphers`、`@noble/hashes`（见 `packages/protocol/src/noise.ts`），用途是保护和宿主之间的通信。维护者的回答是不使用需要申报的加密，`app.json` 的 `infoPlist` 里设了 `ITSAppUsesNonExemptEncryption: false`，App Store Connect 不再逐个构建询问。以后如果加了别的加密用途，要重新评估这个声明。

## ATS 与 `ws://` 主机名

生成的 `Info.plist` 是 `NSAllowsArbitraryLoads=false` + `NSAllowsLocalNetworking=true`，没有域名级例外。React Native 0.86 的 WebSocket 是 SocketRocket（基于 `NSStream`），ATS 管的是 `NSURLSession` 这一层，所以 `ws://` 连接不受 ATS 约束；App 里也没有别的远程请求（`fetch`、远程图片）。实测过的只有 Release 包用 `ws://` 连局域网 IP；`ws://` 连主机名（MagicDNS、`--public-url`）是按上面的代码路径推断能连，本机有代理拦截 DNS，没能实测，真机上第一次用主机名连时留意。以后如果引入走 `NSURLSession` 的明文请求，才需要动 ATS。

## 已知限制

- 图标还是默认空白（内部测试期）。
- 二维码配对只能真机验证，模拟器没相机。
