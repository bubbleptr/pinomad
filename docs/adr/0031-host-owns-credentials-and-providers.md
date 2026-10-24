# ADR-0031：凭据和自定义模型存在数据目录，宿主不再读 pi 的任何配置；登录在客户端里完成

- 状态：Accepted
- 日期：2026-10-25
- 取代 ADR-0021 §2（回落到 pi 的 settings.json）和 §5（凭据共用 pi 的 `auth.json`）；补充 ADR-0018（协议 5.21）

## 背景

ADR-0021 让宿主设置进了数据目录，但留下两处和 pi 共用：没设过的设置项回落到 `~/.pi/agent/settings.json`，凭据就是 pi 的 `~/.pi/agent/auth.json`，登录只能在宿主那台机器上跑 Pi CLI。§5 当时写明，等客户端里能登录了再决定凭据要不要分开存。

现在要在设置里做 Providers：订阅登录、API key、自定义 endpoint，任何一台已配对设备都能操作。几个事实：

- pi 的 `ModelRuntime.create()` 接受 `authPath`、`modelsPath`，自带 `login(providerId, type, interaction)`：登录过程是一串 `prompt()`（secret / text / select / manual_code）加 `notify()` 事件（auth_url、device_code、progress、info），每个 provider 自己决定问什么。
- pi-ai 1.2.0 内置 42 个 provider；`models.json` 里定义的自定义 provider 同样带 API key 登录。
- 订阅登录要么让用户在浏览器批准后把 code 贴回来，要么显示 device code 等用户去网站批准，后者可能等好几分钟。
- 客户端断线重连时会拒掉所有挂起的调用（`remote-durable.ts`）。

## 决策

1. **宿主只读数据目录里的文件。** 凭据在 `<数据目录>/auth.json`，自定义 endpoint 在 `<数据目录>/models.json`（沿用 pi 文档里的 schema，可以手改），pi 的模型目录缓存 `models-store.json` 也在这里。设置的回落链改成 PiNomad 的 `settings.json` → pi 的内置默认（`SettingsManager.inMemory()`）。代理、重试、压缩、超时这些 pi harness 设置写在 PiNomad `settings.json` 的 `"pi"` 键下，格式同 pi 的 settings.json，只能手改，启动时读一次。
2. **不迁移。** 升级后原来在 `~/.pi/agent` 里的登录不再生效，在新的 Providers 页面重新登录或填 key。从此在 PiNomad 里登出不再影响本机的 Pi CLI，反过来也一样。
3. **登录在客户端里完成，宿主照着 pi 的提示一步步转发，不维护字段表。** 新的宿主流 `providers` 推两样东西：每个 provider 能用什么方式登录（订阅 / 账号登录 / API key）、存着哪种凭据、是否已由环境变量配置、自定义 endpoint 的配置；以及进行中的登录流程（事件、当前提示、结果）。调用 `beginLogin` 开始，`answerLogin` 按提示 id 回答（过期的 id 拒绝，不会落到下一个提示上），`cancelLogin` 中止。一个 provider 同时只有一个进行中的登录；没人回应的登录 15 分钟后宿主自己结束，免得 pi 的回调端口一直被占。答案从不回显到流里。
4. **登录状态走流，不走挂起的调用。** device code 要等几分钟，手机这时换个网络就会断线；放在流里，重新订阅就能接上，也和 `pinomad.question` 的做法一致。流是宿主级的，凭据本来就是宿主级的。
5. **自定义 endpoint：** `saveCustomProvider` 写 `models.json`（保留手改过的条目和字段），key 走该 provider 自己的 API key 登录存进 `auth.json`，不写进 `models.json`；`removeCustomProvider` 两处一起删。id 不能和内置 provider 重名。`listEndpointModels` 由宿主去请求 endpoint 的 `/models`，因为 endpoint 常常只有宿主那台机器连得到。
6. **ChatGPT 登录要的安装 id** 存在 `<数据目录>/install-id`（首次用到时生成的 UUID）。
7. **宿主不再监视 `auth.json`**：宿主是唯一写入方，每次调用后直接重新推送（和 ADR-0021 §4 同理）。
8. 都是新增，按 ADR-0018 涨到 5.21；`auth` 流和 `logout` 保留给旧客户端。

## 考虑过的方案

- **首次启动时从 `~/.pi/agent` 复制一次**：升级无感，但宿主要一直留着读 pi 路径的代码，"只读自己的文件"就不成立了。
- **另给一个 `pinomad import-pi` 命令**：显式可控，但多一个要维护的子命令，换来的只是省掉一次重新登录。
- **登录用一个长时间挂起的调用**：实现最简单，但断线时挂起的调用会被拒掉，等 device code 批准的过程正好最容易遇到断线。
- **为每个 provider 维护一张 API key 字段表**，好在一个表单里一次填完：Cloudflare、Vertex、Bedrock 能一屏填完，但 pi 每新增或改动一个 provider 都得跟着改，"把 provider 补全"就变成一直追不上。现在多字段的 provider 是同一个表单里逐步出现的两三步。

## 后果

- 宿主升级后所有现有登录都要重来一遍；发布说明要写清楚。
- Pi CLI 和 PiNomad 的模型配置彻底分开：同一台机器上两边各登各的。
- pi 新增的 provider 不改 PiNomad 也能在客户端里登录；客户端只需为新 provider 补 logo，没有 logo 时显示首字母。
- iOS 客户端的 Providers 界面另做（Rust core 已同步 5.21 的流和调用，FFI 外观层到时再加）。
