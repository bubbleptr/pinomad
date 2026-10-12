# ADR-0021：宿主设置存在数据目录的 `settings.json`，不写 pi 的设置；凭据暂时仍共用 pi

- 状态：Accepted
- 日期：2026-10-12

## 背景

ADR-0006 让宿主复用 pi 的两类设施：`~/.pi/agent` 下的模型认证，以及 pi 的 settings.json（默认模型、思考等级、steering / follow-up 模式、重试、压缩、代理），并把"PiNomad 要不要有自己的设置文件"留到做设置界面时决定。现在要做设置界面：宿主设置（见 `GLOSSARY.md`）要能从任意一台设备修改，并实时推给其他在线设备。

几个现状：

- 宿主启动时用 `SettingsManager.create(process.cwd())` 读一次 pi 的设置，PiNomad 从不写；要改只能手改文件再重启宿主。
- pi 的 `SettingsManager` 自带写入方法，写的是 `~/.pi/agent/settings.json`，同一台机器上的 Pi CLI 也读写这个文件。
- 订阅只能在 Pi CLI 里登录，凭据在 `~/.pi/agent/auth.json`。
- Durable 存储（数据目录下的 `session.sqlite`）的上游标注为 Experimental（ADR-0002 §4）。数据目录里另有 `token`、`host-key`、`relay-key` 等独立文件。

## 决策

1. **宿主设置存在数据目录下的 `settings.json`**（默认 `~/.pinomad/settings.json`，跟着 `--data-dir` / `PINOMAD_DATA_DIR` 走），由 PiNomad 写入，不写 pi 的 settings.json。和 ADR-0001 一致：PiNomad 不追求和 Pi CLI 的配置保持一致。
2. **没设过的项按顺序回落**：PiNomad 的 `settings.json` → pi 的 settings.json → 内置默认。设过之后只以 PiNomad 的为准。已有安装升级后行为不变。
3. **不放进 Durable**：设置不是对话、文档、任务这类运行事实，不在 ADR-0002 §2 的范围里；不把它绑在实验性包的存储格式上；宿主因为设置写错起不来时，能直接手改文件。
4. **宿主不监视自己的 `settings.json`**：一个数据目录同时只有一个宿主进程（目录锁），宿主是唯一写入方。宿主运行时手改不会生效，下一次从客户端修改还会覆盖它；要手改先停宿主。
5. **凭据第一版仍共用 pi 的 `~/.pi/agent/auth.json`**（ADR-0002 §3、ADR-0006）：现在只能在 Pi CLI 里登录，PiNomad 另存一份就登不上。宿主监视 `auth.json`，Pi CLI 里登录或退出后重新加载并推给客户端。代价是在 PiNomad 里 log out 也会让 Pi CLI 退出。客户端内登录做出来时，再决定凭据要不要分开存。
6. **宿主设置、订阅状态、模型列表各是一条宿主流**（`settings`、`auth`、`models`），推完整快照；修改设置、log out 是调用。都是新增，按 ADR-0018 涨次版本号；`hello.models`、`hello.defaults` 保留给旧客户端。

## 考虑过的方案

- **写 pi 的 settings.json**：不用迁移，PiNomad 和 Pi CLI 的默认值始终一致。但两边会互相覆盖，PiNomad 的设置受制于 pi 的 schema，PiNomad 独有的设置还得另找地方存。
- **存进 Durable 的 session 级文档**（照 `pinomad.devices`）：推送现成，和其他宿主状态在同一个文件里备份。但设置会绑在实验性的存储格式上，出问题时也不能手改。
- **凭据也由 PiNomad 自己存**：和 Pi CLI 完全解耦。但客户端里还不能登录，现在这样做等于没法登录。

## 后果

- 补全 ADR-0006 的遗留项。
- 客户端偏好不在宿主上，各端存在设备本地，不在本 ADR 范围内。
- 两台宿主之间的设置不同步；要同步得等账号（路线图 M3 的长期项）。
- 备份数据目录时多一个文件；宿主设置和 `session.sqlite` 可以分开恢复。
