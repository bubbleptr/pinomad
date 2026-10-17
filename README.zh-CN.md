# PiNomad

[English](README.md) · 中文 · [pinomad.si](https://pinomad.si/zh/)

基于 [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 的自托管 coding agent。agent 跑在你自己的机器上，Mac App、Web 和 iPhone App 连的是同一批运行中的任务。

![同一个任务同时显示在 Mac App、iPhone 和 Web 上](docs/assets/demo.jpg)

<sub>一个任务，三个客户端：左边是 Mac App，中间是 iPhone（用 iPhone 镜像投到 Mac 上），右边是 Web。宿主是同一个 tailnet 里的一台 Linux 机器。</sub>

- **活在你自己的机器上干。** 宿主可以跑在 Mac mini、Linux 主机或 VPS 上，agent 直接用那台机器的 shell 和代码仓库。
- **崩溃、重启都不丢进度。** Pi Durable 会给每次模型调用和工具调用存检查点，宿主重启后从断掉的地方接着跑。
- **客户端只是窗口。** 在电脑前开个任务，出门用手机看进度、插话调整方向。设备扫一次性二维码配对，和宿主之间走端到端加密的通道：局域网或 tailnet 直连都行，也可以经过只能看到密文的中继。

> **状态：** 还在早期，迭代很快。Pi Durable 本身也是实验性的；宿主和客户端的协议主版本号必须一致。

## 快速上手

宿主需要 Node 25+，支持 macOS 和 Linux。

```sh
npm i -g pinomad
pinomad host        # 用你在 pi 里配好的模型和认证（~/.pi/agent）
pinomad link        # 另开一个终端：打印 Web 客户端的浏览器链接
```

还没配过 pi？`pinomad host --faux "hi"` 会用一个脚本化的假模型跑起来，可以先点点看。

## 连上其他设备

给配对设备开一个端口，然后每台设备各扫一个二维码：

```sh
pinomad host --remote-port 7422
pinomad pair        # 一次性的二维码和链接，5 分钟后过期
```

iPhone App 扫码，Mac App 粘贴链接。远程端口只接受配对过的设备，不需要的设备可以在侧栏的 Devices 里吊销。

配对链接默认用宿主探测到的局域网地址。在 tailnet 里或走隧道时，加上 `--public-url http://<tailnet-ip>:7422`，让链接指向那个地址。宿主在家、人在外面也想连，就在 VPS 上跑中继，见[远程访问](docs/remote-access.md)。

## 常驻运行

把宿主装成当前用户的服务（macOS 是 LaunchAgent，Linux 是 systemd 用户单元），开机自启、崩溃自动拉起：

```sh
pinomad service install --remote-port 7422
pinomad service status
pinomad upgrade     # 装上 pinomad@latest，等正在跑的任务结束后重启
```

服务参数、日志和各平台的注意事项见[常驻运行](docs/service.md)。

## 客户端

| 客户端 | 获取方式 |
|---|---|
| Web | 宿主自己提供（`pinomad link`），中继也提供；现代浏览器都能用 |
| macOS（Apple 芯片） | [GitHub Releases](https://github.com/bubbleptr/pinomad/releases) 上签名过的 DMG，会自动更新 |
| iOS | 目前只在 TestFlight 内部测试 |
| Linux、Windows | 用 Web 客户端 |

## agent 能做什么

工具和 pi 一样是 read、bash、edit、write 四个，另外还有：

| 功能 | 说明 |
|---|---|
| 项目和 worktree | 把一个目录登记成项目。Git 仓库里每个对话在自己的 worktree 和分支上干活，你的检出不会被动到 |
| Fork | 从某条消息分出去，两条线各自往下聊 |
| 子代理 | 把自成一体的任务交给子代理，多个子代理并行执行 |
| 具名 Agent | `<数据目录>/agents/<名字>.md` 里的可复用角色——`subagent` 调用或 `@名字` 提及可以派给它，可选锁定模型和思考等级 |
| 提问代替审批 | 工具执行前不弹审批；方向拿不准时，agent 会提 1–4 个选择题 |
| codemode | 模型写一段 JavaScript，在 QuickJS 沙箱里调用其他工具，只有脚本的输出进入上下文 |
| MCP | 在 `~/.agents/mcp.json` 里配置 server，格式就是常见的 `mcpServers` |
| 图片 | Web / 桌面端输入框可粘贴、拖入、从 "+" 菜单选图，一条最多 4 张，发送前缩放并转成 JPEG |
| AGENTS.md 和 skills | 每次请求都会读 `~/.agents` 和项目里的 `AGENTS.md` / `CLAUDE.md` 与 skills |

细节和 MCP 配置说明见[使用说明](docs/usage.md)。

## 文档

以下文档都是中文。

| 文档 | 内容 |
|---|---|
| [使用说明](docs/usage.md) | 项目、worktree、工具、MCP 配置 |
| [远程访问](docs/remote-access.md) | 配对、隧道、自部署中继（VPS 或容器平台） |
| [常驻运行](docs/service.md) | `service` 和 `upgrade` 命令，各平台注意事项 |
| [官网](docs/website.md) | pinomad.si 落地页和 app.pinomad.si 托管实例 |
| [架构概览](docs/architecture.md) | 各部分和语言怎么配合，收发流程图 |
| [架构决策](docs/adr/README.md) | 为什么这样设计 |
| [路线图](docs/roadmap.md) | 做完了什么、接下来做什么 |
| [术语表](GLOSSARY.md) | 领域术语 |

## 参与开发

从源码运行、验证和发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[Apache-2.0](LICENSE)。PiNomad 包含改编自 [Pi](https://github.com/earendil-works/pi)（MIT）和其他项目的代码，它们的许可声明在 [`docs/licenses/`](docs/licenses/)。
