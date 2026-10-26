# Spike #345 0a：浏览器 ↔ libdatachannel（node-datachannel）

这是 #345 的可行性 spike，只包含可复现实验和证据，**不开 PR、不合入、不作为产品栈底座**。
不修改 **packages/protocol** 或 **apps/host** 的产品逻辑；**apps/cli/build.ts** 的改动只为验证打包，
且 spike 专用的依赖注入在报告里标成 PR1 要移走的部分。

## 结论（详细证据见 #345 的评论和 evidence/）

- 浏览器 RTCPeerConnection 与 node-datachannel 的 reliable + ordered DataChannel 在
  同机回环、同网段两台机器（omarchy ↔ mbp）、Cloudflare STUN 配置下都能建立；每种情况
  都记录了实际选中的 candidate pair。
- Chrome 默认把 host 候选伪装成 **.local**。Linux 的 getaddrinfo 经 nss-mdns/avahi
  能解析，但每个名字约 **5 秒**；macOS 的 mDNSResponder 约 26 ms / 2.1 s。libdatachannel
  的 ICE 检查可能因此晚到。实际连接多次是浏览器主动出站 + host prflx 先建立，
  .local 解析成功但不一定是被选中的那条路。
- 8 MiB 真实 SecureSession 帧（129 条 ≤65535 字节记录）在本机回环和原始局域网
  （192.168.0.24 ↔ 192.168.0.225）都逐字节校验通过；两端都观察到了
  bufferedAmount 超过 256 KiB 高水位、onBufferedAmountLow 多次触发。
- **关键坑**：node-datachannel 的 sendMessageBinary 返回 false 表示“已入队但没能直接写出”，
  不是拒收。若按“拒收”重试同一条记录，会在 SCTP 里产生重复记录，Noise nonce 立刻错位
  （实测报 invalid tag）。适配器必须在 false 时前进，用 bufferedAmount 控制节奏。
- max-message-size 缺失 / 0 / 65536：Chrome 分别按 65536 / 262144 / 65536 限制**发送**；
  libdatachannel 自身发送上限 262144；产品记录最多 65535，三种情况都够用。
- node-datachannel 0.33.4（2026-09-12 发布，MPL-2.0）打进 tgz 后，linux-x64 和
  darwin-arm64 默认安装都能加载；--omit=optional 时平台预编译包缺失，加载器给出
  指名缺哪个包、提示不要 omit optional 的诊断，--version / host / server 照常启动。
- 一个与 RTC 无关的拦路问题：当前公共 registry 上 pi-coding-agent@1.2.0 的 caret 依赖
  会解析到 pi-agent-core/pi-tui 1.4.0，而 pi-ai@1.4.0 未发布。打包冒烟脚本用
  测试项目里的 overrides 把这三个包钉到 lockfile 的 1.2.0；真实发布需要另行处理。

## 环境

- omarchy：Linux x86_64，Node 26.8.2，Bun 1.3.12，npm 12.2.0，Playwright Chromium 153。
- mbp：macOS 27.0.1 arm64，Node 25.9.0，Chrome 155，通过 Tailscale 访问。
- node-datachannel 0.33.4（libdatachannel 0.24.5），精确锁定。
- Playwright 浏览器按仓库约定在 apps/web 下安装。

## 安装

    # 根依赖（spike 通过相对路径 import packages/protocol 的源码）
    bun install

    # 浏览器（如果还没有）
    (cd apps/web && bunx playwright install chromium)

    # spike 是独立的 npm 项目，不是 Bun workspace；不要把它并进根 workspace
    cd spikes/345-rtc-web
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
    bun run build

bun run build 生成 dist/browser.js（浏览器端，含真实的 Noise/SecureSession）和
dist/node-peer.mjs（Node 端 node-datachannel peer，node-datachannel 保持 external）。

## 目录

- src/browser/：浏览器端；真实 initiateIK / SecureSession，三种模式 connect/noise/maxmsg。
- src/peer/：node-datachannel 应答端；同样的 Noise 记录层。
- src/server/relay.ts：HTTP 页面 + WebSocket 信令中继。
- src/server/run.ts：启动 relay / 本机或 mbp 上的 peer / 本机或 mbp 上的浏览器，
  收集双方证据到 evidence/<name>.json。
- src/run-connect.ts / run-noise.ts / run-max-message.ts / run-mdns.ts。
- src/remote/：mbp 上跑的 playwright-core 浏览器脚本、候选探针。
- scripts/setup-mbp.sh / cleanup-mbp.sh：mbp 的一次性依赖和清理。
- scripts/package-smoke.sh / mbp-package-smoke.sh：打包后的安装/加载/CLI 冒烟。
- evidence/：本次实际运行的 JSON/文本证据（token 与公网地址已打码；LAN 私网地址保留用于候选对）。

## 复现 Q1：DataChannel 与实际候选对

    cd spikes/345-rtc-web

    # 同机回环，无 STUN（约 10s；.local 在约 5s 后解析并切到 host/host）
    node src/run-connect.ts --name connect-loopback

    # 同机回环 + Cloudflare STUN（srflx 会出现在两端，但同机仍选中 host/host）
    node src/run-connect.ts --name connect-loopback-stun --stun cloudflare

    # 单独测 .local：Chromium 生成名字，Node 的 getaddrinfo + avahi-resolve
    node src/run-mdns.ts

    # 原始局域网：omarchy 浏览器 ↔ mbp 上的 node-datachannel
    #   先一次性准备 mbp 的 node-datachannel/playwright-core
    scripts/setup-mbp.sh
    node src/run-connect.ts --name connect-lan-no-stun --browser local --host mbp
    node src/run-connect.ts --name connect-lan-stun-host-mbp --browser local --host mbp --stun cloudflare

    # darwin-arm64 + macOS .local
    node src/run-connect.ts --name connect-mbp-local --browser mbp --host mbp

    # 对照：mbp 浏览器 ↔ omarchy 节点；Chrome 只枚举 VPN utun7，选中 Tailscale 100.x
    node src/run-connect.ts --name connect-tailscale --browser mbp --host local

每个命令都会在 evidence/ 写 JSON，包含浏览器 getStats() 的 selected candidate-pair
及 local/remote 候选类型、本机 SDP 里的 .local 候选、host 端
getSelectedCandidatePair()、以及 host 对每个 .local 的 dns.lookup 结果和耗时。

connect-lan-rawip.failed.json 是一次故意把 host 绑到 192.168.0.24 的失败尝试：
Chrome 在 mbp 上即使关掉 mDNS 伪装也只枚举 utun7（172.19/fdfe），所以那条路连不上；
它解释了为什么跨设备证据使用“浏览器主动出站 → host prflx”的局域网路径。

## 复现 Q2：Noise 多记录、背压、max-message-size

    # 8 MiB 真实 SecureSession 帧，双向；129 条记录，逐字节/sha256 校验
    node src/run-noise.ts --name noise-loopback
    node src/run-noise.ts --name noise-lan-raw --browser local --host mbp

    # 宿主 answer SDP 的 max-message-size：缺失 / 0 / 65536
    node src/run-max-message.ts --name maxmsg-sdp-missing --variant missing
    node src/run-max-message.ts --name maxmsg-sdp-0 --variant 0
    node src/run-max-message.ts --name maxmsg-sdp-65536 --variant 65536

- 帧生成：src/shared/frame.ts，两端由同一个 seed/字节数生成 JSON，避免把 8 MiB
  原文通过信令传一遍；接收端先 SecureSession.open，再和本地生成的文本逐字节比较，
  并记录 sha256。
- 发送：bufferedAmount 达到 256 KiB 就暂停，onBufferedAmountLow（以及一个只在
  回调漏掉时使用的 50ms 轮询）继续；每条记录只发送一次。
- node-datachannel 的 sendMessageBinary 返回 false 时不重试，见上文关键坑。
- maxmsg 的 h2b 方向由浏览器发一条很小的 size-received 控制消息确认；
  65537 以上浏览器发不出去时，后续只继续测 h2b，不会用超时误判。

## 复现 Q3：npm tgz

    # 在仓库根目录；web 产物是打包前置条件
    (cd apps/web && bun run build)
    bun run package -- --version 0.0.0-spike345.1
    (cd apps/cli/out && npm pack)

    # linux-x64：默认安装 + --omit=optional，两个都跑 version/host/server 和 RTC 预检
    spikes/345-rtc-web/scripts/package-smoke.sh 0.0.0-spike345.1

apps/cli/build.ts 的 spike 改动：

1. 合并三个 manifest 的 optionalDependencies，把它们放进 external 和发布清单；
   原脚本只合并 dependencies，平台预编译包会丢。
2. 为了不改 apps/host，用 SPIKE_NATIVE_RTC_DEPENDENCIES 注入
   node-datachannel@0.33.4（regular dependency，保证 --omit=optional 时主模块还在，
   加载器能报“缺平台包”而不是裸 MODULE_NOT_FOUND）。
3. 用 SPIKE_NATIVE_RTC_OPTIONAL_DEPENDENCIES 注入全部 @node-datachannel/*@0.33.4
   （optional）。PR1 应把这些移到 apps/host/package.json，build.ts 只保留 1 的合并逻辑。

darwin-arm64 已在 mbp 实测；复现命令：

    scp apps/cli/out/pinomad-0.0.0-spike345.1.tgz void@mbp:/tmp/pinomad-spike-345/
    scp spikes/345-rtc-web/src/rtc-preflight.mjs void@mbp:/tmp/pinomad-spike-345/
    scp spikes/345-rtc-web/scripts/mbp-package-smoke.sh void@mbp:/tmp/pinomad-spike-345/
    ssh void@mbp 'bash /tmp/pinomad-spike-345/mbp-package-smoke.sh'

注意：本次打包冒烟使用测试项目里的 overrides 把 pi 栈钉到 1.2.0，原因见上；
真实发布不能在用户项目里依赖这个 workaround。

## 清理

    # mbp 的 spike 临时目录
    spikes/345-rtc-web/scripts/cleanup-mbp.sh

    # 本机：确认没有遗留的 host/server/浏览器
    ps -eo pid,cmd | grep -E 'run-(connect|noise|max-message)|node-peer|remote-browser|pinomad-pkg' | grep -v grep

测试用的 host/server 都由 runner 或冒烟脚本在 finally 里 kill；不要 install 任何服务。
~/.pinomad 与正在运行的用户宿主不属于本 spike，未触碰。
