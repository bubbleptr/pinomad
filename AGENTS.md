# PiNomad — Agent 说明

架构决策和背景在 `docs/adr/`（0001-0008），领域术语在 `CONTEXT.md`，改动前先读。

## 布局

Bun workspaces：`packages/protocol`（宿主/客户端共享的协议，`exports` 直接指向 `.ts` 源，不构建、必须浏览器可用）、`apps/host`（宿主）、`apps/web`（Web 客户端，Vite + React + Astryx）。

## 验证

`bun run typecheck`、`bun run test`、`bun run build` 都要绿。测试含 Playwright，缺浏览器先 `bunx playwright install chromium`。

## 运行时注意

- 宿主必须用 Node 跑（`node apps/host/src/main.ts`，`bun run host` 就是这条命令）：依赖 `node:sqlite` 和 Node 原生 TS 类型剥离，不能用 Bun。
- 一个数据目录（默认 `~/.pinomad`，`--data-dir` / `PINOMAD_DATA_DIR` 覆盖）同时只能有一个宿主进程；目录锁会拒绝第二个。
- `@earendil-works/*` 锁精确 `1.0.0`（ADR-0002），升级要显式评审。
