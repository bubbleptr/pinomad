# ADR 索引

ADR 只记录同时满足三条的决策：难以回退、没有上下文会让人意外、确实有过取舍。分期计划和待办放在 [路线图](../roadmap.md)，用法放在仓库根目录的 README，术语放在 `CONTEXT.md`。

已接受的 ADR 不改写决策；被后来的 ADR 取代或补全时，在原文标注并在这里记录。

## 产品定位

| ADR | 一句话 |
| --- | --- |
| [0001](0001-own-the-ui-contract.md) | PiNomad 拥有自己的 UI 契约，不兼容 Pi CLI 的扩展、配置和会话格式 |
| [0003](0003-self-hosted-host-remote-clients.md) | 以 coding 为核心：自托管宿主执行，桌面 / Web / 移动端都只是客户端 |
| [0017](0017-client-forms-electron-and-expo.md) | 客户端形态：桌面端 Electron 只做 macOS、页面打包进 App；Linux 用 Web；移动端 Expo；`packages/protocol` 要能在 Hermes 上运行 |
| [0004](0004-built-in-first-plugin-protocol-later.md) | 先内置后开放：内置功能按扩展边界写，满足三个条件才公开插件协议 |

## 运行时与呈现

| ADR | 一句话 |
| --- | --- |
| [0002](0002-pi-durable-as-runtime.md) | 以 Pi Durable 的 Harness 为内核，Durable 存储是唯一事实来源 |
| [0005](0005-structured-presentation-types.md) | 插件状态通过带运行时 schema 的展示类型呈现，不符合时兜底渲染 |
| [0014](0014-web-client-adopts-pace-design-system.md) | Web 客户端整套采用 Pace 的视觉基础（Tailwind v4、token 桥、Montserrat、Hugeicons），搬界面不搬数据模型 |

## 宿主能力与工作组织

| ADR | 一句话 |
| --- | --- |
| [0006](0006-host-tools-and-context-sources.md) | 宿主默认提供编码工具、默认不审批，上下文只从项目和 `~/.agents` 读取 |
| [0007](0007-projects-and-conversations.md) | 工作组织是"项目 → 对话"，不用 channel；归档代替删除 |
| [0010](0010-worktree-execution-checkout.md) | Git 项目的对话默认在数据目录下的独立 worktree 里工作（fork 部分由 0019 修订） |
| [0011](0011-ask-user-question-replaces-approval.md) | 不做审批闸门；agent 用阻塞式的结构化提问和用户对齐，取代 `pinomad.approval` |
| [0012](0012-mcp-host-level-connections.md) | MCP 只读 `~/.agents/mcp.json`，宿主级连接所有对话共用，工具直接声明，状态经 `mcp` 流推给客户端 |
| [0013](0013-codemode-and-tool-exposure.md) | codemode 是默认开启的通用工具；工具按 `direct` / `model-only` / `codemode` 暴露，和来源正交，MCP 默认 `codemode` |
| [0019](0019-fork-shares-parent-checkout.md) | fork 共用父对话的检出，要隔离由 agent 自己用 git 开 worktree；只有一层，每条消息最多一个 |

## 远程与运维

| ADR | 一句话 |
| --- | --- |
| [0008](0008-remote-access-pairing-and-secure-channel.md) | 远程访问：协议层 Noise 端到端加密、扫码配对、中继分期 |
| [0009](0009-host-lifecycle.md) | 宿主作为用户级系统服务常驻，源码检出升级，等空闲重启 |
| [0015](0015-relay-splicing-and-host-registration.md) | 自部署中继按设备连接拼接 WebSocket，宿主用独立 Ed25519 密钥签名登记，中继用 HTTPS 提供 Web 客户端 |
| [0016](0016-npm-single-package-distribution.md) | 分发：单个 npm 包 `pinomad`（宿主+中继+Web 客户端打包成 JS bundle，第三方依赖外置），tag 触发 GitHub Actions 发布 |
| [0020](0020-desktop-connects-as-paired-device.md) | 桌面端连任何宿主都作为已配对设备走安全通道，不读 token；回环端口在 `/secure` 上也接受安全通道；桌面端和 npm 包共用版本号 |
| [0018](0018-protocol-compatibility.md) | 协议兼容：hello 带 `{ major, minor }`，同一主版本内只增不删；两端对不认识的内容回错误或忽略，不断开；上游数据结构靠契约快照盯着；宿主只支持当前主版本 |

## 遗留项的去向

| 原 ADR 中的遗留项 | 现状 |
| --- | --- |
| 0003：远程访问怎么认证、加密 | 已由 0008 决定 |
| 0003：宿主生命周期 | 已由 0009 决定 |
| 0003：会话、项目、执行检出和 Durable 对话怎么对应 | 已由 0007 决定 |
| 0007：worktree 执行检出、fork 时检出怎么处理 | 已由 0010 决定 |
| 0006：做远程访问前先定认证和审批策略 | 认证已由 0008 决定；审批闸门由 0011 决定不做 |
| 0005：`pinomad.approval` | 由 0011 换成 `pinomad.question` |
| 0012 §5：MCP 工具直接声明，codemode 以后再说 | 由 0013 取代：MCP 默认 `codemode` 暴露 |
| 0009 §2 安装方式、§6 升级命令 | 由 0016 修订：分发改为 npm 包，打包安装升级走 `npm i -g`；源码检出仍是开发路径 |
| 0009 §8 协议版本严格相等 | 由 0018 修订：主版本相等即可连接，次版本号用来决定用哪些功能 |
| 0008 后果：移动端形态（PWA 还是 Expo）、浏览器客户端代码可信 | 由 0017 决定：移动端 Expo，桌面端和移动端都打包代码 |
| 0008 §7：回环地址只用 token | 由 0020 补充：回环端口在 `/secure` 上也接受安全通道，桌面端只走安全通道 |
| 0010 §4：fork 得到新 worktree 和快照 | 由 0019 修订：fork 共用父对话的检出，只有一层，每条消息最多一个 |
| 其余"以后再做" | 统一收在[路线图](../roadmap.md) |
