# ADR-0017：客户端形态——桌面端 Electron（仅 macOS），移动端 Expo

- 状态：Accepted
- 日期：2026-10-10

## 背景

ADR-0003 定了桌面、Web、移动端都是客户端，但没定各端用什么做。两处遗留：ADR-0001 第 4 条提到从 Pace 复制 Electron 外壳；ADR-0008 后果里，浏览器客户端的代码可信问题要看移动端选 PWA 还是 Expo，届时需要新 ADR。

现状：宿主和中继都直接提供构建好的 Web 客户端（ADR-0009 §7、ADR-0015 §4），手机和电脑的浏览器都能用。客户端的协议层 `packages/protocol` 是 TS，依赖 pi-durable 的类型（`ConversationView`、`EntryRecord`、`TaskGraph`）和 chord 的 delta（`applyImmutable`）；安全通道是 `Noise_IK_25519_ChaChaPoly_BLAKE2s`，原语来自 noble。

## 决策

1. **桌面端用 Electron，只做 macOS arm64。** 新建 `apps/desktop`：renderer 用 `apps/web` 的构建产物打包进 App，不做从宿主或中继加载页面的薄壳；main 进程只管窗口、钥匙串（`safeStorage`）、通知、`pinomad://` 深链和更新。外壳、electron-updater、签名公证从 Pace 复制（ADR-0001）。Pace 的内嵌浏览器不搬：宿主可能在另一台机器上，预览要经安全通道做端口转发，是另一个功能。
2. **Linux 和其他平台用 Web 客户端**，不出桌面安装包。
3. **移动端用 Expo（React Native）**，不以 PWA 作为主形态，也不用 Swift 原生。
4. **`packages/protocol` 必须能在 Hermes 上运行**，不能只满足浏览器可用。移动端直接复用它，包括 Noise 握手、帧、pi-durable 类型和 chord delta。
5. **桌面端和移动端都是打包的客户端**，会和宿主的版本错开（App Store 审核本身就要几天）。ADR-0009 §8 现在要求协议版本严格相等，打包的客户端只能显示"版本不匹配"。所以在发布任何一个打包客户端之前，要先定协议兼容策略（见 ADR-0018）。

## 考虑过的方案

- **桌面薄壳（加载中继提供的页面）**：版本总和宿主一致，但代码可信问题和浏览器一样，每台宿主还要单独开一个窗口，桌面端除了独立窗口没有多出别的东西。
- **桌面端什么都不做，用 Safari 的"添加到程序坞"**：零成本，有独立窗口和通知；但私钥只能存在网页存储里，不能同时连多台宿主。
- **Tauri**：在 macOS 上用 WKWebView，表现没问题，包体更小；但 Pace 的外壳、更新、发布脚本都是 Electron，换 Tauri 就得从头做。
- **macOS 用 SwiftUI 多平台、和 iOS 共用代码**：要同时维护 Web 和 Swift 两套完整 UI，Pace 的东西用不上。
- **移动端用 PWA**：零安装，iOS 16.4 起主屏 Web App 也能收推送；但私钥存在 IndexedDB，可能被系统清掉，清掉了就要重新配对，也做不了灵动岛、小组件、分享扩展。
- **移动端用 Swift 原生**：手感和平台能力最好。代价是协议层要跨语言重写：CryptoKit 没有 BLAKE2s，要自己补；pi-durable 的类型和 chord 的 delta 格式要在 Swift 里手动镜像，每次升级 `@earendil-works/*`（ADR-0002）都可能悄悄偏移；界面也要全部重写。

## 后果

- ADR-0008 后果里的代码可信问题：桌面端和移动端的代码都随 App 安装，不经网络加载，问题在这两端解决。浏览器客户端仍然只靠从用户自己的中继用 HTTPS 加载来缓解（ADR-0015 §4）。
- 移动端要补 `getRandomValues`（ADR-0008 已经预见）。其他 Web API 在 Hermes 上是否都有（例如 `TextEncoder`、`WebSocket` 的行为），要在第一次跑通时验证，不能假定。
- 移动端界面要重写，React DOM 换成 React Native。Astryx 和从 Pace 搬来的组件不能直接用；不依赖 DOM 的视图推导（例如 `CotView`）可以挪到共享的位置复用。设计 token 怎么在两端共享，到时再定。
- Electron 的签名公证需要 Apple 开发者账号和 CI 里的证书；Expo 的 iOS 构建和分发（EAS、TestFlight）是另一条发布线，和 npm 包的发布（ADR-0016）互相独立。
