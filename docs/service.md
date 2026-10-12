# 常驻运行（ADR-0009）

从 README 移来。安装和快速上手见 [README](../README.zh-CN.md)。

把宿主装成当前用户的系统服务（macOS 是 LaunchAgent，Linux 是 systemd 用户单元），开机自启、崩溃自动拉起（从源码检出跑时用 `bun run service -- …`，下同）：

```sh
pinomad service install [--data-dir DIR --port N --remote-port N --relay URL --project DIR …]
pinomad service status [--data-dir D] [--url U]
pinomad service restart [--force] [--data-dir D] [--url U]
pinomad service logs [--follow] [-n N] [--data-dir D]
pinomad service uninstall
pinomad upgrade [--force]
```

- `install` 把宿主参数原样写进服务定义；`--data-dir`（或 `PINOMAD_DATA_DIR`，默认 `~/.pinomad`）展开成显式的绝对路径。改参数就是带新参数再跑一次 `install`。装好后用 `pinomad link` 拿本机浏览器链接、`pinomad pair` 发手机配对码。
- **PATH 在安装时固定**：服务里 agent 的 bash 继承的是安装那一刻终端的 PATH（已经剥掉 `node_modules/.bin` 和 Bun 注入的临时目录）。后来装了新工具、PATH 变了，重新跑一次 `install` 刷新。
- `restart` 先连上宿主读任务图，有未结束的任务就等它们跑完再重启（Ctrl-C 取消）；`--force` 立即重启，交给 Durable 恢复。打包安装时 `upgrade` 把 `pinomad@latest` 装进运行包所在的 npm 全局前缀（非全局安装会拒绝执行）+ 同样的 restart；源码检出里（`bun run upgrade`）依次 `git pull --ff-only`、`bun install`、`bun run build`，工作区有未提交改动时拒绝执行。前面任何一步失败都直接停下，不重启，服务继续跑旧代码。
- `uninstall` 只卸载服务，不动数据目录。
- macOS：宿主以登录会话运行，机器重启后要能自动起来需在系统设置里打开自动登录，并为这台机器关掉睡眠。日志写到 `<数据目录>/logs/host.log`。
- Linux：要在未登录时也运行需自己执行 `loginctl enable-linger`（install 检测到没开会提示）；日志走 `journalctl --user`。开着 ufw 时，局域网设备访问 `--remote-port` 要先放行，比如 `sudo ufw allow from 192.168.0.0/24 to any port 7422 proto tcp`（只走中继就不用开）。
- **服务绑定安装时的 node 路径**：单元里写的是 node 和包的绝对路径。用 mise / nvm 管理 Node 时，路径里带着具体版本号（`…/node/26.8.2/…`）；换了 Node 版本、旧目录被删后服务就起不来，要用新版本重新 `npm i -g pinomad`，再跑一次 `pinomad service install …`。`pinomad upgrade` 只升 pinomad，装回原来的前缀，不受影响。
- 服务模式下**回环端口也用 HTTP 提供构建好的 Web 客户端**。npm 安装时 `pinomad link` 总是指向宿主自己提供的 Web；源码检出里按顺序探测：正在跑的 vite 开发服务器（5199）优先，否则宿主提供 Web 的端口，都没有则仍是 5199。开发时 `bun run start` + vite 照旧。
- 服务在跑时 `bun run start` 会因为目录锁拿不到而失败（同一数据目录只有一个宿主）；开发时用另一个 `--data-dir`，或先 `uninstall`。

Windows 不在支持范围；其他平台跑 `service` 会直接报错退出。
