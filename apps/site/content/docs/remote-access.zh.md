---
title: 远程访问
description: 配对、tailnet / WebRTC 直连、自部署中继和服务端账号。
---

先装好宿主，见[快速上手](/zh/docs/)。

npm 安装的宿主直接开远程端口；宿主要在终端里一直跑着，另开一个终端发配对邀请：

```sh
pinomad host --remote-port 7422
pinomad pair        # 一次性的二维码和链接，5 分钟后过期
```

手机扫二维码即完成配对（Noise IK 端到端加密 + 设备登记）；二维码是一次性的，5 分钟过期，过期后重新跑 `pinomad pair`。已登记的设备在 Web 的 Settings → Devices 里管理，在那直接点 Revoke 就能吊销。

配对邀请始终带 legacy `url`，并可以再带一份 `endpointSet` 候选列表（ADR-0032）：开着远程端口时，直连候选是当前探测到的局域网地址或显式 `--public-url`；加入可远程访问的中继时，中继也会作为候选。自动 LAN 地址在每次生成邀请和每次安全连接的 `hello` 时重新探测，不是启动时的缓存。回环 direct 和回环 relay 都只留在本机：邀请省略 `endpointSet`（没有可达的远程候选时），也不会把 `127.0.0.1` 发布给远程客户端；旧客户端继续只读 `url`。

<details><summary>从源码检出：一条命令或分开跑各进程</summary>

源码检出里 `bun run start` 会构建 Web、起宿主和 vite，并在终端打印电脑浏览器链接和手机配对二维码：

```sh
bun run start
# 透传宿主参数：bun run start -- --faux "hi" --data-dir /tmp/demo
```

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

远程端口不接受 token：只有完成配对、公钥已登记在设备表里的客户端能连。不开 `--remote-port` / `--relay` 时 `pair` 打印的是回环链接（回环端口 `/secure` 路径上的安全通道），只能给本机上的客户端用，比如桌面端 App。桌面端 App 可以配对多台宿主（Settings → Hosts），同时连着所有宿主，侧栏按机器分组；侧栏底部的电脑图标列出各宿主的连接状态，点一台会滚到它的分组。App 会自动检查更新（GitHub Release 上的 `latest-mac.yml`，自动下载、不自动安装），下载完成后侧栏底部的 Settings 图标上出现一个圆点，到 Settings → Updates 点 "Restart to update"；也可以在菜单里手动 Check for Updates…。

</details>

### 经 tailnet 直连

宿主带 `--remote-port 7422`，tailnet 里的设备用宿主的 MagicDNS 名直连（经局域网时 2–7ms，不走 DERP）；同时开着 `--relay` 或加入了账号时，不在 tailnet 里的设备照旧走中继。`pinomad pair` 这时会在同一个邀请里同时给出中继和直连候选（MagicDNS 地址可以通过 `--public-url` 指定），legacy `url` 仍指向中继，旧客户端不受影响。

Tailscale 和 sing-box 共存时，sing-box 配置要改两处，否则控制面连不上或流量被 tun 截走：

- DNS 规则让 `tailscale.com`、`tailscale.io` 不走 FakeIP；
- tun 用 `route_exclude_address` 排除 `100.64.0.0/10` 和 `fd7a:115c:a1e0::/48`。

宿主机器上开着 sing-box tun（`auto_route`）时，`route_exclude_address` 还要加上局域网网段（如 `192.168.0.0/16`）。否则宿主回给局域网设备的包会被路由进 tun，手机用局域网 IP 连远程端口时一直转圈。可以在宿主上用 `ip route get <手机 IP>` 检查，应该走物理网卡，而不是 `tun0`。

## WebRTC P2P 直连

有中继时，客户端先经中继连上；链路就绪后，Auto 在后台尝试 WebRTC DataChannel 直连，打洞成功对话数据就不再经过服务端，失败则留在中继。没有 TURN，所以有些网络（比如双方都在对称 NAT 后面）建不起 P2P。宿主声明 `hello.rtc` 才支持；没有装 `node-datachannel` 原生模块时宿主照常运行，只是不声明。STUN 列表在 `<数据目录>/settings.json` 的 `rtcStun`，默认 Cloudflare 的公共 STUN，`[]` 表示只用 host 候选。

连接方式按宿主设置，在 Settings → Hosts 里点该宿主的 Connection…：Auto（默认）、Direct only（对话数据不经过 PiNomad 服务端，中继只用来建立链路）或 Relay only（只走中继，不尝试 P2P）。同一个面板的 Status 显示当前走 P2P 还是中继；走 P2P 时还显示两端是局域网、tailnet 还是公网地址（点 Show addresses 看完整地址），以及最近一次失败的原因。同一套设置的简述在[快速上手](/zh/docs/)的「WebRTC 直连」一节。

## 经自部署中继访问

宿主在家里局域网、手机在外面时，把中继跑在一台有公网地址的 VPS 上：宿主和手机都只往外连中继，中继按宿主身份把两端的连接接起来，只转发密文、不存东西；Web 客户端也由中继用 HTTPS 提供，手机扫二维码直接打开。

VPS 这边：同一个包（只要 Node 25+）——中继和 Web 客户端来自同一个 `pinomad` 安装，版本天然一致。首次启动用两个环境变量建出唯一用户（细节见下面的「服务端账号」）：

```sh
npm i -g pinomad
export PINOMAD_SERVER_USER=<用户名>
export PINOMAD_SERVER_PASSWORD=<至少 12 位>
pinomad server --public-origin https://relay.example.com --data-dir /var/lib/pinomad/server --trust-proxy
# 默认只监听 127.0.0.1:7430，--port / --listen 可改；--trust-proxy 是因为前面有 Caddy
```

宿主这边：浏览器打开 `https://relay.example.com` 登录，"Add a host" 给出一条一次性的 `pinomad join` 命令（十分钟内有效），在宿主机器上运行。宿主只有加入账号后才能在服务端登记：

```sh
pinomad join https://relay.example.com <token>   # 登记到账号、写好 server.json、装好宿主服务
pinomad pair                                     # 中继作 legacy 地址，同时带远程端口的直连候选
```

Caddy 终止 TLS（自动签证书，WebSocket 无需额外配置）：

```
relay.example.com {
  reverse_proxy 127.0.0.1:7430
}
```

systemd 单元示例（VPS 上的系统级单元；node 和包路径都用绝对路径，`command -v node` 和 `npm root -g` 查）。首次启动的两个账号变量和推送用的 APNs 变量都放进 `/etc/pinomad-server.env`（`chmod 600`），用户建好后账号变量可以删掉。数据目录的锁是旁边的 `<目录>.lock`，所以数据目录放在 `StateDirectory` 下面一层：

```ini
[Unit]
Description=PiNomad server
After=network-online.target

[Service]
User=pinomad
StateDirectory=pinomad
EnvironmentFile=-/etc/pinomad-server.env
ExecStart=/usr/bin/node /usr/lib/node_modules/pinomad/dist/pinomad.js server --public-origin https://relay.example.com --data-dir /var/lib/pinomad/server --trust-proxy
Restart=always

[Install]
WantedBy=multi-user.target
```

### 容器平台

镜像在 `deploy/server/Dockerfile`，装的是锁版本的 npm 发布包（`ARG PINOMAD_VERSION`）。平台终结 TLS 并转发到 `$PORT`（默认 8080），不需要 Caddy；镜像固定带 `--trust-proxy`。中继把转接状态放在内存里、数据目录也有锁，**只能跑一个实例**，不要开扩容。账号数据在 `/data/server`（锁文件是旁边的 `/data/server.lock`，所以数据目录不能直接是卷的根），**要在服务上挂一个持久卷到 `/data`**，否则每次重新部署都会丢掉用户、登录和宿主绑定。

| 环境变量 | 含义 |
|---|---|
| `PINOMAD_PUBLIC_ORIGIN` | 客户端打开的 https origin，比如 `https://nomad.example.com` |
| `PINOMAD_SERVER_USER` / `PINOMAD_SERVER_PASSWORD` | 第一次启动时建出唯一的用户（密码至少 12 位）；之后留着也没关系，用户已存在时不再读 |

配好变量和持久卷，绑定自定义域名，DNS 指向平台给的地址；用 Cloudflare 时建议**关掉代理（灰云）**，橙云会让国内访问多绕一圈，证书由平台自己签。域名生效后验证：

```sh
curl -sI https://nomad.example.com/          # 200，中继托管的 Web 客户端
pinomad join https://nomad.example.com <token>   # 宿主加入账号、接上中继
```

宿主登记成功会在日志里写一行 `{"event":"relay","status":"registered",…}`，掉线重连时写 `"status":"connecting"`（`pinomad service logs` 查看）；也可以从外面连设备入口 `wss://<origin>/c/<hostId>` 确认：宿主在线时连接保持打开（等握手），没登记会立刻以 `4604`（hostOffline）关闭。

也可以从 GitHub 仓库部署：Root Directory 设 `deploy/server`、Watch Paths 限 `deploy/server/**`，其余同上。

### 服务端账号（ADR-0022）

服务端把账号存在数据目录里（`--data-dir`，或环境变量 `PINOMAD_SERVER_DATA_DIR`，默认 `~/.pinomad-server`），首次启动时用两个环境变量建出唯一用户。宿主只有加入账号（`pinomad join`，见下）后才能登记：

```sh
export PINOMAD_SERVER_USER=<用户名>
export PINOMAD_SERVER_PASSWORD=<至少 12 位，建议密码管理器生成>
pinomad server --public-origin https://relay.example.com --data-dir /var/lib/pinomad/server --trust-proxy
```

- 两个变量缺一个、或密码不到 12 位，启动直接报错；users 表已有用户后启动不再需要它们。数据目录和宿主一样一个目录只允许一个进程，容器平台部署要挂持久卷。
- 账号 API 和控制连接只走 HTTPS/WSS，明文只留给 localhost 开发。前面有反向代理（Caddy、容器平台）时必须加 `--trust-proxy`：服务端据此信任 `X-Forwarded-Proto` 判定请求是否来自 https，并取 `X-Forwarded-For` 做按 IP 限速；不加的话，经过代理进来的请求会被当成不可信的明文连接拒绝（`/api/*` 回 403，`/host` 升级回 403），限速也只看到代理的地址。
- 改密码用 `pinomad server passwd`（要求服务端已停，它和数据目录锁互斥），新密码从 stdin 读：

  ```sh
  printenv NEW_PASSWORD | pinomad server passwd --data-dir /var/lib/pinomad/server
  ```

  同一个事务里换掉密码哈希、作废所有登录会话和没用掉的 join token；宿主上已登记的设备不受影响。

#### 宿主加入账号（join / leave）

在已登录的会话里调 `POST /api/join-tokens` 拿一次性令牌（10 分钟有效，只能用一次），然后在要加入的机器上跑：

```sh
npm i -g pinomad            # 已经装好就跳过
pinomad join https://relay.example.com <token> [--name 显示名]
```

`join` 依次做：建好宿主的 Ed25519 登记密钥和 Noise 密钥（已有就复用）；经一条一次性操作连接向服务端登记（这条连接不会顶替正在跑的控制连接）；把服务端地址写进 `<数据目录>/server.json`；然后安装宿主服务——已安装就重写服务定义、去掉旧的 `--relay` 参数——并按 ADR-0009 等空闲重启。输出会打印宿主指纹（hostId）和加入的账号名。令牌响应丢了就重新生成一个再跑一遍，重复 join 同一台宿主是幂等的。

`--name` 把显示名写进 `<数据目录>/settings.json` 的 `hostName`（清洗后为空会报错退出）：join 上报给服务端的名字就是它，不带 `--name` 时用 settings.json 里已有的名字，都没有则是机器名。之后也可以在客户端的 Settings 里改（宿主经控制连接把新名字同步给服务端）。前台运行的宿主（`bun run host`）不会在运行中重读 settings.json，要重启才生效；服务方式安装的宿主由 join 的重启自动带上。

```sh
pinomad leave [--data-dir DIR]
```

`leave` 向服务端解绑这台宿主（服务端会立刻断开它现存的控制连接），删掉本地 `server.json`，重写服务定义去掉 `--relay` 后等空闲重启。服务端不在线时本地文件照样删，但会明确提示服务端的绑定记录没清掉。

`server.json` 和 `--relay` 参数表达同一个东西；宿主启动时两者都给出且不一致会直接报错。对着没开账号的旧服务端跑 `join` 会得到明确报错（先探测 `GET /api/me`），不会误报成功。账号操作只接受 `https://` 地址（本机回环的 `http://` 留给开发），明文会把一次性令牌暴露给链路上的人。

#### 在客户端里用账号

- Web 从服务端地址打开、还没连过宿主时，首页就是登录；桌面端在首页或侧栏底部用户栏的 "Sign in" 里填服务端地址登录。从宿主自己的端口打开的 Web 不显示账号入口，用配对链接。
- 登录后列出账号下的宿主：点 Pair 由服务端向宿主要邀请、自动完成配对并连上；已经配对过的点 Connect。
- "Add a host" 给出一条一次性的命令（十分钟内有效），在要加入的机器上运行即可。
- 宿主的公钥变了（重装）或者宿主拒绝了这台设备（被吊销）时，客户端只提示，不会自己重新配对；确认是自己的操作后点 Pair again。
- 宿主的 Settings → Devices 里能看到每台设备是怎么加入的，也能关掉 "Accept devices from your account"，之后只能扫码。

#### 宿主侧的设备准入

- 登记时记下每台设备的来源（扫码 / 本机回环 / 账号担保）；早期版本登记的设备没有来源标记。
- 吊销会留下持久记录：被吊销的公钥不能经账号担保的邀请重新登记；在宿主上重新扫码配对可以——那是用户的主动动作，同时把该公钥从吊销记录里去掉。
- 宿主设置 `acceptAccountDevices`（默认开，协议 5.8，客户端用 `FEATURE_SINCE` 判断宿主是否认识它）控制是否接受服务端担保的设备；关掉后还没用掉的账号邀请立即作废。邀请绑定到 `server.json` 里每次写入生成的随机 `binding` 而不只是地址：`pinomad leave`、换服务端、或重新 join（即使同一地址）后，旧绑定签发的邀请在登记时都会被拒——准入时重新核对当前 `server.json`，不用等重启。
- 账号来源的设备登记成功时不再向在线设备广播 notice（M8 修订 ADR-0022 §6）：新设备只在 Devices 列表里实时出现，并标出来源「via account」。

HTTP API（都在服务端同一端口的 `/api/*` 下）：`POST /api/login`（`{username, password}`）、`GET /api/me`、`POST /api/logout`、`POST /api/sessions/revoke-all`、`POST /api/join-tokens`（返回 `{token, expiresAt, command}`）、`GET /api/hosts`、`POST /api/hosts/:hostId/pairing`。会话令牌 30 天固定过期；登录有按 IP 限速、按用户名失败锁定和 scrypt 并发上限，触发回 429。

#### 服务端担保配对（ADR-0022 §4）

`GET /api/hosts` 列出当前账号下的宿主：`[{hostId, name, noisePublicKey, online, lastSeenAt, pairing}]`。`pairing` 取 `available` / `offline` / `host_too_old` / `key_mismatch` 之一：宿主离线；在线但没声明 `pairing` 能力、或登记时没有用 v2 签名报告 Noise 公钥（太旧）；在线报告的公钥和加入时记下的不一致；其余情况可用。

`POST /api/hosts/:hostId/pairing` 让服务端经宿主的控制连接要一份一次性邀请。宿主必须在 register 里声明 `features: ["pairing"]` 才会被问——旧宿主的解码器遇到不认识的帧会断开，所以服务端只对声明过的控制连接发 `pairing-request`。成功返回 `{url, hostKey, secret, expiresAt, endpointSet?}`：客户端拼 `pair=<hostKey>.<secret>&url=<url>`，照 ADR-0008 的 IK 流程经 `/c/<hostId>` 连上宿主。`endpointSet` 是宿主当前公布的可远程访问的中继 / 直连候选（回环地址不会进入集合），服务端只转发、不持久化；旧宿主不返回它，旧客户端也会忽略它，账号配对继续按 `url` 走单中继。错误：宿主不属于本账号或不存在 → 404；离线 → 409 `host_offline`；太旧或公钥不一致 → 409 `host_too_old` / `key_mismatch`；宿主拒绝 → 409，错误码是宿主给的原因（`disabled` 是开关关闭、`not_joined` 是没加入账号）；10 秒没应答 → 504 `host_timeout`；在途请求超限（每台宿主 4 个、每个会话 2 个）→ 429 `rate_limited`。提前拒绝只是给客户端看的错误，真正是否准入仍由宿主的 `admitDevice` 在握手时判定——被吊销的公钥照走邀请但登记时被拒。

凭据形态按请求的 `Origin` 分两类：同源（Origin 等于 `--public-origin`）登录只种 `Secure`+`HttpOnly`+`SameSite=Strict` 的 host-only cookie，响应体不含令牌，页面 JS 拿不到它——代价是靠 cookie 的改动类请求必须带同源 Origin；桌面端（`Origin: app://pinomad`）和没有 Origin 的客户端（移动端、CLI）只在响应体拿到 `token`，不种 cookie，之后用 `Authorization: Bearer`。带 Bearer 的请求不做 Origin 校验（没有环境凭据就没有 CSRF）。CORS 只放行 `app://pinomad`（预检回 `Access-Control-Allow-Origin`、`Allow-Methods: GET, POST`、`Allow-Headers: authorization, content-type`，不带 credentials），其它源不加 CORS 头。旧版服务端的纯 `--allow-host` 模式下 `/api/*` 回 JSON 404 `{error:"accounts_disabled"}`，客户端据此判断服务端没开账号。

### 推送通知（ADR-0025）

推送由服务端直连 APNs：宿主经自己的账号控制连接请服务端发，APNs 密钥（`.p8`）只存在服务端，宿主上不用配任何东西，只要已经 `pinomad join` 进账号。不配下面的变量时服务端照常运行，只是不向宿主声明推送能力。

| 环境变量 | 含义 |
|---|---|
| `PINOMAD_SERVER_APNS_TEAM_ID` | Apple Developer 账号的 Team ID（开发者门户的 Membership 页面） |
| `PINOMAD_SERVER_APNS_TOPIC` | App 的 bundle id，比如 `build.kieran.pinomad` |
| `PINOMAD_SERVER_APNS_PRODUCTION_KEY_ID` / `PINOMAD_SERVER_APNS_PRODUCTION_KEY` | production 环境的 Key ID 和 `.p8` 内容（在 Apple Developer 的 Keys 里建 APNs key 下载，只给看一次） |
| `PINOMAD_SERVER_APNS_DEVELOPMENT_KEY_ID` / `PINOMAD_SERVER_APNS_DEVELOPMENT_KEY` | development（sandbox）环境，同上。建 key 时选 "Sandbox & Production" 就只用一把，两组变量填同样的 Key ID 和 `.p8` |

- 每个环境要 `*_KEY_ID` 和 `*_KEY` 都配上才会向宿主声明；只配一半会在日志里写一条 `apns:` 警告并跳过这个环境。启动日志的 `{"event":"ready",…,"push":["production",…]}` 是实际生效的环境。
- `_KEY` 是 PEM 文本本身，不是文件路径。服务端认真实换行，也认字面的 `\n`。有的容器平台的变量只存单行，直接粘多行内容会丢掉换行，启动日志报 `apns: the … key is not a valid EC private key`；先把 `.p8` 转成用字面 `\n` 连接的一行再粘：`awk 'NR>1{printf "\\n"} {printf "%s", $0}' AuthKey_XXXXXXXXXX.p8 | pbcopy`（Linux 换成 `wl-copy`），不加引号。
- 服务端按环境各持一条到 APNs 的 HTTP/2 长连接（production 打 `api.push.apple.com`，development 打 `api.sandbox.push.apple.com`），断了自己重建；provider token 用 `node:crypto` 签 ES256，缓存在进程里。
- 推送负载只带标题和事件类型（"Waiting for your answer" / "Finished" / "Failed"），不带对话内容。

### 升级

中继托管的 Web 客户端和宿主版本不一致时，客户端会显示需要更新；两边一起升级——宿主 `pinomad upgrade`，VPS 上 `npm i -g pinomad@<版本>` 后 `systemctl restart pinomad-server`；容器部署则是改 Dockerfile 里的 `PINOMAD_VERSION` 再重新构建部署。宿主没加入服务端账号时，宿主日志和 Web 警告会提示先 `pinomad join`。从只用 `--allow-host` 白名单的老版本升级时，这个参数已经去掉（带着它启动会报未知参数）：按「服务端账号」配好数据目录和首个用户，在每台宿主上 `pinomad join`，再去掉 `--allow-host` 启动新版本。服务端命令现在叫 `pinomad server`，旧名 `pinomad relay` 仍然可用。

### 搬到另一台机器（域名不变）

`--public-origin` 不变时，宿主的 `server.json` 签名、客户端记下的 `wss://<域名>/c/<hostId>` 和浏览器 cookie 都继续有效，宿主不用重新 join。整个服务端状态就是数据目录里的 `server.sqlite`：

1. 新机器按上面装好包、Caddy 和 systemd 单元，APNs 变量也配上，但先不启动服务端。
2. 停掉旧服务端，再拷数据目录（SQLite 不要在运行中拷；正常退出后 WAL 已合回主文件，目录里可能只剩 `server.sqlite`）。锁文件 `<目录>.lock` 不用拷。
3. 新机器上把数据目录交给服务端的用户（`chown -R pinomad:pinomad /var/lib/pinomad/server`），启动，确认启动日志 `{"event":"ready",…,"push":[…]}` 里的推送环境齐全。
4. DNS 改指新机器。等权威解析和公共解析都换过来再让 Caddy 签证书，免得验证请求打到旧机器、白白用掉 Let's Encrypt 的失败配额。
5. 宿主会自己重连，日志出现 `"status":"registered"` 即可。宿主或客户端走本地代理（fake-ip）时，代理自己的 DNS 缓存过期前仍会连旧地址。

停服到 DNS 生效这段时间宿主连不上中继，外网设备会断线；P2P 和 tailnet 直连不受影响。

### 更换服务端域名

服务端只认一个 `--public-origin`：宿主登记时把它签进挑战（ADR-0015 §2），浏览器的 cookie 和同源校验也按它来。服务端数据目录里不存 origin，换域名不会丢用户、登录会话和宿主绑定；会受影响的是各端记下的旧地址：

- 宿主的 `server.json` 里是旧 origin，签名会被新服务端拒绝（`badSignature`），换完之前宿主连不上中继。
- 客户端配对时记下的是 `wss://<旧域名>/c/<hostId>`，之后不会自动刷新；账号列表里这台宿主仍显示已配对，不会提示重新配对。
- 浏览器 cookie 绑在旧域名上，Web 要在新地址重新登录；桌面端要用新地址重新登录。

所以**旧域名不要直接下线，也不要 301 跳转**（WebSocket 不跟随重定向）：让它和新域名一起指向同一个服务。设备入口 `/c/<hostId>` 只看路径，不看 Host，旧链接经旧域名照样接通，加密是端到端的，域名不影响安全性。步骤（以 VPS + Caddy 为例）：

1. 新域名的 DNS 也指向这台服务器（Cloudflare 灰云），在 Caddyfile 的站点地址里把新旧域名写在一起（`old.example.com, new.example.com {`），`systemctl reload caddy` 后等新域名的证书签好。
2. 把 `--public-origin` 改成新 origin 并重启服务端（数据目录不动；容器部署是改 `PINOMAD_PUBLIC_ORIGIN` 重新部署）。从这时起宿主掉线，直到下一步做完。
3. 在新地址登录 Web，"Add a host" 拿一次性命令，在每台宿主上跑 `pinomad join https://<新域名> <token>`。重新 join 会覆盖 `server.json` 并等空闲重启，**不要先 `leave`**——它会用旧 origin 签名，被新服务端拒绝。
4. 确认宿主在线：`curl -sI https://<新域名>/` 回 200，宿主日志有 `"status":"registered"`，`wss://<新域名>/c/<hostId>` 连上后保持打开。
5. Web、桌面端在新地址重新登录。Web 的配对存在浏览器 localStorage 里、按域名隔离，新地址的页面一开始没有宿主，登录后在账号列表里点 Pair 即可；桌面端和 iOS 的已有配对先继续经旧域名工作；想彻底换掉旧域名时，在各个客户端里删掉这台宿主重新配对（账号里点 Pair，iOS 扫码），全部换完再从 Caddyfile 里去掉旧域名。

npm 装的实例和本机任何开发检出互不相干（各自的数据目录、进程、包路径都独立），所以在同一台机器上开发 PiNomad 不会碰到正在跑的服务。
