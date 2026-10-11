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

## 出口合规

App Store Connect 每个构建都会问加密合规。PiNomad 的 secure channel 是 Noise IK 协议，用的都是标准算法：X25519、ChaCha20-Poly1305、BLAKE2s，实现来自 `@noble/curves`、`@noble/ciphers`、`@noble/hashes`（见 `packages/protocol/src/noise.ts`），用途是保护和宿主之间的通信。是否声明豁免（`ios.config.usesNonExemptEncryption`）由维护者按法律咨询决定——代码里先不写死这个声明。

## ATS 与 `ws://` 主机名

生成的 `Info.plist` 是 `NSAllowsArbitraryLoads=false` + `NSAllowsLocalNetworking=true`，没有域名级例外。React Native 0.86 的 WebSocket 是 SocketRocket（基于 `NSStream`），ATS 管的是 `NSURLSession` 这一层，所以 `ws://` 连接不受 ATS 约束；App 里也没有别的远程请求（`fetch`、远程图片）。实测过的只有 Release 包用 `ws://` 连局域网 IP；`ws://` 连主机名（MagicDNS、`--public-url`）是按上面的代码路径推断能连，本机有代理拦截 DNS，没能实测，真机上第一次用主机名连时留意。以后如果引入走 `NSURLSession` 的明文请求，才需要动 ATS。

## 已知限制

- 图标还是默认空白（内部测试期）。
- 二维码配对只能真机验证，模拟器没相机。
- `usesNonExemptEncryption` 未设置（见上）。
