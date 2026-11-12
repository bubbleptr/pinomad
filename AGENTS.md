# PiNomad — Agent 说明

架构总览在 `docs/architecture.md`，架构决策和背景在 `docs/adr/`（0001-0048，索引见 `docs/adr/README.md`），领域术语在 `GLOSSARY.md`，改动前先读。计划和待办记在 GitHub Issues，按 milestone 分组（用法见 `docs/agents/issue-tracker.md`）；`docs/roadmap.md` 只放方向和顺序，阶段或顺序变了才改。PR 用 `Closes #N` 关闭对应的 issue，不往 roadmap 里写进度。

新 ADR 只在三条都满足时写：难以回退、没有上下文会让人意外、确实有过取舍。分期计划进 milestone 和 issue，用法写进官网文档 `apps/site/content/docs/`（中文文件带 `.zh` 后缀，发布在 pinomad.si/docs），以官网为准；README（中英两份 `README.md` / `README.zh-CN.md` 要同步）只留简介、快速上手和文档入口；`docs/` 下只放开发和运维文档（如 `website.md`），原来的 `usage.md`、`remote-access.md`、`service.md` 只是指向官网的链接，不要再往里写。这些都不写进 ADR。新增 ADR 时同步更新索引。

## 布局

Bun workspaces：`packages/protocol`（宿主/客户端共享的协议，`exports` 直接指向 `.ts` 源，不构建、必须在浏览器和 Node 上都能运行，ADR-0024）、`packages/client`（各客户端共用的推导：思维链视图、对话家族、排队/状态、工具名、宿主条目校验；同样直接导出 `.ts` 源，不依赖 DOM 和 React，tsconfig 的 `lib` 不含 DOM；两个包有没有用 Node 内置模块、Node 或 DOM 专属的全局，由 `packages/protocol/test/runtime-boundaries.ts` 检查。`@types/node` 会经 undici-types 漏进来，所以 `"types": []` 拦不住，别再试）、`packages/plugin`（插件作者用的类型，`@pinomad/plugin/v1` 是宿主侧 API；只有类型，插件用 `import type` 引入，ADR-0049；宿主启动时从 `<dataDir>/plugins/` 加载插件，加载器在 `apps/host/src/plugins.ts`；示例插件在 `examples/plugins/`，不在 Bun workspaces 里、也不内置，`host.ts` 的类型检查靠 `examples/plugins/tsconfig.json` 的 `paths`，只在根目录的 `bun run typecheck` 里跑（CI 按 workspace 跑 tsc，不查它；`web.js` 不做类型检查），`artifact` 由 `apps/host/test/plugins-gateway.test.ts` 和 `apps/web/test/web-csp.test.ts` 直接加载，改插件 API 时它们会拦住；用法文档在官网的 `plugins` 页）、`apps/host`（宿主）、`apps/web`（Web 客户端，Vite + React + shadcn/Base UI + Tailwind）、`apps/server`（服务端：账号、为新设备担保、推送，外网连不上家里时转发密文，ADR-0022；中继部分见 ADR-0008 第二期、0015。命令是 `pinomad server`，`pinomad relay` 是旧名，保留为别名）、`apps/site`（pinomad.si 官网：落地页、文档、博客和更新日志，TanStack Start + Fumadocs，构建时预渲染成静态文件，见 `docs/website.md`）、`apps/cli`（npm 单包的入口和打包脚本，ADR-0016）、`apps/desktop`（Electron 外壳，renderer 就是 `apps/web`，ADR-0017、0020）、`crates/pinomad-core`（原生移动端共用的 Rust 客户端协议核心，ADR-0024；Cargo workspace 在仓库根，库本身不做 I/O、不依赖异步运行时，异步/WebSocket 只在 dev-dependencies）、`crates/pinomad-rtc`（原生端 P2P 用的 sans-I/O WebRTC 栈：STUN + str0m DataChannel，ADR-0033 §6；不开 socket、不读时钟，由平台层喂数据报和计时器，`pinomad-core` 的 `ffi` feature 依赖它）。

iOS 客户端是原生的 `apps/ios`（SwiftUI + `crates/pinomad-core`，ADR-0024），不在 Bun workspaces 里，开发验证见下。聊天界面组件 AgentChatKit 是独立的 SwiftPM 包 `packages/agent-chat-kit`（没有 `package.json`，也不在 Bun workspaces 里，有自己的 `AGENTS.md`）。

改 `packages/protocol` 或 `packages/client` 的客户端侧行为时，同步改 `crates/pinomad-core` 并重新生成对照向量：在仓库根目录跑，协议层的（生成器在 `packages/protocol/test`）用 `PINOMAD_UPDATE_VECTORS=1 bunx vitest run --project protocol rust-vectors`，推导层的（生成器在 `packages/client/test`）用 `PINOMAD_UPDATE_VECTORS=1 bunx vitest run --project client rust-vectors`；在子目录里跑会报 "No test files found"。新鲜度测试会拦下漂移。

界面改动按端分开做：Web 和桌面端（renderer 就是 `apps/web`）在 Linux 上就能开发和验证，一起做；iOS（`apps/ios`）单独做，不和 Web 的界面放进同一个 PR。只改协议或 `packages/client` 时，iOS 侧由上面的 `crates/pinomad-core` 同步规则和 CI 里 cargo job 的对照向量测试兜住；需要同步的改动会碰到 `crates/`，rust-core workflow 的 ios job 随之触发。同一功能分 Web 和 iOS 两个 PR 时，一端修掉的 dureview 发现要写进另一端的任务说明，在那一端逐条核对是否同样适用（账号流程、拖放重排、吊销提示这几类都在两端各返工过一次）。"Add a host" 的 join 命令以 `packages/protocol/test/fixtures/join-commands.json` 为准（手写，不是生成的）：要改命令先改这份夹具，再让 Web 的 `apps/web/src/widgets/account/join-command.test.ts`、服务端的 `apps/server/test/join-command.test.ts`、iOS 的 `HostLinkTests` 都通过。

Web 界面的设计规则在 `apps/web/DESIGN.md`：按钮只有 `primary` / `secondary` / `ghost` / `destructive` 四档，什么时候用哪档、什么尺寸都在那里，加按钮前先读。

Web 界面用 shadcn 的 Base UI 版（ADR-0048）：组件在 `apps/web/src/shared/ui/`，归我们所有、可以直接改；新组件在 `apps/web` 下跑 `bunx shadcn@latest add <name>`。设计 token 在 `apps/web/src/app/tokens.css`，颜色用 shadcn 的变量名（`text-muted-foreground`、`bg-card`、`text-destructive`）；不跑 `shadcn init`，它会改写 `styles.css`，那里的 `@layer` 顺序不能动。

Web 组件的 Storybook 在 `apps/web/.storybook`（`bun run storybook`，默认端口 6006，用 `PORT=<端口>` 覆盖，几个会话并行时各用各的端口；新建 story 文件后 class 没生效就重启 Storybook）：story 和组件放在一起（`*.stories.tsx`），装饰器引入 `styles.css`，工具栏切明暗（切 `<html>` 上的 `dark` 类）；画布默认是对话栏宽度（44rem，居中），整屏的组件在 story 上设 `parameters: { canvasWidth: "full" }`。`src/test/stories.test.tsx` 在 jsdom 里渲染全部 story，进 `bun run test`；组件的 props 变了要同步改它的 story。

## 验证

`bun run typecheck`、`bun run test`、`bun run build` 都要绿。测试含 Playwright，缺浏览器先在 `apps/web` 下跑 `bunx playwright install chromium`（在根目录跑会拉最新版 playwright，装上的浏览器版本对不上）。

只跑一部分时在仓库根目录跑 `bunx vitest run --project <名字>`，项目名有 `protocol`、`client`、`host`、`server`、`cli`、`desktop`、`web`（Playwright 端到端测试，在 `apps/web/test/`，主要是 `web-ui.test.ts`，按按钮名和文案定位元素）、`web-dom`（jsdom 组件测试，和组件放在一起）、`site`。Electron 端到端测试是 `apps/desktop/test/e2e.ts`。改用户能看到的文案时，`apps/web/src`、`apps/web/test`、`apps/ios`、`apps/site/content/docs` 都要 grep 一遍旧文案。拖放测试写成 `web-dom` 组件测试，手动构造事件并设置 `clientY`：jsdom 里没有 `DragEvent`，元素尺寸都是 0；Playwright 也触发不了"拖动选中的文字"。改 `apps/site/public/install.sh` 时跑 `shellcheck -s sh apps/site/public/install.sh` 和 `bunx vitest run --project site`（会在 `sh` 和 `dash` 的裸环境下各跑一遍，CI 的 site.yml 也跑这两项）。

在浏览器里看 Web 改动时，用 faux 模型起一个临时宿主，不要碰 `~/.pinomad`：

```sh
d=$(mktemp -d)
node apps/host/src/main.ts --data-dir "$d" --port 7431 --faux "hello" &   # 不调真实模型
bun run web &                                                              # Vite，固定端口 5199
bun run link -- --data-dir "$d" --url ws://127.0.0.1:7431                  # 打印带 token 的 Web 链接
```

用完停掉这两个进程。

Rust：`cargo test`（`bun run test` 会带着跑，含 `--features ffi`；非登录 shell 里 `~/.cargo/bin` 可能不在 PATH，先 export）。工具链锁在 `rust-toolchain.toml`，依赖锁精确版本且发布满 7 天。互操作测试 `cargo test --test interop` 用临时数据目录起真实宿主（Node），测完自动关。

UniFFI 外观层（ADR-0024）：`crates/pinomad-core` 的 `ffi` feature 打开 `src/ffi/` 和可选依赖 `uniffi = "=0.32.2"`（proc-macro，无 UDL）。生成 Swift 绑定：

```sh
cargo rustc -p pinomad-core --features ffi --crate-type cdylib
cd crates/uniffi-bindgen && cargo run --release -- generate --library ../../target/debug/libpinomad_core.so --language swift --out-dir <输出目录>
```

`crates/uniffi-bindgen` 是独立于根 workspace 的小 bin crate（自带 `[workspace]` 和 Cargo.lock，`uniffi` 版本和库里锁的一致），生成物不入库。库本身保持 rlib（普通 `cargo test` 不为静态库买单），iOS 需要 staticlib 时用 `cargo rustc --crate-type staticlib` 在打包脚本里编。

原生 iOS（`apps/ios`，ADR-0024 §11）：`apps/ios/scripts/build-core.sh` 从干净检出生成 xcframework（真机 + 模拟器切片，release staticlib）和 UniFFI Swift 绑定，产物在 `apps/ios/PinomadCore/Vendor/` 和 `Sources/PinomadCore/Generated/`（都不入库，新检出必须先跑这个脚本）。`apps/ios/PinomadCore` 是本地 SwiftPM 包（binaryTarget + 生成的绑定 + 平台层 + `PinomadChat` 适配层），它的 Swift 测试在模拟器上跑（多个测试 target 时用 SwiftPM 自动生成的 `-Package` scheme）：

```sh
cd apps/ios/PinomadCore
xcodebuild -scheme PinomadCore-Package -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

界面图标用 Lucide，生成为自定义 SF Symbol 入库（App 里是 `Image(.triangleAlert)`、`Label(_, image:)`，kit 里是 `Image(Icon.copy)`，随字号和字重缩放）：加图标时往 `apps/ios/scripts/lucide-icons.txt` 或 `packages/agent-chat-kit/scripts/lucide-icons.txt` 加名字，再跑 `apps/ios/scripts/lucide-icons.sh`（要 `brew install swiftdraw`，两份一起生成），许可见 `docs/licenses/lucide.md`。

App 是 `apps/ios/Pinomad.xcodeproj`（同步文件夹，最低 iOS 26，只做 iPhone）。App 图标是 `apps/ios/Pinomad/AppIcon.icon`，和桌面端的 `apps/desktop/build/icon.icon` 是同一份 Icon Composer 工程，改图标时两份一起换：

```sh
xcodebuild -project apps/ios/Pinomad.xcodeproj -scheme Pinomad \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
xcrun simctl install "iPhone 17 Pro" <产物里的 Pinomad.app>
xcrun simctl launch "iPhone 17 Pro" build.kieran.pinomad \
  -pairingLink '<配对链接>' -autoPair YES   # 调试注入；不带参数则走钥匙串自动重连
```

"iPhone 17 Pro" 是共享的模拟器，别的会话可能在上面留下弹窗和旧的配对。几个 worktree 或子代理并行时，各自建一台来测，测完删掉；别人留下的弹窗不要去处理。共享那台开着时 `simctl clone` 会报 "Booted"，所以用 `create`：

```sh
sim=$(xcrun simctl create "pinomad-$(basename "$PWD")" "iPhone 17 Pro" 2>/dev/null)   # 打印 UDID
xcrun simctl boot "$sim"                          # 上面的命令里把 name=iPhone 17 Pro 换成 id=$sim
xcrun simctl shutdown "$sim" && xcrun simctl delete "$sim"
```

真机（iphone181，UDID 00008150-001608822678401C）：

```sh
# 构建要签名：DEVELOPMENT_TEAM 用开发者证书所属团队，pbxproj 里保持为空。
# derivedDataPath 写 /private/tmp 而不是 /tmp：/tmp 是软链，重跑 build-core.sh 后
# 增量构建会报 pinomad_coreFFI.h "has been modified since the module file"。
xcodebuild -project apps/ios/Pinomad.xcodeproj -scheme Pinomad \
  -destination 'id=00008150-001608822678401C' -derivedDataPath /private/tmp/pinomad-device-dd \
  DEVELOPMENT_TEAM=9KZ32XLVQW -allowProvisioningUpdates build
xcrun devicectl device install app --device 00008150-001608822678401C \
  /private/tmp/pinomad-device-dd/Build/Products/Debug-iphoneos/Pinomad.app

# devicectl 会把 -xxx 应用参数当成自己的短选项簇解析（-autoPair → -a -u -t …），
# 所以启动参数走 DEVICECTL_CHILD_ 环境变量（App 也读 PINOMAD_* env）：
# 这些启动参数、PINOMAD_* 环境变量、PerfLog 和 AUTOSCROLL 只在 Debug 构建里编入，Release 包会忽略。
DEVICECTL_CHILD_PINOMAD_PAIRING_LINK='<配对链接>' DEVICECTL_CHILD_PINOMAD_AUTOPAIR=1 \
  xcrun devicectl device process launch --device 00008150-001608822678401C build.kieran.pinomad
# 手机锁屏时 launch 会被拒绝（FBSOpenApplicationErrorDomain 7）——等解锁。

# 性能实测：iOS 27 真机上 xctrace 的 --attach/--launch 连不上进程（attach 找不到
# 进程、launch 卡在 "waiting for device to boot"），改为 App 内 PerfLog：
# PINOMAD_PERFLOG 开启后，会话层把 bytes / snapshot(耗时) / publish / ui-publish /
# 常驻内存 记进 Documents/perf.ndjson，用 devicectl 拉回分析：
DEVICECTL_CHILD_PINOMAD_PERFLOG=1 DEVICECTL_CHILD_PINOMAD_KEEPSCREEN=1 \
  DEVICECTL_CHILD_PINOMAD_OPEN=<对话id> \
  xcrun devicectl device process launch --device 00008150-001608822678401C build.kieran.pinomad
# 帧停顿（>2 帧的帧间隔）记为 hitch 事件，附 gap 和预期帧时长；
# PINOMAD_AUTOSCROLL 让对话页定时滚到底部，用于远程测量滚动卡顿；=bounce 时在首尾之间来回滚，
# 用于测已经停下的长对话（PerfLog 也每 5s 落盘一次，不依赖新快照）；
# PINOMAD_AUTOPAIR 下配对失败每 15s 自动重试（约 10 分钟窗口）；
# PINOMAD_OPEN_HOST_DETAIL=1 在 ready 后打开当前宿主的连接详情页；
# PINOMAD_PROMPT_FILE=<Documents 下路径> 在 Auto 的 P2P 准备结束后发送这份文本，必须同时给 PINOMAD_PROMPT_HOST=<hostKey 后缀>，不匹配就拒绝发送；
# PINOMAD_PROMPT_MODEL=faux/faux-1 指定这份脚本消息用的模型（宿主快照里存在才生效）；
# PINOMAD_ATTACH_DELAY_MS=200 给附件分片之间加延迟，让上传在压后台时仍在进行（仅 DEBUG）。
# 警告：PINOMAD_PROMPT_FILE 向当前 active host 发消息，用前必须核对 hostKey 后缀是测试宿主，否则会写进真实宿主。
xcrun devicectl device copy from --device 00008150-001608822678401C \
  --source Documents/perf.ndjson \
  --domain-type appDataContainer --domain-identifier build.kieran.pinomad \
  --destination /tmp/perf.ndjson
# 真机截图（PR 用）：xcrun devicectl device capture screenshot --device <UDID> --destination /tmp/shot.png
# 后台恢复测试：devicectl 拉起别的 App（如 com.apple.mobilesafari）把 Pinomad 压后台。
# os_signpost 打点仍在（bytes/snapshot/publish/ui-publish），能用 Instruments 的机器上照旧录。
```

平台层的保序契约（ADR-0024 §3）：所有输入进同一条有序队列、由唯一一个循环消费，`handle` 和它产出的指令在同一段同步代码里处理完，没有悬挂点；每条连接一个顺序接收循环、一个 FIFO 发送器；计时器取消后不得再触发 `TimerFired`；`ViewChanged` 只标脏，快照计算最多一个在途、版本不回退。

桌面端：`bun run desktop` 开发，`bun run desktop:package` 打不签名的包，`bun run desktop:e2e` 在 macOS 上跑 Electron 端到端（不进 `bun run test`，改了 `apps/desktop` 或配对流程要手动跑）。shell 里设了 `ELECTRON_RUN_AS_NODE=1` 时 Electron 会当成 Node 跑、App 起不来，这几条脚本已经清掉它。

App 图标源文件是 `apps/desktop/build/icon.icon`（戴帽子的幽灵，全平台同一套视觉；身体轮廓层故意用 PNG，SVG 描边会被深色纯色覆盖填满）。Web 的 `apps/web/public/favicon.svg`（随系统深浅色切换）和 `apple-touch-icon.png`（不透明、无圆角）由同一图形导出，改图标时一起更新。图标用 Xcode 自带的 Icon Composer（`/Applications/Xcode.app/Contents/Applications/Icon Composer.app`）编辑，`/Applications` 下单独装的 1.5 版太旧；命令行预览用同目录的 `Contents/Executables/ictool`。Icon Composer 27 里图层和组的数组都是第一个在最上层。打包要 Xcode 26+ 的 actool。

打包 npm 包用 `bun run package -- --version <v>`（产物在 `apps/cli/out/`，不入库）；装包冒烟 `bun apps/cli/smoke.ts <tgz>` 要连真 registry，不进 `bun run test`。

## Git 与 worktree

- worktree 里不检出 `main`：git 不允许一个分支同时检出在两个 worktree 里，占着 `main` 会让主仓库切不过去。每个 worktree 用自己的 `feat/` / `fix/` / `chore/` 分支；要最新代码就 `git fetch` 后从 `origin/main` 开分支。main 有分支保护，必需检查是 `ci-ok`，管理员也不例外，所以不能直推，只改文档也要开 PR（只跑 `changes` 和 `ci-ok`，约 20 秒）。PR 合并后，worktree 里切到 detached HEAD 或下一个分支即可，切回 `main` 并拉取只在主仓库里做。
- 堆叠 PR 全绿时用 `gh stack merge <stack 号> --yes --squash` 一次合入：原子操作，每个 PR 各成一个 squash 提交，最上层 PR 的 CI 跑的就是合入后的整棵树，不用逐个 retarget、rebase 再等 CI。只想先合下面几层时用 `gh stack merge <PR 号>`，合到那一层为止。`gh stack push` 之后先用 `gh run list --commit <head sha>` 确认 CI 在当前 head 上触发了：没触发就重推，或者告诉用户，不要猜原因。CI 的结论看 `ci-ok` 这一个检查，它汇总 ci.yml 里的全部检查（被路径过滤跳过的算通过）。
- 手动逐个合并堆叠 PR 时，下层 PR 不要用 `gh pr merge --delete-branch`：`gh` 自己删掉 base 分支后，上层 PR 会被 GitHub 直接关闭，不会自动改 base。先把上层 PR 的 base 改成 `main`，或者让仓库设置的合并后自动删除来处理。
- 合并 PR 前等 dureview（自部署的评审 bot）跑完再合。它每个 PR 只审一次（`.dureview.md` 的 `trigger: once`），审的是首次推送的 head：修复提交和 force-push 之后不会再出 dureview check，之前的 CHANGES_REQUESTED 也会留着。修完发现后只等 CI，不要轮询 dureview；要复审就在 PR 里评论 `/dureview`。同一个 PR 第 3 次 `/dureview` 之后只修 P1，P2 和 P3 开成 follow-up issue，修不修让用户定。合并后停掉为这个 PR 起的开发宿主和 Vite 等开发服务，不要留着进程。

## 运行时注意

- 宿主必须用 Node 跑（`node apps/host/src/main.ts`，`bun run host` 就是这条命令）：依赖 `node:sqlite` 和 Node 原生 TS 类型剥离，不能用 Bun。
- 一个数据目录（默认 `~/.pinomad`，`--data-dir` / `PINOMAD_DATA_DIR` 覆盖）同时只能有一个宿主进程；目录锁会拒绝第二个。
- 服务端已登录的路由读请求体一律用 `authedJson`（`apps/server/src/api.ts`），之后只用它返回的 session，不用读请求体之前鉴权拿到的那个；`apps/server/test/api-reauth.test.ts` 会拦违规写法。新建的整数 id 表用 `AUTOINCREMENT`，要豁免就在 `apps/server/test/schema.test.ts` 的 `REUSABLE_IDS` 里写明理由。
- `@earendil-works/*` 锁精确版本（当前 `1.5.0`，ADR-0002；`packages/protocol/test/earendil-pins.test.ts` 会拦 `^`/`~` 这类范围写法），升级要显式评审：用 `PINOMAD_UPDATE_CONTRACT=1` 重录契约快照（`apps/host/test/protocol-contract.test.ts`，基准在 `packages/protocol/test/fixtures/`），重新生成 Rust 对照向量，再看差异。
- 改了线上类型（帧、调用、门控、presentation）就升 `PROTOCOL` 并用 `PINOMAD_UPDATE_SURFACE=1` 重录协议快照（`packages/protocol/test/fixtures/protocol-surface.json`）。
- 服务命令（`bun run service -- …`，ADR-0009）操作真实的服务管理器；测试里绝不要 `install` 真正的服务，开发用前台的 `bun run host` / `bun run start`。

## Agent skills

### Issue tracker

Issue 记在 GitHub Issues（bubbleptr/pinomad），用 `gh` 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

用默认的五个标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：术语表是根目录的 `GLOSSARY.md`，ADR 在 `docs/adr/`。见 `docs/agents/domain.md`。
