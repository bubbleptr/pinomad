# 远程访问（ADR-0008）

从 README 移来。安装和快速上手见 [README](../README.zh-CN.md)。

一条命令起全部（构建 Web、起宿主、起 vite），并在终端打印电脑浏览器链接和手机配对二维码：

```sh
bun run start
# 透传宿主参数：bun run start -- --faux "hi" --data-dir /tmp/demo
```

手机扫二维码即完成配对（Noise IK 端到端加密 + 设备登记）；二维码是一次性的，5 分钟过期，过期后用 `bun run pair` 重发一个。已登记的设备和吊销在 Web 侧栏的 Devices 里管理；吊销设备也可以在那直接点 Revoke。

<details><summary>手动/高级：分开跑各个进程</summary>

默认只监听 `127.0.0.1`。`--remote-port N` 另起一个监听所有网卡的安全通道端口，同端口用 HTTP 提供构建好的 Web 客户端（`apps/web/dist`，缺失时页面是 503）：

```sh
bun run build
bun run host -- --remote-port 7422
bun run web          # 电脑上的开发服务器 http://127.0.0.1:5199
bun run link         # 打印带 token 的浏览器链接
bun run pair         # 打印配对二维码（一次性，5 分钟过期）
# 走隧道/自建入口，或 LAN 地址探测选错网卡时用 --public-url 覆盖：
bun run host -- --remote-port 7422 --public-url https://pinomad.example.com
```

远程端口不接受 token：只有完成配对、公钥已登记在设备表里的客户端能连。不开 `--remote-port` / `--relay` 时 `pair` 打印的是回环链接（回环端口 `/secure` 路径上的安全通道），只能给本机上的客户端用，比如桌面端 App。桌面端 App 可以配对多台宿主，在侧栏底部切换（一次只连一台）。App 会自动检查更新（GitHub Release 上的 `latest-mac.yml`，自动下载、不自动安装），下载完成后侧栏底部出现 "Restart to update"，也可以在菜单里手动 Check for Updates…。

</details>

## 经自部署中继访问

宿主在家里局域网、手机在外面时，把中继跑在一台有公网地址的 VPS 上：宿主和手机都只往外连中继，中继按宿主身份把两端的连接接起来，只转发密文、不存东西；Web 客户端也由中继用 HTTPS 提供，手机扫二维码直接打开。

宿主这边：先打印中继身份（Ed25519 公钥，存在 `<dataDir>/relay-key`）：

```sh
pinomad relay-id [--data-dir DIR]        # 输出 hostId，把它加进中继的 --allow-host
pinomad host --relay https://relay.example.com
# 常驻：pinomad service install --relay https://relay.example.com
pinomad pair                             # 打出的二维码指向中继
```

VPS 这边：同一个包（只要 Node 25+）——中继和 Web 客户端来自同一个 `pinomad` 安装，版本天然一致：

```sh
npm i -g pinomad
pinomad relay --public-origin https://relay.example.com --allow-host <hostId>
# 默认只监听 127.0.0.1:7430，--port / --listen 可改；多台宿主就写多个 --allow-host
```

Caddy 终止 TLS（自动签证书，WebSocket 无需额外配置）：

```
relay.example.com {
  reverse_proxy 127.0.0.1:7430
}
```

systemd 单元示例（VPS 上的系统级单元；node 和包路径都用绝对路径，`command -v node` 和 `npm root -g` 查）：

```ini
[Unit]
Description=PiNomad relay
After=network-online.target

[Service]
User=pinomad
ExecStart=/usr/bin/node /usr/lib/node_modules/pinomad/dist/pinomad.js relay --public-origin https://relay.example.com --allow-host <hostId>
Restart=always

[Install]
WantedBy=multi-user.target
```

### 容器平台（Zeabur 等）

镜像在 `deploy/relay/Dockerfile`，装的是锁版本的 npm 发布包（`ARG PINOMAD_VERSION`）。平台终结 TLS 并转发到 `$PORT`（默认 8080），不需要 Caddy。中继把转接状态放在内存里，**只能跑一个实例**，不要开扩容。

| 环境变量 | 含义 |
|---|---|
| `PINOMAD_PUBLIC_ORIGIN` | 客户端打开的 https origin，比如 `https://nomad.example.com` |
| `PINOMAD_ALLOW_HOST` | 允许登记的 hostId，多个用空格分隔（每台宿主上跑 `pinomad relay-id`） |
| `ZBPACK_DOCKERFILE_PATH=Dockerfile` | **Zeabur 必加**：目录里只有一个 Dockerfile 时，Zeabur 会把它识别成静态站点、用 Caddy 托管文件，中继根本没启动；这个变量强制按 Dockerfile 构建（部署日志里应是 `PLANTYPE=docker`） |

Zeabur 上的步骤（在 Dedicated Server 上部署，用 CLI 上传目录，不接 GitHub）：

```sh
cd deploy/relay
zeabur deploy --project-id <项目 id> --create --name pinomad-relay   # 首次：在项目里建出服务
# 之后重新部署同一个服务：
zeabur deploy --service-id <服务 id>
```

然后在服务上配好上面的环境变量（`PORT` 由平台注入，不用自己设），在 Domains 里绑定自定义域名，到 DNS 加一条记录：Dedicated Server 用 **A 记录指向服务器 IP**；Cloudflare 上建议**关掉代理（灰云）**，橙云会让国内访问多绕一圈，证书也由 Zeabur 自己签。域名状态变成 `PROVISIONED` 后，验证：

```sh
curl -sI https://nomad.example.com/          # 200，中继托管的 Web 客户端
pinomad service install --relay https://nomad.example.com …   # 宿主接上中继
```

宿主登记成功会在日志里写一行 `{"event":"relay","status":"registered",…}`，掉线重连时写 `"status":"connecting"`（`pinomad service logs` 查看）；也可以从外面连设备入口 `wss://<origin>/c/<hostId>` 确认：宿主在线时连接保持打开（等握手），没登记会立刻以 `4604`（hostOffline）关闭。

也可以从 GitHub 仓库部署：Root Directory 设 `deploy/relay`、Watch Paths 限 `deploy/relay/**`，其余同上。

### 服务端账号（ADR-0022）

只给 `--allow-host` 时服务端维持老行为：纯白名单、什么都不存。要开账号，给它一个数据目录（`--data-dir`，或环境变量 `PINOMAD_SERVER_DATA_DIR`，默认 `~/.pinomad-server`），首次启动时用两个环境变量建出唯一用户：

```sh
export PINOMAD_SERVER_USER=<用户名>
export PINOMAD_SERVER_PASSWORD=<至少 12 位，建议密码管理器生成>
pinomad relay --public-origin https://relay.example.com --data-dir /var/lib/pinomad-server --trust-proxy
```

- 两个变量缺一个、或密码不到 12 位，启动直接报错；users 表已有用户后启动不再需要它们。数据目录和宿主一样一个目录只允许一个进程，容器平台部署要挂持久卷。
- 账号 API 和控制连接只走 HTTPS/WSS，明文只留给 localhost 开发。前面有反向代理（Caddy、Zeabur）时必须加 `--trust-proxy`：服务端据此信任 `X-Forwarded-Proto` 判定请求是否来自 https，并取 `X-Forwarded-For` 做按 IP 限速；不加的话，经过代理进来的请求会被当成不可信的明文连接拒绝（`/api/*` 回 403，`/host` 升级回 403），限速也只看到代理的地址。
- 老部署不设账号变量、只给 `--allow-host` 时行为不变，两种准入可以并存（迁移期间白名单继续生效）。
- 改密码用 `pinomad relay passwd`（要求服务端已停，它和数据目录锁互斥），新密码从 stdin 读：

  ```sh
  printenv NEW_PASSWORD | pinomad relay passwd --data-dir /var/lib/pinomad-server
  ```

  同一个事务里换掉密码哈希、作废所有登录会话和没用掉的 join token；宿主上已登记的设备不受影响。

HTTP API（都在服务端同一端口的 `/api/*` 下）：`POST /api/login`（`{username, password}`，返回 Bearer 令牌并种 `Secure`+`HttpOnly`+`SameSite=Strict` cookie）、`GET /api/me`、`POST /api/logout`、`POST /api/sessions/revoke-all`。会话令牌 30 天固定过期；登录有按 IP 限速、按用户名失败锁定和 scrypt 并发上限，触发回 429。

### 升级

中继托管的 Web 客户端和宿主版本不一致时，客户端会显示需要更新；两边一起升级——宿主 `pinomad upgrade`，VPS 上 `npm i -g pinomad@latest` 后重启中继；容器部署则是改 Dockerfile 里的 `PINOMAD_VERSION`，再在 `deploy/relay` 下重新 `zeabur deploy --service-id <服务 id>`（从 GitHub 部署的话合进 main 即触发）。宿主不在中继的 `--allow-host` 里时，宿主日志和 Web 警告会带着要补的 `--allow-host <hostId>`。

npm 装的实例和本机任何开发检出互不相干（各自的数据目录、进程、包路径都独立），所以在同一台机器上开发 PiNomad 不会碰到正在跑的服务。
