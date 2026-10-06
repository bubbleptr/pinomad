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

对话按项目组织（ADR-0007）：在客户端侧栏点 Add project 登记一个宿主上的目录，也可以启动时用可重复的 `--project DIR` 登记；不选项目的对话归入 Chat。宿主启动时不再自动建对话，第一条消息发出时才新建。项目对话直接在项目目录里工作，Chat 对话在 `<数据目录>/chats/<对话 id>` 里工作。fork 和子代理的对话显示在所属对话下面。归档只是隐藏，移除项目也不会删除目录和对话。

agent 用 read / write / edit / bash 工具，执行前不需要审批。系统提示词会带上以下内容，每次请求都重新读取（ADR-0006）：

- AGENTS.md：`~/.agents/AGENTS.md`，以及从根目录到 cwd 沿途的 AGENTS.md / CLAUDE.md；
- Skills：`<cwd>/.agents/skills` 和 `~/.agents/skills`，同名时项目的生效。

## 远程访问（ADR-0008）

默认只监听 `127.0.0.1`。加 `--remote-port N` 会另起一个监听所有网卡的安全通道端口（Noise IK 端到端加密 + 设备配对），并在同一端口用 HTTP 提供构建好的 Web 客户端——先 `bun run build` 产出 `apps/web/dist`，否则远程端口的页面是 503。

```sh
bun run build
bun run host -- --remote-port 7422
# 走隧道/自建入口时声明对外地址；或者 LAN 地址探测选错了网卡（比如 VPN 的
# TUN 接口优先被选中）时用 `--public-url` 覆盖——配对链接里的地址由它生成：
bun run host -- --remote-port 7422 --public-url https://pinomad.example.com
```

远程端口不接受 token：客户端要先做配对（由已连接的客户端发起，目前客户端的配对界面还没有，仅协议与宿主侧就绪），新设备凭一次性密钥完成 Noise 握手并登记公钥，之后只有已登记的设备能连。

## 验证

```sh
bun run typecheck
bun run test    # vitest + Playwright，首次跑前先 bunx playwright install chromium
bun run build
```
