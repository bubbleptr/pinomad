# ADR-0044：账号以邮箱为身份，邮箱注册，Google、GitHub、Apple 快捷登录，取消邀请码

- 状态：Accepted
- 日期：2026-11-07
- 修订 ADR-0022 §2（账号的身份和注册方式）、"考虑过的方案"里的"GitHub OAuth 登录"；取代 #449 的邀请码注册；修订 ADR-0037 §3 和 ADR-0022 §3 修订（#512）里"再输入一次密码"的二次确认

## 背景

M9 要让作者以外的人用官方服务端。现在的账号是用户名加密码，只能凭管理员发的邀请码注册（#449），问题有三个：

- 邀请码要人工发，公开发布后成了最大的摩擦。
- 服务端不存邮箱，忘了密码只能找管理员重置。
- 每个客户端都要记住一个新密码。ADR-0022 把 GitHub OAuth 放进"考虑过的方案"，留到"开放注册时再加"，现在就是这个时候。

iOS 要走 TestFlight 外部测试（#440），Beta App Review 同样按 App Store 指南审。指南 4.8：主账号能用第三方或社交账号登录的 App，必须同时提供一个隐私上对等的登录方式（只拿姓名和邮箱、允许隐藏邮箱、不做广告追踪），Sign in with Apple 是审核没有争议的那个。审核员还需要一组能长期使用的演示账号和密码。

约束不变：官方实例和自部署是同一份代码（ADR-0022 §2）；服务端是新设备的信任根（ADR-0022 §5），不引入第三方身份服务。

## 决策

1. **账号的身份是一个已验证的邮箱，一个账号可以有多种登录方式。** 登录方式有密码、Google、GitHub、Apple 四种，都指向同一个账号。`users` 加 `email`（小写归一化后 UNIQUE）和 `email_verified_at`，`password_hash` 改为可空（只用快捷登录的账号没有密码）。新表 `user_identities (provider, subject, user_id, email, created_at)`，`(provider, subject)` UNIQUE，`subject` 是提供方给的稳定 ID（Google 和 Apple 的 `sub`、GitHub 的数字 user id），不用邮箱或 GitHub 用户名认人。`username` 只留给迁移期的老账号（§8）。

2. **邮箱注册：先验证邮箱，再建账号。** 客户端提交邮箱，服务端发一个 6 位数字验证码（10 分钟有效，最多试 5 次，只存哈希）；客户端提交验证码和密码（规则沿用现在的：至少 12 位，scrypt），服务端建账号并直接登录。服务端里不存在未验证邮箱的账号。找回密码走同一套验证码，用途分开记。用验证码而不是链接：在另一台设备上收信也能用，iOS 不需要 universal link。
   - 不让人探测邮箱是否注册过：发验证码的接口对已注册和未注册的邮箱回一样的结果；邮箱已注册时，信里写"这个邮箱已有账号，可以直接登录或重置密码"，不发注册码。
   - 限流：发验证码按 IP、按邮箱各自限流，另设全站每日上限；验证码输错和登录共用锁定。
   - 发信：服务端只实现 SMTP（`PINOMAD_SERVER_SMTP_URL`、`PINOMAD_SERVER_MAIL_FROM`），官方实例用 Resend 的 SMTP，`pinomad.si` 配好 SPF、DKIM。自部署的人用任何 SMTP 都行。没配发信时，邮箱注册和找回密码关闭，已有的密码登录照常。

3. **快捷登录：服务端是 OAuth 的机密客户端。** Google 和 Apple 走 OpenID Connect，GitHub 走 OAuth 2.0；授权码 + PKCE + `state`（OIDC 再加 `nonce`），回调落在服务端 `/api/oauth/<provider>/callback`，客户端密钥只在服务端。每个提供方只在配了它的环境变量时启用（Google、GitHub：client id 和 secret；Apple：Services ID、Team ID、Key ID 和 `.p8` 私钥），`GET /api/auth/methods` 告诉客户端显示哪些按钮，自部署默认一个都没有。拿邮箱的方式：
   - Google：ID token 的 `email` 和 `email_verified`。
   - GitHub：scope `read:user user:email`，取 `/user/emails` 里 `primary` 且 `verified` 的那个。
   - Apple：ID token 的 `email`，可能是 `privaterelay.appleid.com` 的转发地址，Apple 保证可达，按已验证处理；姓名只在第一次授权时给，拿到就存。

4. **归并规则：同一个人只有一个账号。** 快捷登录回来后，服务端按顺序判断：
   1. `(provider, subject)` 已绑定某个账号：登录这个账号。
   2. 提供方给出的已验证邮箱等于某个账号的已验证邮箱：自动绑定并登录，同时给这个邮箱发一封"新的登录方式已绑定"的通知。两边都必须是已验证的，否则不绑定（防止拿未验证邮箱接管别人的账号）。
   3. 都不匹配：不直接建账号，先显示"这个邮箱还没有账号"，可以选"创建新账号"，或者"用已有方式登录后绑定"。Apple 的隐藏邮箱、GitHub 主邮箱和平时用的不是同一个，都会走到这里，这一步就是为了不让人无意间多出一个账号。

   账号设置里有"登录方式"：列出密码和已绑定的提供方，已登录时可以再绑定一个（走一遍 OAuth，结果直接挂到当前账号上），可以解绑，但不能解绑最后一种。设置密码、换邮箱都要验证码。所以在网站上用 Google 注册的人，在 iPhone 上点 Google 就进同一个账号；Apple 用了隐藏邮箱的人，按第 3 步绑定一次之后，以后也是同一个账号。

5. **客户端怎么拿到登录会话：沿用 #513 的一次性 code + PKCE。**
   - Web：同源，整页跳到 `/api/oauth/<provider>/start`，回调里设会话 cookie，再跳回 Web 客户端。
   - 桌面端（`app://pinomad`）和 iOS：客户端生成 PKCE verifier，用系统浏览器（桌面）或 `ASWebAuthenticationSession`（iOS）打开 `start`，带上 `code_challenge` 和回跳地址；回调后服务端把浏览器送回 `http://127.0.0.1:<端口>`（桌面，只接受回环地址）或 `pinomad://auth`（iOS），带一个两分钟内一次性的 code；客户端用 `POST /api/oauth/token { code, verifier, device }` 换到 token 模式的会话。`device` 和 `POST /api/login` 的一样（ADR-0037 §1）。
   - iOS 上的 Apple 用系统原生的 `ASAuthorizationAppleIDProvider`，把 identity token 和 authorization code 交给 `POST /api/oauth/apple/native`，服务端按 Apple 的 JWKS 验签，audience 是 App 的 bundle id。不跳网页，这也是审核期望的体验。
   - 第 4 条的第 3 步（"还没有账号"）在浏览器里完成，客户端只在最后拿 code。

6. **二次确认：有密码就输密码，没有就收验证码。** 踢设备（ADR-0037 §3）、移除宿主（#512）、删除账号、改或设置密码现在都要再输一次密码，因为它们作用于别的设备，被盗的会话不该能做。只用快捷登录的账号没有密码，改成：`POST /api/reauth` 接受密码，或者先请服务端往账号邮箱发验证码、再提交验证码；通过后得到一个绑定当前会话、5 分钟有效的确认凭据，这几个接口接受 `{ password }` 或 `{ reauth }`。不用"再走一遍 OAuth"：Google 和 GitHub 的浏览器会话通常还在，点一下就过，起不到确认的作用。

7. **取消邀请码，注册由开关控制。** 删掉 `invites` 表（新的 schema 版本里 DROP）、`/api/invites` 和 `/api/invites/revoke`、Web 账号面板里的 Invites 和注册表单里的邀请码字段、文档里的邀请码说明、`GLOSSARY.md` 的"注册邀请码"。`PINOMAD_SERVER_REGISTRATION=open|closed`，默认 `closed`，官方实例设 `open`。关闭时邮箱注册不可用，快捷登录只能登录已经绑定的账号，不建新账号；自部署的人用服务端 CLI `pinomad server user add <邮箱>` 加用户。管理员只剩"能发邀请码"一个特权，随邀请码一起取消：`admin` 列删掉，首次启动建出的账号是普通账号，也可以删除。

8. **老账号：下次登录时补邮箱。** 用户名加密码的登录在迁移期保留。登录成功后，没有已验证邮箱的账号收到 `needsEmail: true`，客户端在继续之前要求填邮箱、收验证码；补完后用邮箱登录，用户名不再显示。所有老账号补完后，下一个版本去掉用户名登录（单独的 issue）。`PINOMAD_SERVER_USER` 改为邮箱，首次启动建的账号视为邮箱已验证（是部署者自己填的）；写的不是邮箱时按老账号处理。

9. **Apple 的撤销。** Apple 要求删除账号时撤销授权：服务端在登录时用 authorization code 换到 Apple 的 refresh token 并存下来，删除账号或解绑 Apple 时调 Apple 的 revoke 接口。撤销失败不阻塞删除，记日志。

10. **客户端共用推导和 Rust 核心同步改。** `packages/client/src/account.ts` 的登录结果、`needsEmail`、登录方式列表、注册步骤这些形状变了，`crates/pinomad-core` 跟着改，重新生成对照向量（AGENTS.md）。服务端 API 不是线上协议帧，不升 `PROTOCOL`。

## 考虑过的方案

- **只用邮箱验证码登录，不要密码**：少一种凭据，也不用找回密码。但 TestFlight 审核员要一组固定的账号密码，自部署没配发信的服务端会登录不了，密码管理器也用不上。
- **邮件里放登录链接（magic link）**：在另一台设备上收信时链接点不回来，iOS 还要配 universal link，验证码没有这两个问题。
- **第三方身份服务（Clerk、Auth0、Supabase Auth）**：省掉 OAuth 和发信的实现，但自部署也得去注册这些服务，信任根从自己的服务端挪到了外面，和 ADR-0022 §2、§5 冲突。
- **不按邮箱归并，每种登录方式各是一个账号**：实现最简单，但用户在网站上用 Google、在手机上用 Apple，就会有两个互不相干的账号，宿主也分在两边。
- **iOS 先只给邮箱登录，不接 Google、GitHub，也就不用 Apple**：能绕开指南 4.8，但用 Google 注册的人到手机上还要另设密码，等于在最常用的设备上多一道门槛。
- **保留邀请码作为开放注册前的闸门**：滥用面最小，但人工发码撑不住公开发布；滥用改由发验证码的限流、服务端的中继限额（#483）兜住。

## 后果

- 服务端开始存邮箱和第三方账号 ID，隐私政策里"No email address"要改，写明用途（登录、验证码、安全通知）和删除账号时一并删除；Apple 的 refresh token 也存在服务端数据目录里。
- 新增依赖：SMTP 客户端库（锁精确版本）；OIDC 验签用现有的 `@noble/*` 或 Node 内置 `crypto`，不引入 OAuth 框架。
- 官方实例要准备：Google OAuth client、GitHub OAuth App、Apple Services ID 和 Sign in with Apple 密钥、Resend 账号和 `pinomad.si` 的发信域名记录。这些密钥都只在服务端的环境变量里。
- iOS 要加 Sign in with Apple capability 和 `pinomad` URL scheme；桌面端复用 #513 的回环监听。
- TestFlight 外部测试（#440）的审核账号是一个邮箱加密码的普通账号，只挂演示宿主。
- 自部署默认行为不变：注册关闭、没有快捷登录、没有发信。
- `GLOSSARY.md`："账号"改为以邮箱为身份、可以有多种登录方式，删掉"注册邀请码"和管理员的说法，新增"登录方式"。
