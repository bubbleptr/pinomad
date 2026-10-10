# PiNomad — Agent 说明

架构决策和背景在 `docs/adr/`（0001-0020，索引见 `docs/adr/README.md`），领域术语在 `CONTEXT.md`，改动前先读。计划和待办只记在 `docs/roadmap.md`：做完一项就更新它。

新 ADR 只在三条都满足时写：难以回退、没有上下文会让人意外、确实有过取舍。分期计划进 roadmap，用法进 README，不写进 ADR。新增 ADR 时同步更新索引。

## 布局

Bun workspaces：`packages/protocol`（宿主/客户端共享的协议，`exports` 直接指向 `.ts` 源，不构建、必须在浏览器和 React Native 的 Hermes 上都能运行，ADR-0017）、`apps/host`（宿主）、`apps/web`（Web 客户端，Vite + React + Astryx）、`apps/relay`（自部署中继，只转发密文，ADR-0008 第二期）、`apps/cli`（npm 单包的入口和打包脚本，ADR-0016）、`apps/desktop`（Electron 外壳，renderer 就是 `apps/web`，ADR-0017、0020）。

## 验证

`bun run typecheck`、`bun run test`、`bun run build` 都要绿。测试含 Playwright，缺浏览器先在 `apps/web` 下跑 `bunx playwright install chromium`（在根目录跑会拉最新版 playwright，装上的浏览器版本对不上）。

桌面端：`bun run desktop` 开发，`bun run desktop:package` 打不签名的包，`bun run desktop:e2e` 在 macOS 上跑 Electron 端到端（不进 `bun run test`，改了 `apps/desktop` 或配对流程要手动跑）。shell 里设了 `ELECTRON_RUN_AS_NODE=1` 时 Electron 会当成 Node 跑、App 起不来，这几条脚本已经清掉它。

打包 npm 包用 `bun run package -- --version <v>`（产物在 `apps/cli/out/`，不入库）；装包冒烟 `bun apps/cli/smoke.ts <tgz>` 要连真 registry，不进 `bun run test`。

## Git 与 worktree

- worktree 里不检出 `main`：git 不允许一个分支同时检出在两个 worktree 里，占着 `main` 会让主仓库切不过去。每个 worktree 用自己的 `feat/` / `fix/` / `chore/` 分支；要最新代码就 `git fetch` 后从 `origin/main` 开分支，只推文档时用 `git push origin HEAD:main`。PR 合并后，worktree 里切到 detached HEAD 或下一个分支即可，切回 `main` 并拉取只在主仓库里做。
- 合并堆叠 PR 时，下层 PR 不要用 `gh pr merge --delete-branch`：`gh` 自己删掉 base 分支后，上层 PR 会被 GitHub 直接关闭，不会自动改 base。先把上层 PR 的 base 改成 `main`，或者让仓库设置的合并后自动删除来处理。

## 运行时注意

- 宿主必须用 Node 跑（`node apps/host/src/main.ts`，`bun run host` 就是这条命令）：依赖 `node:sqlite` 和 Node 原生 TS 类型剥离，不能用 Bun。
- 一个数据目录（默认 `~/.pinomad`，`--data-dir` / `PINOMAD_DATA_DIR` 覆盖）同时只能有一个宿主进程；目录锁会拒绝第二个。
- `@earendil-works/*` 锁精确版本（当前 `1.0.4`，ADR-0002），升级要显式评审。
- 服务命令（`bun run service -- …`，ADR-0009）操作真实的服务管理器；测试里绝不要 `install` 真正的服务，开发用前台的 `bun run host` / `bun run start`。
