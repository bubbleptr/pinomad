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

#### 宿主加入账号（join / leave）

在已登录的会话里调 `POST /api/join-tokens` 拿一次性令牌（10 分钟有效，只能用一次），然后在要加入的机器上跑：

```sh
npm i -g pinomad            # 已经装好就跳过
pinomad join https://relay.example.com <token> [--name 显示名]
```

`join` 依次做：建好宿主的 Ed25519 登记密钥和 Noise 密钥（已有就复用）；经一条一次性操作连接向服务端登记（这条连接不会顶替正在跑的控制连接）；把服务端地址写进 `<数据目录>/server.json`；然后安装宿主服务——已安装就重写服务定义、去掉旧的 `--relay` 参数——并按 ADR-0009 等空闲重启。输出会打印宿主指纹（hostId）和加入的账号名。令牌响应丢了就重新生成一个再跑一遍，重复 join 同一台宿主是幂等的。

```sh
pinomad leave [--data-dir DIR]
```

`leave` 向服务端解绑这台宿主（服务端会立刻断开它现存的控制连接），删掉本地 `server.json`，重写服务定义去掉 `--relay` 后等空闲重启。服务端不在线时本地文件照样删，但会明确提示服务端的绑定记录没清掉。

`server.json` 和 `--relay` 参数表达同一个东西；宿主启动时两者都给出且不一致会直接报错。对着没开账号的旧服务端跑 `join` 会得到明确报错（先探测 `GET /api/me`），不会误报成功。账号操作只接受 `https://` 地址（本机回环的 `http://` 留给开发），明文会把一次性令牌暴露给链路上的人。

##### 从 `--allow-host` + `--relay` 迁移

1. 服务端升级到有账号的版本，配好 `--data-dir`（挂持久卷）和首次启动的 `PINOMAD_SERVER_USER` / `PINOMAD_SERVER_PASSWORD`；`--allow-host` 先留着，两种准入可以并存。
2. 在每台宿主上 `pinomad join <origin> <token>`。join 会把服务定义里的 `--relay` 摘掉，重启后宿主经账号绑定登记。
3. 确认宿主在线（`pinomad service logs`，或连 `wss://<origin>/c/<hostId>` 看会不会以 4604 关闭）之后，把 `--allow-host` 从服务端参数里删掉。

#### 宿主侧的设备准入

- 登记时记下每台设备的来源（扫码 / 本机回环 / 账号担保）；早期版本登记的设备没有来源标记。
- 吊销会留下持久记录：被吊销的公钥不能经账号担保的邀请重新登记；在宿主上重新扫码配对可以——那是用户的主动动作，同时把该公钥从吊销记录里去掉。
- 宿主设置 `acceptAccountDevices`（默认开，协议 5.8，客户端用 `FEATURE_SINCE` 判断宿主是否认识它）控制是否接受服务端担保的设备；关掉后还没用掉的账号邀请立即作废。`pinomad leave` 或换服务端后，旧绑定签发的邀请在登记时也会被拒——准入时重新核对当前 `server.json`，不用等重启。
- 账号来源的设备登记成功时，所有在线设备收到一条 notice：`New device "<name>" joined through your account`。

HTTP API（都在服务端同一端口的 `/api/*` 下）：`POST /api/login`（`{username, password}`）、`GET /api/me`、`POST /api/logout`、`POST /api/sessions/revoke-all`、`POST /api/join-tokens`（返回 `{token, expiresAt, command}`）。会话令牌 30 天固定过期；登录有按 IP 限速、按用户名失败锁定和 scrypt 并发上限，触发回 429。

凭据形态按请求的 `Origin` 分两类：同源（Origin 等于 `--public-origin`）登录只种 `Secure`+`HttpOnly`+`SameSite=Strict` 的 host-only cookie，响应体不含令牌，页面 JS 拿不到它——代价是靠 cookie 的改动类请求必须带同源 Origin；桌面端（`Origin: app://pinomad`）和没有 Origin 的客户端（移动端、CLI）只在响应体拿到 `token`，不种 cookie，之后用 `Authorization: Bearer`。带 Bearer 的请求不做 Origin 校验（没有环境凭据就没有 CSRF）。CORS 只放行 `app://pinomad`（预检回 `Access-Control-Allow-Origin`、`Allow-Methods: GET, POST`、`Allow-Headers: authorization, content-type`，不带 credentials），其它源不加 CORS 头。服务端没开账号（纯 `--allow-host` 模式）时 `/api/*` 回 JSON 404 `{error:"accounts_disabled"}`，客户端可据此探测。

### 升级

中继托管的 Web 客户端和宿主版本不一致时，客户端会显示需要更新；两边一起升级——宿主 `pinomad upgrade`，VPS 上 `npm i -g pinomad@latest` 后重启中继；容器部署则是改 Dockerfile 里的 `PINOMAD_VERSION`，再在 `deploy/relay` 下重新 `zeabur deploy --service-id <服务 id>`（从 GitHub 部署的话合进 main 即触发）。宿主不在中继的 `--allow-host` 里时，宿主日志和 Web 警告会带着要补的 `--allow-host <hostId>`。

npm 装的实例和本机任何开发检出互不相干（各自的数据目录、进程、包路径都独立），所以在同一台机器上开发 PiNomad 不会碰到正在跑的服务。
