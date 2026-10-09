# PiNomad — Agent 说明

架构决策和背景在 `docs/adr/`（0001-0016，索引见 `docs/adr/README.md`），领域术语在 `CONTEXT.md`，改动前先读。计划和待办只记在 `docs/roadmap.md`：做完一项就更新它。

新 ADR 只在三条都满足时写：难以回退、没有上下文会让人意外、确实有过取舍。分期计划进 roadmap，用法进 README，不写进 ADR。新增 ADR 时同步更新索引。

## 布局

Bun workspaces：`packages/protocol`（宿主/客户端共享的协议，`exports` 直接指向 `.ts` 源，不构建、必须浏览器可用）、`apps/host`（宿主）、`apps/web`（Web 客户端，Vite + React + Astryx）、`apps/relay`（自部署中继，只转发密文，ADR-0008 第二期）、`apps/cli`（npm 单包的入口和打包脚本，ADR-0016）。

## 验证

`bun run typecheck`、`bun run test`、`bun run build` 都要绿。测试含 Playwright，缺浏览器先 `bunx playwright install chromium`。

打包 npm 包用 `bun run package -- --version <v>`（产物在 `apps/cli/out/`，不入库）；装包冒烟 `bun apps/cli/smoke.ts <tgz>` 要连真 registry，不进 `bun run test`。

## 运行时注意

- 宿主必须用 Node 跑（`node apps/host/src/main.ts`，`bun run host` 就是这条命令）：依赖 `node:sqlite` 和 Node 原生 TS 类型剥离，不能用 Bun。
- 一个数据目录（默认 `~/.pinomad`，`--data-dir` / `PINOMAD_DATA_DIR` 覆盖）同时只能有一个宿主进程；目录锁会拒绝第二个。
- `@earendil-works/*` 锁精确版本（当前 `1.0.4`，ADR-0002），升级要显式评审。
- 服务命令（`bun run service -- …`，ADR-0009）操作真实的服务管理器；测试里绝不要 `install` 真正的服务，开发用前台的 `bun run host` / `bun run start`。
