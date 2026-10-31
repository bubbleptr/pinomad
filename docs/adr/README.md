# ADR 索引

ADR 只记录同时满足三条的决策：难以回退、没有上下文会让人意外、确实有过取舍。分期计划和待办放在 GitHub Issues（方向和顺序见[路线图](../roadmap.md)），用法放在官网文档（源文件在 `apps/site/content/docs/`，发布在 pinomad.si/docs），术语放在 `GLOSSARY.md`。

已接受的 ADR 不改写决策；被后来的 ADR 取代或补全时，在原文标注并在这里记录。

## 产品定位

| ADR | 一句话 |
| --- | --- |
| [0001](0001-own-the-ui-contract.md) | PiNomad 拥有自己的 UI 契约，不兼容 Pi CLI 的扩展、配置和会话格式 |
| [0003](0003-self-hosted-host-remote-clients.md) | 以 coding 为核心：自托管宿主执行，桌面 / Web / 移动端都只是客户端 |
| [0017](0017-client-forms-electron-and-expo.md) | 客户端形态：桌面端 Electron 只做 macOS、页面打包进 App；Linux 用 Web；移动端 Expo；`packages/protocol` 要能在 Hermes 上运行（§3、§4 由 0024 取代；§4 已于 2026-10-19 随 `apps/mobile` 删除失效） |
| [0024](0024-native-mobile-rust-core.md) | 移动端改成原生（iOS SwiftUI，以后安卓 Compose），客户端协议核心用 Rust 写一份两端共用；核心不做 I/O，流状态是保留 UTF-16 的完整 JSON；TS 是参照，三层测试对齐 |
| [0004](0004-built-in-first-plugin-protocol-later.md) | 先内置后开放：内置功能按扩展边界写，满足三个条件才公开插件协议 |

## 运行时与呈现

| ADR | 一句话 |
| --- | --- |
| [0002](0002-pi-durable-as-runtime.md) | 以 Pi Durable 的 Harness 为内核，Durable 存储是唯一事实来源 |
| [0005](0005-structured-presentation-types.md) | 插件状态通过带运行时 schema 的展示类型呈现，不符合时兜底渲染 |
| [0014](0014-web-client-adopts-pace-design-system.md) | Web 客户端整套采用 Pace 的视觉基础（Tailwind v4、token 桥、Hugeicons；字体后来换成系统字体），搬界面不搬数据模型（思维链组件由 0026 修订） |
| [0026](0026-run-process-folds-out-of-transcript.md) | 运行过程在对话里收成一行：Web / 桌面按插话分段成灰色摘要行、原地展开，iOS 每次运行一颗胶囊加 sheet；todo 跟在最新一次运行后面；不加提示词凑插话和 todo |
| [0034](0034-submission-delivery-and-recovery.md) | 提交的送达状态与断线恢复：只读 `submission` 查询、宿主在预处理前按 `requestId` 去重、`submit` 结果带 `entry`；重连后先查询再决定是否重发，是“断线不重放”的窄例外，“未确认”不等于失败 |

## 宿主能力与工作组织

| ADR | 一句话 |
| --- | --- |
| [0006](0006-host-tools-and-context-sources.md) | 宿主默认提供编码工具、默认不审批，上下文只从项目和 `~/.agents` 读取 |
| [0007](0007-projects-and-conversations.md) | 工作组织是"项目 → 对话"，不用 channel；归档代替删除（多宿主分组由 0035 补充） |
| [0010](0010-worktree-execution-checkout.md) | Git 项目的对话默认在数据目录下的独立 worktree 里工作（fork 部分由 0019 修订） |
| [0011](0011-ask-user-question-replaces-approval.md) | 不做审批闸门；agent 用阻塞式的结构化提问和用户对齐，取代 `pinomad.approval` |
| [0012](0012-mcp-host-level-connections.md) | MCP 只读 `~/.agents/mcp.json`，宿主级连接所有对话共用，工具直接声明，状态经 `mcp` 流推给客户端 |
| [0013](0013-codemode-and-tool-exposure.md) | codemode 是默认开启的通用工具；工具按 `direct` / `model-only` / `codemode` 暴露，和来源正交，MCP 默认 `codemode` |
| [0019](0019-fork-shares-parent-checkout.md) | fork 共用父对话的检出，要隔离由 agent 自己用 git 开 worktree；只有一层，每条消息最多一个 |
| [0021](0021-host-settings-in-data-dir.md) | 宿主设置存在数据目录的 `settings.json`，不写 pi 的设置、不进 Durable（§2 回落、§5 凭据共用由 0031 取代） |
| [0023](0023-agent-roles.md) | 具名 Agent 是数据目录 `agents/` 下的 Markdown 文件，只有宿主级、客户端可编辑；子代理、`@` 提及、顶层对话都能用；子代理上锁定模型，顶层对话只定初始值；用时抄一份，出错不回落 |
| [0028](0028-host-expands-explicit-skill-mentions.md) | 只有从 `$` 菜单选中的 skill 算调用（`submit` / `createConversation` 的 `skills`，5.16；旧客户端按文本匹配），宿主按 pi 的 `/skill:` 格式把全文拼在 `pi.user` 消息前面，客户端显示时剥掉并给出展开了哪些；`disable-model-invocation` 只从提示词列表里去掉 |
| [0029](0029-host-declared-slash-commands.md) | 斜杠命令由宿主声明（协议 5.17 `listCommands` / `runCommand`），客户端不写死命令表；只在消息开头识别 `/<已列出的名字>`；第一期只有内置 `/compact` |
| [0030](0030-attach-files.md) | 输入框的 Attach files 把客户端本机文件分块上传到宿主 `attachments/`，发送时只传宿主生成的 id（5.19）；`used` 永久保留，清理与 submit 共用锁；模型看到转义后的 v1 `<attachments>` 块，客户端只在用户条目和排队输入里剥离 |
| [0031](0031-host-owns-credentials-and-providers.md) | 凭据和自定义模型存在数据目录，宿主不再读 pi 的任何配置、不迁移；登录在客户端完成，宿主照 pi 的提示转发，进行中的登录经 `providers` 流推送（5.21） |

## 远程与运维

| ADR | 一句话 |
| --- | --- |
| [0008](0008-remote-access-pairing-and-secure-channel.md) | 远程访问：协议层 Noise 端到端加密、扫码配对、中继分期 |
| [0009](0009-host-lifecycle.md) | 宿主作为用户级系统服务常驻，源码检出升级，等空闲重启 |
| [0015](0015-relay-splicing-and-host-registration.md) | 自部署中继按设备连接拼接 WebSocket，宿主用独立 Ed25519 密钥签名登记，中继用 HTTPS 提供 Web 客户端 |
| [0016](0016-npm-single-package-distribution.md) | 分发：单个 npm 包 `pinomad`（宿主+中继+Web 客户端打包成 JS bundle，第三方依赖外置），tag 触发 GitHub Actions 发布 |
| [0020](0020-desktop-connects-as-paired-device.md) | 桌面端连任何宿主都作为已配对设备走安全通道，不读 token；回环端口在 `/secure` 上也接受安全通道；桌面端、iOS 和 npm 包共用版本号 |
| [0018](0018-protocol-compatibility.md) | 协议兼容：hello 带 `{ major, minor }`，同一主版本内只增不删；两端对不认识的内容回错误或忽略，不断开；上游数据结构靠契约快照盯着；宿主只支持当前主版本 |
| [0025](0025-push-via-server-apns.md) | 推送直连 APNs，按环境分开的密钥只放在服务端；宿主经控制连接请服务端发，服务端只转发不保存；开放注册前要先让服务端核对 token 归属（§5 由 0036 修订） |
| [0036](0036-server-checks-push-token-ownership.md) | 设备登录后向服务端登记推送 token，服务端记下它属于哪个账号，推送时核对和发起宿主同一账号；不引入句柄，协议不变；没登录账号的设备没有推送 |
| [0037](0037-account-devices-and-remote-revocation.md) | 账号设备：客户端登录时带本机生成的设备 ID，服务端记下它经账号进了哪些宿主（宿主报告公钥），账号页可以一键请所有宿主吊销；宿主仍是最终裁决的一方，老宿主上只能在宿主上吊销 |
| [0027](0027-image-refs-on-the-wire.md) | 图片在线上按内容引用传：订阅时声明 `images: "ref"`，快照和 ops 里只带绑定类型和字节的 sha256 引用，字节用 `image` 调用按当前视图取，发送时可回传引用；存储仍内联在 SQLite |
| [0022](0022-server-accounts-and-vouching.md) | 宿主、客户端、服务端三个部分：账号在服务端（凭管理员发的邀请码注册，#449），宿主用 `pinomad join` 加入账号，服务端为新设备向宿主要邀请担保；信任服务端，Noise 防被动泄露，吊销仍在宿主上（§6 广播由 0035 修订，§8 由 0035 补充） |
| [0032](0032-multi-endpoint-pairing-and-failover.md) | 远程访问携带多候选：配对邀请和 hello 发布 remote endpoint 集合，loopback 保持 client-local，Auto relay 优先、direct 兜底，候选级失败、整轮汇总，paired 与 ready 分离；不做服务端地址目录 |
| [0033](0033-webrtc-p2p-and-signal-connections.md) | WebRTC DataChannel 作为第四种载体：独立信令 prologue、非 trickle 宿主作答、按库区分"已接收"的载体契约、简化切换（不回退双业务状态），不引入 TURN 和服务端信令接口；移动端锁 str0m |
| [0035](0035-multi-host-clients.md) | 客户端同时连接所有已配对宿主：全局 `{ hostKey, conversationId }` 引用、单一聚焦（失焦释放对话订阅）、每台宿主独立运行时与三维状态、带 `declined` 的自动登记、按可见对话压制通知；去掉账号设备加入广播 |

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
| 0006 §4：PiNomad 要不要有自己的设置文件 | 由 0021 决定：宿主设置存在数据目录的 `settings.json`，没设过的项回落到 pi 的设置 |
| 0021 §2 回落到 pi 的设置、§5 凭据共用 pi 的 `auth.json` | 由 0031 取代：只读数据目录里的文件，回落到 pi 的内置默认；凭据在数据目录，登录在客户端完成，不迁移 |
| 0003：只有宿主和客户端两个部分 | 由 0022 补充：加入服务端 |
| 0008 §1、§3：中继只看到密文，配对只靠宿主出示的邀请；§9 第三期官方中继 | 由 0022 修订：服务端转发的只有密文，但能为新设备担保（经宿主控制连接要邀请）；官方实例和自部署是同一份服务端 |
| 0015 §3：`--allow-host` 白名单，中继不持久化 | 由 0022 取代：账号绑定宿主，服务端有数据目录 |
| 0017 §3 移动端用 Expo、§4 `packages/protocol` 要能在 Hermes 上运行 | 由 0024 取代：移动端原生，客户端协议核心用 Rust；§4 已于 2026-10-19 随 `apps/mobile` 删除失效 |
| 0008 §9 推送经 Expo（路线图 M5） | 由 0024、0025 修订：直连 APNs，密钥只放在服务端，宿主经控制连接请服务端发 |
| 0024 §10：替换验收清单"放在 roadmap" | 计划改在 GitHub Issues 后，清单在 #133（iOS 原生替换 milestone） |
| 0024 §5：每次交付整份快照还是只交付变化 | 由 0027 补充图片部分：线上按内容引用传，字节按需取；文字部分仍按实测决定 |
| 0015 后果：二维码里只有一个连接地址，局域网和中继两个候选地址自动选择留到以后 | 由 0032 补全：邀请携带完整候选，Auto relay 优先、direct 兜底；loopback 保持 client-local |
| 0020 §4：配对链接选能到达最远的地址 | 由 0032 修订：链接携带候选，Auto 按 loopback / relay / direct 顺序串行尝试 |
| 0018 §4：单地址下的关闭码规则 | 由 0032 补充多候选作用域：错误只终止当前候选，整轮失败才汇总；只有经认证的协议主版本不兼容全局终止 |
| 0022 §4：账号 Pair 向宿主要一份邀请 | 由 0032 补充：邀请和配对响应 additive 携带候选，服务端只转发、不持久化 endpoint |
| 0014 §2：复制来的组件尽量原样保留，便于对照 Pace 同步 | 由 0026 修订：思维链组件改成运行过程收成一行，和 Pace 分叉 |
| 0006 §4：Skills 只进系统提示词；#143 的 `$name` 靠提示词规则让模型自己读 | 由 0028 补充：从 `$` 菜单选中的 skill 由宿主把全文展开进消息，提示词规则删掉；`disable-model-invocation` 只从提示词列表去掉 |
| 0032 §3：长期 WebRTC 的并行建连由 #345 另定 | 由 0033 决定：WebRTC DataChannel 作为第四种载体，宿主作答、客户端 offer；协调器在 #345 后续 PR |
| 0008 §1：安全通道的传输只有 WebSocket | 由 0033 补充 DataChannel 载体和只走信令的 Noise 连接 |
| 0024 §3：平台层职责 | 由 0033 补充 WebRTC 载体：Node 宿主用 node-datachannel，iOS 用 str0m |
| 0016：原生依赖的可选包分发 | 由 0033 补充：node-datachannel 的平台包走 optionalDependencies，`--omit=optional` 时宿主降级为无 `hello.rtc` |
| 0007 §1：工作组织是"项目 → 对话" | 由 0035 补充：客户端在"项目 → 对话"上面加一层宿主，按已配对宿主顺序分组，对话用 `{ hostKey, conversationId }` 标识 |
| 0022 §6：新设备经账号加入时向所有在线设备广播提示 | 由 0035 修订：不再广播，只在宿主的设备列表里实时显示并标出"账号"来源 |
| 0022 §8、后果：多宿主由客户端汇总，客户端同时连多台宿主 | 由 0035 决定：同时连接所有已配对宿主、单一聚焦释放非聚焦对话订阅、每台宿主独立运行时、带 `declined` 的自动登记 |
| 0022 §6、后果：吊销只在宿主上；账号层面一键踢设备留到以后 | 由 0037 补充：服务端记下账号设备和它在各宿主上的公钥，可以请宿主吊销，宿主仍是最终裁决的一方 |
| 0025 §5：服务端只转发、不存 token；后果：开放注册前要核对 token 归属 | 由 0036 决定：设备登录后向服务端登记 token，服务端存 token 和所属账号，推送时核对；不用句柄 |
| 0025 考虑过的方案：扫码配对的设备不一定登录过账号，所以不让设备向服务端登记 | 由 0036 修订：推送要求设备登录宿主所在的账号 |
| 其余"以后再做" | 统一收在 GitHub Issues，带 `later` 标签 |
