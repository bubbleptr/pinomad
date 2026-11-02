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

1. **注册账号**：在 [app.pinomad.si](https://app.pinomad.si/) 注册（要邀请码）。
2. **加入宿主**：在要跑 agent 的机器（macOS 或 Linux）上运行下面两行。`pinomad up` 会打印一个短码，在它打开的网页上登录并输入短码，宿主就加入了账号，之后作为服务常驻运行。

   ```sh
   curl -fsSL https://pinomad.si/install.sh | sh
   pinomad up
   ```

   已经用 npm 装过？脚本不会动它；先 `pinomad upgrade`，再 `pinomad up`。

3. **在其他设备上登录**（Web、Mac App、iPhone）：它们会自动配对账号下的宿主；然后在 Settings → Providers 里接入模型。

不想用账号（只在一台机器上、局域网或 tailnet、自己架的服务端），见[不用账号](https://pinomad.si/zh/docs/without-account/)。

## 文档

用户文档在 **[pinomad.si/zh/docs](https://pinomad.si/zh/docs/)**：[快速上手](https://pinomad.si/zh/docs/)（账号、加入宿主、设备、推送）、[账号](https://pinomad.si/zh/docs/official-server/)、[不用账号](https://pinomad.si/zh/docs/without-account/)、[agent 能做什么](https://pinomad.si/zh/docs/features/)、[使用说明](https://pinomad.si/zh/docs/usage/)、[远程访问](https://pinomad.si/zh/docs/remote-access/)、[常驻运行](https://pinomad.si/zh/docs/service/)。

开发相关：

| 文档 | 内容 |
|---|---|
| [官网](docs/website.md) | pinomad.si 官网和 app.pinomad.si 托管实例 |
| [架构概览](docs/architecture.md) | 各部分和语言怎么配合，收发流程图 |
| [架构决策](docs/adr/README.md) | 为什么这样设计 |
| [路线图](docs/roadmap.md) | 方向和顺序；具体条目在 GitHub Issues |
| [术语表](GLOSSARY.md) | 领域术语 |

## 参与开发

从源码运行、验证和发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[Apache-2.0](LICENSE)。PiNomad 包含改编自 [Pi](https://github.com/earendil-works/pi)（MIT）和其他项目的代码，它们的许可声明在 [`docs/licenses/`](docs/licenses/)。
