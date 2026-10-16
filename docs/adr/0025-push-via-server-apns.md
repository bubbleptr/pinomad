# ADR-0025：推送直连 APNs，密钥只放在服务端

- 状态：Accepted
- 日期：2026-10-16
- 修订 ADR-0008 §9 括注里"宿主直接调 Expo Push"的做法（原记在路线图 M5），细化 ADR-0024 §8

## 背景

路线图 M5 原定宿主直接调 Expo Push Service：宿主不放 Apple 密钥，APNs 密钥托管在 Expo。宿主侧已经做完（协议 5.7 `setPushToken`、宿主级文档 `pinomad.push`、`apps/host/src/push.ts` 的发送器），移动端没做。ADR-0024 把移动端改成原生之后，用户决定推送不再经 Expo，免得为推送一直保留 Expo 账号和 EAS 项目。

APNs 只接受用 App 开发者密钥（`.p8`，带 Key ID 和 Team ID）签名的请求，谁持有密钥谁就能给这个 App 的所有安装发通知。密钥不能分给别人，所以不能放在每台宿主上：以后别人自己搭的宿主拿不到它。ADR-0022 的服务端是宿主和客户端都会连的中心，宿主加入账号后一直保持一条控制连接（`/host`），服务端已经经它向宿主要配对邀请（`pairing-request` / `pairing`）。推送走同一条连接，方向反过来：宿主请服务端发。

推送和平时的连接无关：App 在后台或被关掉时没有任何连接，只有 Apple 能叫醒它。局域网、tailnet、中继的直连不受影响。

## 决策

1. **APNs 密钥只放在服务端，按环境分别配置。** Apple 现在新建的密钥只能用于 Sandbox 或 Production 中的一个（以前的双环境密钥仍可用）。服务端按环境分别从环境变量读密钥、Key ID，加上共用的 Team ID 和 topic（App 的 bundle id）；哪个环境配齐了就提供哪个环境。密钥不写进数据目录，不出现在日志、异常信息和 HTTP/2 调试输出里；用 Zeabur CLI 设这些变量时把输出丢掉（它会把全部变量连值打印出来）。
2. **服务端到 APNs**：用 `node:crypto` 按环境签 ES256 的 provider token，缓存并在 20 到 60 分钟之间刷新（Apple 规定的窗口）；用 `node:http2` 每个环境一个会话，按需建立，遇到 GOAWAY、error、close 就丢掉，下次发送时重建。请求带 `apns-push-type: alert`、`apns-topic`、`apns-expiration`（Unix 秒，一小时后）、`apns-collapse-id`（不超过 64 字节；宿主现在拼的 `hostKey:noticeId` 可能超长，改成它的定长摘要），整个 JSON 不超过 4096 字节。
3. **控制帧和功能声明。** 新增宿主 → 服务端的 `push`（`requestId`、设备 token、环境、通知内容）和服务端 → 宿主的 `push-result`。服务端在 `registered` 里带上可用的环境（例如 `push: ["production"]`）。现在的解码器忽略已知帧的多余字段，但遇到不认识的帧会断开连接，所以：
   - 能力只属于当前这条控制连接：宿主每次连上都重新读声明，断线立即清空；没有声明、或者没声明这条登记的环境，就不发，直接按 `unavailable` 处理；
   - 服务端只对格式正确的 `push` 回结果；
   - 测试覆盖新宿主连老服务端、老宿主连新服务端，以及新宿主重连到一个老实例。
4. **请求的生命周期。** `push` 绑定在发出它的那条控制连接上：宿主限制在途数量，单个请求超时（10 秒）按 `retry` 处理；连接断开时，这条连接上所有在途请求都按 `retry` 结算，之后迟到的结果直接忽略。服务端每次发送都核对这台宿主当前仍绑定在账号上（不认静态白名单），并限制每台宿主和全局的在途数量，推送不能占满控制连接、拖慢配对。
5. **结果分类。** 服务端只转发、不保存，不存 token 和通知内容，日志里只记宿主、环境、结果、APNs 的 `reason` 和耗时。APNs 的回复折成下面几类，带上 `reason`，需要时带重试时间：
   - `accepted`：200，APNs 接受了（不代表已经送到手机）；
   - `unregistered`：410（`Unregistered`、`ExpiredToken`），带 APNs 给的失效时间。宿主只在登记的 token 和环境都没变、而且登记时间早于失效时间时删除，迟到的 410 不会删掉重新登记的 token；
   - `retry`：控制连接断开或超时（宿主按现在的 5、10、20 秒退避）；429 `TooManyRequests`（稍后重试）；5xx（Apple 要求至少 15 分钟后再试）；403 `ExpiredProviderToken`（服务端换新 token，宿主重试）；
   - `rejected`：其余 4xx，包括 `BadDeviceToken`、`DeviceTokenNotForTopic`、`PayloadTooLarge`。不重试、不删登记：`BadDeviceToken` 也可能只是环境配错了，App 下次连上时会重新登记，覆盖掉旧的。服务端自己的配置错误（`InvalidProviderToken`、429 `TooManyProviderTokenUpdates`）同样归这一类，并在服务端记错误日志；
   - `unavailable`：服务端没配这个环境。

   宿主每次重试前照旧重读登记名单和对话状态，过时的通知不再发；15 分钟的等待超过通知的意义时（状态已变）自然被丢掉。
6. **宿主保留现有的发送逻辑，去掉 Expo。** `pinomad.push` 文档、和吊销同事务、基线、`diffRunNotices`、标题规则（只用 `pinomad.title`，没有就用固定的 "PiNomad conversation"）、每个 token 单独请求、有界内存队列都不变；Expo 的发送和 15 分钟后查 receipt 删掉。不持久化发件箱。
7. **`setPushToken` 增加 APNs 登记，旧格式回明确的错误。** 参数变成 `{ token: string | { apns: string; environment: "production" | "development" } | null }`：
   - 新的对象形式登记 APNs token。宿主校验它是十六进制、长度在合理上限内（不写死 64 个字符），次版本号加一，客户端按 `FEATURE_SINCE` 判断能不能用；
   - 旧的 Expo 字符串照样能解析，但回 `ok:false`，说明 Expo 推送已停用。不会触发 4400，所以不违反 ADR-0018 §2，也不用涨主版本；
   - 宿主没加入账号时，回 `ok:false`，说明推送需要加入账号。
8. **通知内容不变。** 只带对话标题和事件（"等你回答"、"完成"、"失败"），不带问题和回复。`aps.alert` 放标题和事件文字，`thread-id` 沿用现在的标识，自定义数据仍是 `{ hostKey, conversationId }`。标题会经过服务端和 Apple：服务端本来就是受信任的一方（ADR-0022 §5），比原来经过 Expo 少了一个第三方。
9. **App 的环境以签名后的 entitlement 为准。** App 登记 token 时带的环境，和签名进包里的 `aps-environment` 用同一个构建设置决定，不能另外凭 Debug / Release 判断；验收时用 `codesign -d --entitlements` 检查实际产物。TestFlight 和 App Store 包是 `production`。连上、重连、回到前台时按每台宿主的开关调 `setPushToken`；点开通知先记下 `{ hostKey, conversationId }`，等那台宿主连上、数据就绪再打开。

## 考虑过的方案

- **继续经 Expo**：宿主侧已经做完；但要一直保留 Expo 账号和 EAS 项目，原生 App 还要自己调 Expo 换 token 的接口并跟进它的变化。用户不要。
- **密钥放在每台宿主上**：不经过服务端，没加入账号也能推；但密钥不能给别人，别人自己搭的宿主就没有推送。
- **设备直接向服务端登记 token，宿主只说"推给设备 X"**：宿主拿不到 token，服务端能核对设备和宿主在同一个账号下；但扫码配对的设备不一定登录过账号，服务端要多存一份设备表，现在只有一个用户，不值得。开放注册前必须做，见"后果"。
- **服务端提供 HTTP 接口，宿主签名调用**：和控制连接相比要多一套鉴权；控制连接已经证明了宿主身份，还天然知道宿主在不在线。
- **`setPushToken` 直接换成新格式，旧字符串当格式错误**：最省事；但旧字符串会触发 4400 断开连接，违反 ADR-0018，而保留旧字符串、回 `ok:false` 几乎不增加代码。
- **`BadDeviceToken` 也删登记**：能更快清掉坏 token；但环境配错时会误删有效的登记。
- **加密通知内容，用 Notification Service Extension 在手机上解密**：服务端和 Apple 都看不到标题；但要在 App 里多一个扩展、多一份密钥同步。以后再做。

## 后果

- 推送需要宿主加入账号（ADR-0022），服务端配好对应环境的 APNs 密钥。没加入账号的宿主没有推送。
- 自己部署服务端的人，要用自己的 Apple 开发者账号、自己的 App 构建和密钥才有推送；用官方 App 连自部署的服务端没有推送。以后可以让自部署的服务端把推送转给官方服务端，现在不做。
- 宿主持有 APNs token，任何绑定了账号的宿主都能请服务端给它知道的 token 发通知。现在只有一个用户，靠"只有账号宿主能发"加限速就够。**开放注册前必须改成服务端核对 token 属于这个账号**（例如设备向服务端登记、宿主只拿到一个不透明的句柄），这是开放注册的门槛，记进路线图。
- 服务端多了要保管的密钥：开发环境和生产环境各一把，放在 Zeabur 的环境变量里；轮换时换变量并重启。
- 宿主的 Expo 发送器、`EXPO_*` 地址和 receipt 检查删掉，传输相关的测试重写，基线、标题和吊销的测试保留；`docs/mobile-release.md` 和路线图 M5 第 2 项里关于 Expo 推送的部分作废。Expo 账号只在 Expo 版维护期内用于构建，删除 `apps/mobile` 后不再需要。
- 拆三个 PR：协议和宿主（`setPushToken` 新格式、控制帧、去掉 Expo）、服务端（APNs 客户端、限速），都在 Linux 上做；iOS 侧在原生版上做（ADR-0024 路线图第 5 步）。
