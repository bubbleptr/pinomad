# PiNomad — Agent 说明

架构决策和背景在 `docs/adr/`（0001-0025，索引见 `docs/adr/README.md`），领域术语在 `GLOSSARY.md`，改动前先读。计划和待办只记在 `docs/roadmap.md`：做完一项就更新它。

新 ADR 只在三条都满足时写：难以回退、没有上下文会让人意外、确实有过取舍。分期计划进 roadmap，用法进 README（中英两份 `README.md` / `README.zh-CN.md` 要同步）和 `docs/` 下的使用文档（`usage.md`、`remote-access.md`、`service.md`），不写进 ADR。新增 ADR 时同步更新索引。

## 布局

Bun workspaces：`packages/protocol`（宿主/客户端共享的协议，`exports` 直接指向 `.ts` 源，不构建、必须在浏览器和 React Native 的 Hermes 上都能运行，ADR-0017）、`packages/client`（各客户端共用的推导：思维链视图、对话家族、排队/状态、工具名、宿主条目校验；同样直接导出 `.ts` 源，不依赖 DOM 和 React，tsconfig 的 `lib` 不含 DOM）、`apps/host`（宿主）、`apps/web`（Web 客户端，Vite + React + Astryx）、`apps/relay`（自部署中继，只转发密文，ADR-0008 第二期）、`apps/cli`（npm 单包的入口和打包脚本，ADR-0016）、`apps/desktop`（Electron 外壳，renderer 就是 `apps/web`，ADR-0017、0020）、`apps/mobile`（Expo 移动端，heroui-native + Uniwind，ADR-0017）、`crates/pinomad-core`（原生移动端共用的 Rust 客户端协议核心，ADR-0024；Cargo workspace 在仓库根，库本身不做 I/O、不依赖异步运行时，异步/WebSocket 只在 dev-dependencies）。

移动端正按 ADR-0024 重写成原生（iOS SwiftUI，客户端协议核心用 Rust），`apps/mobile` 在维护期：只修严重问题，不加功能，原生版替换后删除；M5 等计划里的移动端部分都做在原生版上。

改 `packages/protocol` 或 `packages/client` 的客户端侧行为时，同步改 `crates/pinomad-core` 并在 `packages/protocol/test` 里用 `PINOMAD_UPDATE_VECTORS=1 bunx vitest run --project protocol rust-vectors` 重新生成对照向量；新鲜度测试会拦下漂移。

界面改动按端分开做：Web 和桌面端（renderer 就是 `apps/web`）在 Linux 上就能开发和验证，一起做；iOS（`apps/mobile`）单独做，不和 Web 的界面放进同一个 PR。只改协议或 `packages/client` 时，移动端的 typecheck 和测试也要通过。

## 验证

`bun run typecheck`、`bun run test`、`bun run build` 都要绿。测试含 Playwright，缺浏览器先在 `apps/web` 下跑 `bunx playwright install chromium`（在根目录跑会拉最新版 playwright，装上的浏览器版本对不上）。

Rust：`cargo test`（`bun run test` 会带着跑；非登录 shell 里 `~/.cargo/bin` 可能不在 PATH，先 export）。工具链锁在 `rust-toolchain.toml`，依赖锁精确版本且发布满 7 天。互操作测试 `cargo test --test interop` 用临时数据目录起真实宿主（Node），测完自动关。

桌面端：`bun run desktop` 开发，`bun run desktop:package` 打不签名的包，`bun run desktop:e2e` 在 macOS 上跑 Electron 端到端（不进 `bun run test`，改了 `apps/desktop` 或配对流程要手动跑）。shell 里设了 `ELECTRON_RUN_AS_NODE=1` 时 Electron 会当成 Node 跑、App 起不来，这几条脚本已经清掉它。

App 图标源文件是 `apps/desktop/build/icon.icon`，用 Xcode 自带的 Icon Composer（`/Applications/Xcode.app/Contents/Applications/Icon Composer.app`）编辑，`/Applications` 下单独装的 1.5 版太旧；命令行预览用同目录的 `Contents/Executables/ictool`。Icon Composer 27 里图层和组的数组都是第一个在最上层。打包要 Xcode 26+ 的 actool。

移动端：`cd apps/mobile && bunx expo run:ios -d "iPhone 17 Pro"` 构建开发包并在模拟器上跑（`ios/`、`android/` 由 CNG 生成，不入库）。改了移动端依赖版本后用 `bunx expo start --clear`，Metro 的旧转换缓存会让 App 启动时栈溢出。Expo 相关依赖锁精确版本，不用发布不到 7 天的；`package.json` 的 `expo.install.exclude` 让 `expo install --check` 跳过故意没升到最新补丁的包，升级时一并更新。heroui-native 只用 OSS 包。发版（EAS + TestFlight）见 `docs/mobile-release.md`；`--configuration Release` 跑 Release 包，检查不依赖 Metro 的情况。

打包 npm 包用 `bun run package -- --version <v>`（产物在 `apps/cli/out/`，不入库）；装包冒烟 `bun apps/cli/smoke.ts <tgz>` 要连真 registry，不进 `bun run test`。

## Git 与 worktree

- worktree 里不检出 `main`：git 不允许一个分支同时检出在两个 worktree 里，占着 `main` 会让主仓库切不过去。每个 worktree 用自己的 `feat/` / `fix/` / `chore/` 分支；要最新代码就 `git fetch` 后从 `origin/main` 开分支，只推文档时用 `git push origin HEAD:main`。PR 合并后，worktree 里切到 detached HEAD 或下一个分支即可，切回 `main` 并拉取只在主仓库里做。
- 合并堆叠 PR 时，下层 PR 不要用 `gh pr merge --delete-branch`：`gh` 自己删掉 base 分支后，上层 PR 会被 GitHub 直接关闭，不会自动改 base。先把上层 PR 的 base 改成 `main`，或者让仓库设置的合并后自动删除来处理。
- 合并 PR 前等 Devin Review 跑完再合。合并后停掉为这个 PR 起的开发宿主和 Vite 等开发服务，不要留着进程。

## 运行时注意

- 宿主必须用 Node 跑（`node apps/host/src/main.ts`，`bun run host` 就是这条命令）：依赖 `node:sqlite` 和 Node 原生 TS 类型剥离，不能用 Bun。
- 一个数据目录（默认 `~/.pinomad`，`--data-dir` / `PINOMAD_DATA_DIR` 覆盖）同时只能有一个宿主进程；目录锁会拒绝第二个。
- `@earendil-works/*` 锁精确版本（当前 `1.2.0`，ADR-0002），升级要显式评审。
- 服务命令（`bun run service -- …`，ADR-0009）操作真实的服务管理器；测试里绝不要 `install` 真正的服务，开发用前台的 `bun run host` / `bun run start`。

## Agent skills

### Issue tracker

Issue 记在 GitHub Issues（bubbleptr/pinomad），用 `gh` 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

用默认的五个标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：术语表是根目录的 `GLOSSARY.md`，ADR 在 `docs/adr/`。见 `docs/agents/domain.md`。
