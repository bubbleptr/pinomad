# PiNomad

以 coding 为核心的 agent 产品，基于 [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable)。

- 自托管宿主：在你自己的机器（Mac mini、Linux VPS）上运行，直接使用本机的 shell 和代码仓库；执行可在崩溃或重启后恢复。
- 多端客户端：桌面、Web、移动端连接同一个宿主，界面由 PiNomad 统一定义。

架构决策见 [`docs/adr/`](docs/adr/)，术语见 [`CONTEXT.md`](CONTEXT.md)。

## 运行

需要 Bun（安装依赖、跑脚本）和 Node 25+（宿主依赖 `node:sqlite` 和原生 TS 类型剥离，不能用 Bun 跑）。

```sh
bun install

# 起宿主：真实模型需要先在 pi 里配好认证（读 ~/.pi/agent）；
# 没有认证可以用脚本化的假模型冒烟：
bun run host -- --faux "hi"

# 另一个终端起 Web 客户端（http://127.0.0.1:5199），并打印带 token 的浏览器链接：
bun run web
bun run link
```

默认数据目录是 `~/.pinomad`（session.sqlite、token、目录锁），可用 `--data-dir` 或 `PINOMAD_DATA_DIR` 覆盖；同一数据目录同时只能有一个宿主进程。

## 验证

```sh
bun run typecheck
bun run test    # vitest + Playwright，首次跑前先 bunx playwright install chromium
bun run build
```
