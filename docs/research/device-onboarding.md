# 新设备加入与身份恢复：现有产品的做法和三端库的可行性

研究日期：2026-10-13。对应 issue [#63](https://github.com/bubbleptr/pinomad/issues/63)（父 issue #62，阻塞 #64）。**本文只整理事实，不做选型。** 选哪种做法留到后面的 grilling 会议；文末只列取舍。只新增了本文，没有改代码。

写法约定：每条事实都附一手来源（官方文档、白皮书、规范、库源码或 README）。**推论**是根据来源推出的结论，单独标出；**未核实**是没找到一手来源的内容。

## 0. PiNomad 现状

| 项 | 现状 | 出处 |
| --- | --- | --- |
| 身份 | 宿主一对长期 X25519 密钥；每台设备自己生成密钥对，私钥不离开设备 | ADR-0008 §2 |
| 加入 | 一次性配对密钥（128 位，5 分钟内有效）和宿主公钥、连接地址一起放进链接或二维码；设备在 Noise IK 第一条消息的加密载荷里带上配对密钥，宿主校验后登记设备公钥 | ADR-0008 §3–4；`apps/host/src/devices.ts:108`（`ttlMs = 5 * 60 * 1000`）；`packages/protocol/src/secure-channel.ts:11`（`ClientHello.pair`） |
| 谁能签发邀请 | `createPairing` 是普通 RPC，任何已经通过安全通道认证的客户端都能调用（`packages/protocol/src/frames.ts:144`，`apps/host/src/gateway.ts:1046-1049`）。现在只有 `pinomad pair`（`apps/host/src/cli/pair.ts:14`）和 Web/桌面端的 Devices 对话框（`apps/web/src/widgets/app-frame/devices-dialog.tsx:33`）调用它；`apps/mobile` 里没有调用方，**移动端缺的只是界面，协议层没有限制** | 同左 |
| 中继的位置 | 中继只按 `hostId`（宿主 Ed25519 登记公钥）拼接连接、转发密文；端到端安全只依赖设备固定认的宿主 X25519 公钥 | ADR-0015 §1–2 |
| 丢身份 | 设备身份就是一对密钥。浏览器存储被清、App 重装以后，从宿主的角度看，这台设备和新设备没有区别；旧记录只能等着被吊销 | ADR-0008 §2、§6；GLOSSARY「设备」 |

所以"新设备加入"和"丢了身份的设备恢复"在 PiNomad 里是同一个问题：一台**还不认识宿主公钥、宿主也不认识它的公钥**的设备，要怎么在不经过宿主终端的情况下，拿到经过认证的宿主公钥，并让宿主登记自己的公钥。

## 1. 参考产品

### 1.1 总表

| 产品 | 信任根在哪 | 新设备怎么证明自己 | 服务器 / 中继能否冒充或擅自放行 | 全部设备都丢了 |
| --- | --- | --- | --- | --- |
| Lody | Lody 账号和它托管的同步服务 | 浏览器登录（device code flow）或 `cli_token` | 能。官方说明目前没有端到端加密，跨设备协作依赖 Lody 托管的同步服务 | 重新登录账号（账号恢复方式**未核实**） |
| Tailscale（不开 Tailnet Lock） | 协调服务器 + 身份提供方（IdP） | 通过 IdP 登录，或使用 auth key | 能。协调服务器负责分发节点公钥，恶意的协调服务器可以插入节点 | 用 IdP 重新登录 |
| Tailscale（开 Tailnet Lock） | 用户指定的签名节点（Tailnet Lock key，Ed25519），以及 disablement secret | 由签名节点对新节点的 node key 签名，或使用预签名的 auth key | 不能插入节点，但可以让网络不可用。启用时和新节点加入时，Tailnet Lock 的初始状态是 TOFU | 用 disablement secret 关掉 Tailnet Lock；secret 也丢了、又没交给 Tailscale 支持，tailnet 无法恢复 |
| Signal | 主设备（手机号注册）上的账号身份密钥 | 新设备显示二维码（临时地址 + 临时公钥），主设备扫码后，经服务器把加密的 provisioning 消息发过去 | 服务器签发一次性链接令牌，但新设备上传的预密钥要用账号身份私钥签名，服务器和客户端都会校验（**推论**：服务器自己凑不出合法设备） | 用手机号重新注册；消息历史只能靠 64 字符恢复密钥的备份找回 |
| WhatsApp | 主设备的身份密钥（Account Signature、签名的设备列表） | 二维码（伴随设备身份公钥 + Linking Secret Key），或者输入 8 位码（40 位，配合加密 ECDH） | 服务器转发链接数据，但伪造不了 HMAC 和主设备签名 | 用手机号重新注册，身份密钥随之改变；备份靠 HSM + OPAQUE 保护的密码，或 64 位数字密钥 |
| 1Password（账户密码账户） | 账户密码 + Secret Key（2SKD），服务器只存 SRP verifier | 在新设备上输入 Secret Key 和账户密码（也可以扫 Emergency Kit 上的二维码），用 SRP 登录 | 不能。服务器不掌握能用来破解的数据，也无法替用户重置 | 用 Emergency Kit；或者恢复组 / 恢复码（恢复码要先验证邮箱） |
| 1Password（passkey / SSO 账户） | 已经关联的 App 或浏览器上的凭据包 | 新设备登录后，已有设备批准，再用 6 位 setup code 跑 CPace，把凭据包传过去 | 服务器只做中转；白皮书称，服务器插手密钥协商会被客户端发现 | 恢复组 / 恢复码（同上） |
| Apple iCloud 钥匙串 | 各台受信设备的同步身份（P-384）+ 设备密码 | 由已有设备担保（sponsor），或者走钥匙串恢复：Apple 账号密码 + 短信 + 旧设备密码，HSM 用 SRP 校验 | 文档称没有成员设备的私钥就改不了信任列表；恢复依赖 HSM 固件策略 | 用旧设备密码走 HSM 恢复，最多 10 次。开了高级数据保护（ADP）时，必须设恢复联系人或恢复密钥；都失效时 Apple 无法帮忙恢复 |

### 1.2 Lody

- 机器加入：`npx lody daemon start` 会检查本机是否已登录，没登录就走 device code flow，打开浏览器登录；无头机器可以用桌面 App 里生成的 `cli_token`。[Quick Start](https://lody.ai/docs/quickstart/)、[CLI](https://lody.ai/docs/cli/)
- 信任模型：官方博客原话是 "Lody does not yet support end-to-end encryption, and cross-device collaboration still depends on Lody's hosted sync service"，并说已经完成了端到端加密工作区的第一版设计。[Lody Is Now Open Source](https://lody.ai/blog/lody-is-now-open-source/)
- 所以 Lody 的信任根就是账号加服务端，新设备靠账号登录加入；服务端在结构上能放行任何设备。roadmap 第 80 行写的"类似 Lody"只适用于**发现和路由**这一层，它的信任模型不能拿来参考。
- **未核实**：Lody 的账号恢复方式和登录方式，公开文档里没找到。

### 1.3 Tailscale

**不开 Tailnet Lock**：协调服务器把新节点的公钥分发给其他节点。官方原话："If Tailscale were malicious, and stealthily inserted new nodes into your network, then Tailscale could send or receive traffic to your existing nodes in plaintext." auth key 等同于以生成它的用户身份登录。[Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock)、[Auth keys](https://tailscale.com/kb/1085/auth-keys)

**开 Tailnet Lock**：

- 每个节点都有 node key（WireGuard X25519）和 Tailnet Lock key（TLK，Ed25519）。受信的 TLK 集合存在各节点本地的 tailnet key authority（TKA）里，以哈希链（AUM）形式更新，每条变更都要受信 TLK 签名。节点只接受带有效 TLK 签名的对端 node key。[白皮书](https://tailscale.com/kb/1230/tailnet-lock-whitepaper)
- 加新节点：在签名节点上运行 `tailscale lock sign nodekey:… tlpub:…`，或者用客户端的签名链接（macOS、Windows、iOS 支持；iOS 可以扫二维码）。"Both options require access to the Tailscale admin console, because retrieving information for the node key to add is possible only through the Machines page"。签名节点最少 2 个、最多 20 个，Android 不能做签名节点。[Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock)
- 预签名 auth key：在签名节点上对 auth key 运行 `tailscale lock sign`。源码里对应的是 `SigCredential`：TKA 中的密钥为一把临时公钥签名，相当于把签名能力委托出去，这把临时私钥"is immediately discarded after use"。[tka/sig.go L42-L54](https://github.com/tailscale/tailscale/blob/3bb8a906c27738c7904ef301c9539da763181f85/tka/sig.go#L42-L54)
- 协调服务器能做什么：不能插入节点，可以让网络不可用（白皮书 "protects against unauthorized nodes, not denial of service"）。启用时和新节点加入时都依赖控制面下发的初始状态（ToFU），可以用 `tailscale lock status` 人工核对。[白皮书](https://tailscale.com/kb/1230/tailnet-lock-whitepaper)
- 全部签名节点都丢了：关闭 Tailnet Lock 需要 disablement secret。启用时生成 10 个（32 字节随机数），各节点只保存它们的 Argon2 派生值。"If you lose your disablement secrets, and you did not provide one to Tailscale support, the tailnet cannot be recovered." [Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock)、[白皮书](https://tailscale.com/kb/1230/tailnet-lock-whitepaper)
- **未核实**：签名方拿到的 node key 来自管理控制台，也就是控制面。文档没有说明签名方怎么确认这把 key 确实属于眼前那台新设备。

### 1.4 Signal

- 链接流程：新设备在服务器上登记一个临时的 provisioning address，把这个地址和本地生成的 Curve25519 公钥放进二维码；主设备扫码后，把 provisioning 消息用这把公钥加密，发到那个地址。消息里有共享密钥、账号信息和一次性链接令牌。[A Synchronized Start for Linked Devices](https://signal.org/blog/a-synchronized-start-for-linked-devices/)
- 源码细节：二维码是 `sgnl://linkdevice?uuid=…&pub_key=…`（[signalRoutes.std.ts L332-L356](https://github.com/signalapp/Signal-Desktop/blob/5c1a030485ea64a1c311288cd6b5eecbe36964cd/ts/util/signalRoutes.std.ts#L332-L356)）。解密过程：ECDH（主设备临时公钥 × 新设备私钥），用 HKDF（info 是 `TextSecure Provisioning Message`）派生出 AES-256-CBC 和 HMAC-SHA256 的密钥，消息里带着账号身份私钥 `aciIdentityKeyPrivate` 和 `provisioningCode`。[ProvisioningCipher.node.ts L73-L135](https://github.com/signalapp/Signal-Desktop/blob/5c1a030485ea64a1c311288cd6b5eecbe36964cd/ts/textsecure/ProvisioningCipher.node.ts#L73-L135)
- 服务器的角色：链接令牌由服务器签发，**只有主设备能申请**（`auth.deviceId() != Device.PRIMARY_ID` 时拒绝）。新设备链接时，服务器校验令牌，并用账号身份公钥校验新设备上传的预密钥签名。[DeviceController.java L180-L206、L230-L250](https://github.com/signalapp/Signal-Server/blob/a15d5cdbb937fc5d078b73ec7b4a725ddf4e9473/service/src/main/java/org/whispersystems/textsecuregcm/controllers/DeviceController.java#L180-L250)。发送方也会校验预密钥签名，失败就中止（[X3DH §3.3](https://signal.org/docs/specifications/x3dh/)）。**推论**：服务器能签发令牌，但没有身份私钥，就凑不出能被其他客户端接受的设备；二维码里的公钥只经过摄像头传递，服务器也解不开 provisioning 消息。
- 用户侧：在手机上打开"链接新设备"要先过生物识别或锁屏密码，然后才能扫码。[Linked Devices – Signal Support](https://support.signal.org/hc/en-us/articles/360007320551-Linked-Devices)
- 已知滥用：Google 威胁情报记录过攻击者伪造"链接设备"二维码（伪装成群邀请等），诱导受害者扫码，把攻击者的设备链接进受害者账号。[Google Cloud Threat Intelligence](https://cloud.google.com/blog/topics/threat-intelligence/russia-targeting-signal-messenger)
- 全部设备丢失：
  - Secure Backups 用设备上生成的 64 字符恢复密钥加密，"Losing it means losing access to your backup permanently"。[Introducing Signal Secure Backups](https://signal.org/blog/introducing-secure-backups/)
  - 更早的 PIN + Secure Value Recovery：PIN 经 Argon2 拉伸，靠 SGX enclave 限制猜测次数，防止离线爆破。[Secure value recovery](https://signal.org/blog/secure-value-recovery/)
  - **未核实**：恢复后账号身份密钥是否沿用。Signal 支持站返回 Cloudflare 403，没有读到相关条目。

### 1.5 WhatsApp

以下均来自 [WhatsApp Encryption Overview v9（2026-02-25）](https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf) 的 "Companion Linking" 一节。

- **二维码方式**：伴随设备在二维码里放自己的身份公钥和临时的 Linking Secret Key（32 字节，"never sent to WhatsApp server"）。主设备做三件事：用自己的身份密钥对伴随设备身份公钥签名（Account Signature），对新的设备列表签名，并用 Linking Secret Key 对链接数据做 HMAC。服务器保存设备列表、转发链接数据；伴随设备先验证 HMAC 和主设备签名，再做反向签名（Device Signature）。
- **8 位码方式**：伴随设备生成 40 位随机的 `linkCodePairingSecret`，显示为 8 位 Base32；双方各自用 PBKDF2-HMAC-SHA256（2^17 轮）从这个码派生 AES 密钥，用 AES-CTR 加密各自的临时 X25519 公钥后再做 ECDH，最终得到 Linking Secret Key。码输错时解出来的公钥是错的，后续校验失败，配对取消。（**推论**：这是 EKE 式的 PAKE 构造，靠的是 40 位一次性码。）
- 发消息的一方会校验每台伴随设备的 Account Signature 和 Device Signature，失败就不建会话。用户可以对比 60 位数字或扫码，核对设备密钥。
- 全部设备丢失：白皮书提到，接收方在新手机上重新注册后，身份密钥会改变，旧的伴随设备不再参与补发。**推论**：账号层的信任根是手机号注册（服务器 + 短信），端到端设备集合的信任根是主设备身份密钥，重新注册意味着换掉这把根密钥。
- 备份：[Encrypted Backups 白皮书 v3（2026-10-08）](https://www.whatsapp.com/security/WhatsApp_Security_Encrypted_Backups_Whitepaper.pdf)。备份密钥存在 HSM Backup Key Vault 里，客户端用 OPAQUE 和 HSM 认证，HSM 限制失败次数，超限后密钥永久不可用。也可以改用 64 位数字密钥（不进 HSM）或 passkey。

### 1.6 1Password

以下均来自 [1Password Security Design 白皮书](https://1passwordstatic.com/files/security/1password-white-paper.pdf)（PDF 生成于 2024-12-10）。

- **账户密码账户**：解密需要账户密码、Secret Key（客户端生成，约 128 位熵）和服务器上的加密数据；两个秘密混合派生出认证密钥和加密密钥（2SKD）。认证用 SRP，服务器只存 verifier，"we aren't in a position to even attempt to crack your account password"。（§1、§3、§4.1）
- **新设备**：输入 Secret Key 和账户密码；Emergency Kit 上的二维码能把账户信息（含 Secret Key）带到新设备，用户只需再输入密码。（§3.3 Story 2）
- **服务器不能重置**："The ability to recover or reset the account password or Secret Key would give us (or an attacker who gets into our system) the ability to reset a password to something known to us or the attacker. We therefore deny ourselves this capability."（§3.3）
- **passkey / SSO 账户加新设备（§9.3）**，和 PiNomad 的做法 (a) 最接近：
  1. 新设备用 passkey 或 SSO 登录；服务器通知所有已关联的 App 和浏览器。
  2. 用户在已有设备上同意（必要时先在那台设备上登录）。已有设备生成 6 位 setup code，用它构造 CPace 握手，交给服务器。
  3. 新设备取回握手，用户在新设备上输入 setup code，算出 CPace 回复，交给服务器。
  4. 双方对收到的消息算 HMAC，互相交换核对，不一致就中止（显式密钥确认）。
  5. 已有设备用会话密钥的派生密钥加密凭据包，经服务器发给新设备。

  白皮书称："In the event a malicious server attempts to interfere in the key agreement process, 1Password clients detect the presence and abandon participation."
- **web 客户端的信任问题**：白皮书专门列了从服务器加载 JS 的风险（TLS 被篡改、服务器被篡改、浏览器环境）。这和 ADR-0008 后果一节、ADR-0015 §4 里"中继提供 Web 客户端"是同一类问题。（"web client" 一节）
- **全部丢失**：Emergency Kit 自救；家庭/团队账户靠恢复组；单人账户用恢复码，恢复码要求先验证邮箱，验证不过服务器不下发密钥。（§12.2、§12.6、§12.6.5）

### 1.7 Apple iCloud 钥匙串

- **同步身份**：每台设备生成 P-384 同步身份，各自维护一份其他设备同步身份的列表，并签名后存进 CloudKit；"they can't be modified without having the private keys of the owning device"。[Secure keychain syncing](https://support.apple.com/guide/security/secure-keychain-syncing-sec0a319b35f/web)
- **加入方式**有两种："either by pairing with and being sponsored by an existing iCloud Keychain device, or by using iCloud Keychain recovery"。担保时，已有设备把新成员加进信任圈并重新签名，同时给新设备一张用自己身份密钥签名的 voucher。同一页没有写担保时用户侧怎么操作，**未核实**。[同上](https://support.apple.com/guide/security/secure-keychain-syncing-sec0a319b35f/web)
- **钥匙串恢复**：开了双重认证的账户，用某台设备的设备密码作为托管口令。恢复时依次需要 Apple 账号密码、短信验证和这个口令；HSM 集群用 SRP 校验口令（"the code itself isn't sent to Apple"）。最多 10 次，超过后托管记录被销毁；策略写在 HSM 固件里，可以修改固件的管理卡已经销毁。恢复成功后，托管记录可以向已有设备证明这台设备得到了授权，从而重新加入。[Secure iCloud Keychain recovery](https://support.apple.com/guide/security/secure-icloud-keychain-recovery-secdeb202947/web)、[Escrow security](https://support.apple.com/guide/security/escrow-security-for-icloud-keychain-sec3e341e75d/web)
- **ADP**：开启前必须设置至少一个恢复联系人或恢复密钥；"If the recovery methods fail … Apple can't help recover the user's end-to-end encrypted iCloud data." [Advanced Data Protection](https://support.apple.com/guide/security/advanced-data-protection-for-icloud-sec973254c5f/web)

### 1.8 横向观察

下面是对 1.2–1.7 的归纳，是**推论**。

1. **服务器转发、却无法 MITM 的做法，靠的都是一条服务器碰不到的带外通道**，用它传递高熵的密钥材料：Signal 二维码里的临时公钥，WhatsApp 二维码里的 Linking Secret Key，1Password 的 Emergency Kit 二维码。PiNomad 现在的配对链接也属于这一类（宿主公钥 + 128 位密钥）。
2. **要用人能输入的短码，就都用了 PAKE**：WhatsApp 的 8 位码（40 位，EKE 式）、1Password 的 6 位 setup code（CPace）、magic-wormhole 默认的 16 位码（SPAKE2，"attackers (e.g. a malicious Mailbox server) get only a single guess"，[magic-wormhole welcome](https://github.com/magic-wormhole/magic-wormhole/blob/master/docs/welcome.rst)）。
3. **低熵口令用来恢复时，都有一个持有 verifier 的一方负责限制在线猜测次数**：Apple 的 HSM + SRP（10 次），WhatsApp 的 HSM + OPAQUE，Signal 的 SGX + PIN。PiNomad 里能担任这个角色的只有宿主本身。
4. **全部设备都丢失时**，各家最终依靠的都是一份用户自己保管的高熵离线秘密（Emergency Kit、64 字符恢复密钥、disablement secret、ADP 恢复密钥），或者干脆接受数据丢失；有账号体系的则退回账号和短信（Signal、WhatsApp 重新注册，换掉身份密钥）。
5. **能批准新设备的设备都有限制**：Signal、WhatsApp 只允许主设备；Tailscale 只允许指定的签名节点，Android 不行；Apple 和 1Password（passkey/SSO 账户）允许任何已加入的设备。

## 2. 做法 (a)：已配对设备批准新设备

### 2.1 新设备缺什么

新设备 D 要拿到三样东西：(1) 经过认证的宿主 X25519 公钥，(2) 连接地址（中继 origin + `hostId`，或局域网地址），(3) 宿主对 D 公钥的登记。现在这三样全靠一条邀请链接。按照 D 从哪里拿到 (1)，有四种拼法。以下各变体的构造都是**推论**，没有实现或验证过；引用的是每种构造参照的产品做法。

| 变体 | 参照 | 需要新增的协议部件 | 中继能做什么 |
| --- | --- | --- | --- |
| A1：已有设备（包括手机）出示现在的邀请 | PiNomad 现状 | 协议不用改；移动端补一个调用 `createPairing` 的界面（§0） | 和现在一样：链接里带宿主公钥和 128 位密钥，中继无法 MITM |
| A2：新设备出示二维码，已有设备扫码 | Signal、WhatsApp 的二维码方式 | ① D 生成一次性密钥材料（临时 X25519 公钥，或 32 字节 Linking Secret），连同中继上的临时会合地址放进二维码；② 中继新增一个短期的会合/信箱端点，现在中继只按 `hostId` 拼接（ADR-0015 §1）；③ E 扫码后让宿主授权：调用 `createPairing` 把邀请转交给 D，或新增一个"直接登记这把公钥"的 RPC；④ E 用二维码里的密钥加密或 MAC 邀请内容（宿主公钥、地址、配对密钥），经中继发给 D；⑤ D 照现在的 IK 配对流程连接 | 二维码里的密钥只经过摄像头，中继读不到也伪造不了；中继能看到会合元数据 |
| A3：没有带外数据，靠"批准 + 比对短码" | 1Password §9.3 的通知和批准、Matrix SAS | ① D 只知道中继 origin 和 `hostId`，宿主公钥由中继提供，未经认证；② 宿主新增"待批准设备"状态，以及通知在线设备的帧和批准用的 RPC；③ 双方从 Noise 握手哈希 `h` 派生出短码（Noise §11.2 channel binding），D 显示自己算出的，E 显示宿主那一侧的，由人比对；④ 需要防研磨的承诺轮（见 §2.2） | 不比对短码时，中继可以冒充宿主和 D 握手，再以假设备身份去连真宿主；比对短码时，中继只有约 2^-n 的成功机会（前提是有承诺） |
| A4：输入短码（没有摄像头时） | WhatsApp 的 8 位码、1Password 的 CPace、magic-wormhole 的 SPAKE2 | ① D 和 E（或宿主）之间跑一次平衡 PAKE（CPace / SPAKE2），短码只用一次；② PAKE 成功后，像 A2 的 ④ 一样把邀请发给 D；③ 显式密钥确认（参照 1Password 第 11–13 行） | 每次尝试中继只能猜一次码，猜错会被发现 |

各变体共同的用户侧因素：

- A1 需要把链接从手机交给新设备。新设备是没有摄像头的桌面或笔记本时，得借助 AirDrop、剪贴板同步之类的旁路。
- A2 和 A4 让"已有设备扫描或输入的东西"变成了授权动作，这正是 Signal 被钓鱼利用的位置（§1.4）。Signal 的缓解手段是开相机前先过生物识别或锁屏密码。

### 2.2 短码比对为什么要承诺

Matrix SAS 规范说，它借鉴了 ZRTP 的 hash commitment：先发起 DH 的一方，先只发自己那一份的哈希，等收到对方那一份以后再公开，"Thus an attacker essentially only has one attempt … if we verify n bits, then an attacker has a 1 in 2^n chance of success"。[Matrix spec: SAS verification](https://spec.matrix.org/latest/client-server-api/#short-authentication-string-sas-verification)

**推论**：在 A3 里，如果中继冒充宿主当 IK 的响应方，它可以在看到 D 的第一条消息之后再选自己的临时密钥。这样它可以离线研磨，直到 D 那一侧算出的 6 位数短码（约 20 位）和真宿主那一侧的相同。直接截取 Noise 握手哈希显示给人看，必须另加承诺轮，或者改成比对足够长的值（例如扫码比对完整的 `h`）。

Noise 规范在 §11.2 提到可以把握手哈希"hash it along with their password"。**推论**：对低熵口令，这样做会让终止通道的中间人拿到哈希后离线猜口令，所以口令场景要用 PAKE，而不是 channel binding 加哈希。Noise 规范还把 PSK 固定为 32 字节，就是"to deter users from mistakenly using low-entropy passwords as pre-shared keys"（§15.1）。[Noise rev 34](https://noiseprotocol.org/noise.html)

### 2.3 三端库可行性

- A1、A2、A3 用到的原语只有 X25519、HKDF/HMAC、ChaCha20-Poly1305、BLAKE2s/SHA-256，都已经在用 `@noble/*` 2.4.0 实现（`packages/protocol/src/noise.ts:6-9`）。三端运行这些原语的前提已经验证过：Hermes 只需补 `getRandomValues`（roadmap 第 106 行；noble README 也说 React Native "may need a polyfill for getRandomValues"，[@noble/curves@2.4.0 README](https://unpkg.com/@noble/curves@2.4.0/README.md)）。**不需要新的密码学库**，要写的是协议和状态机。
- A4 要用平衡 PAKE，库的情况和做法 (b) 相同，见 §3.3。

## 3. 做法 (b)：密码走 PAKE，直接和宿主认证

### 3.1 协议现状

| 协议 | 类型 | 状态 | 一手来源 |
| --- | --- | --- | --- |
| OPAQUE | 增强型（aPAKE）：服务器存注册记录，不存口令，可抵抗预计算攻击 | RFC 9807，2025-07，Informational | [RFC 9807](https://www.rfc-editor.org/rfc/rfc9807) |
| SPAKE2 | 平衡型 | RFC 9382，2023-09 | [RFC 9382](https://www.rfc-editor.org/rfc/rfc9382) |
| SPAKE2+ | 增强型 | RFC 9383，2023-09 | [RFC 9383](https://www.rfc-editor.org/rfc/rfc9383) |
| CPace | 平衡型 | draft-irtf-cfrg-cpace-21，2026-10，仍是 Internet-Draft；有 X25519、X448、ristretto255、decaf448 等套件和测试向量 | [draft-21](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/) |
| SRP-6a | 增强型 | RFC 2945、RFC 5054（2007），基于有限域模幂 | [RFC 5054](https://www.rfc-editor.org/rfc/rfc5054) |
| OPRF（OPAQUE 的组件） | — | RFC 9497，2023-12 | [RFC 9497](https://www.rfc-editor.org/rfc/rfc9497) |

RFC 9807 §7 给出的 OPAQUE-3DH 配置示例：OPRF 用 ristretto255-SHA512 或 P256-SHA256，KDF 用 HKDF，MAC 用 HMAC，KSF 用 Argon2id、scrypt 或 PBKDF2。§6.4.1.3 定义了用 X25519 的 3DH。附录 C 有测试向量。

### 3.2 现有 JS 实现

核查方法：从 npm registry 读取元数据，下载发布包，在 `dist` 里搜索 `crypto.subtle`、`require("crypto")` 和 WebAssembly。Hermes 不支持 WebAssembly：issue [facebook/hermes#429](https://github.com/facebook/hermes/issues/429) 仍然开着，维护者建议先用 `wasm2js` 转换（[评论](https://github.com/facebook/hermes/issues/429#issuecomment-2356481723)）。Hermes 也没有 `crypto.subtle`（ADR-0008 §5）。

| 包 | 协议 | 最新版本 | 依赖 | Node / 浏览器 / Hermes | 审计 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| [`@cloudflare/opaque-ts`](https://github.com/cloudflare/opaque-ts) | OPAQUE **draft-07** | 0.7.5（2022-02） | `@cloudflare/voprf-ts` 0.8.0、`@noble/hashes` 0.4.4 | 可 / 可 / **不可**：README 写明哈希和 KDF 用 WebCrypto，voprf-ts 0.8.0 里有 `crypto.subtle.digest` | README 未提及 | GitHub main 的 `package.json` 是 0.9.0，README 仍写 draft-07；npm 上没有更新的版本 |
| [`@cloudflare/voprf-ts`](https://github.com/cloudflare/voprf-ts) | RFC 9497 OPRF | 1.0.0（2024-08） | 无 | 高层操作依赖 WebCrypto；群运算可以选 sjcl 或 `@noble/curves` 作为 provider | README 未提及 | 只是组件 |
| [`@serenity-kit/opaque`](https://github.com/serenity-kit/opaque) | RFC 9807（基于 opaque-ke） | 1.1.0（2026-02） | 无（内嵌 WASM） | 可 / 可 / **不可**（WASM） | 底层的 [opaque-ke](https://github.com/facebook/opaque-ke#audit) 2021-06 经 NCC Group 审计（WhatsApp 资助，审计的是 v0.5.0，修复进入 v1.2.0）；JS 封装本身未见审计 | 默认 KSF 是 argon2id |
| [`react-native-opaque`](https://github.com/serenity-kit/react-native-opaque) | 同上 | 0.3.1（2023-10） | `@serenity-kit/opaque` ^0.8.0 | — / — / 原生模块（Rust + JSI），要原生构建，**不是纯 JS** | 同上 | 仓库最后推送 2024-10；依赖的主包版本远落后于 1.1.0，两端是否兼容**未核实** |
| [`cpace-ts`](https://github.com/slava-nikulin/cpace-ts) | CPace draft-18，X25519 + SHA-512 | 0.1.4（2026-03） | `@noble/curves` ^2.0.1 | 可 / 可 / **不可**：SHA-512 用的是 `crypto.subtle.digest`（[dist/index.js L747-L750](https://unpkg.com/cpace-ts@0.1.4/dist/index.js)） | 无（README 自称 "audit-friendly"） | 个人项目，另附一个 WASM 子入口 |
| [`@cipherman/pake-js`](https://github.com/alicommit-malp/pake-js) | SPAKE2+（RFC 9383）、CPace draft-20 ristretto255 | 0.1.1（2026-04） | `@noble/curves` ^1.6.0（v1 大版本；noble/hashes 打包进了 dist） | README 列出 Node ≥22、Deno、Bun、浏览器；**React Native 没列**；dist 里没搜到 `subtle` | 无，README 要求生产使用前自行审计 | pre-1.0；edwards25519 的 SPAKE2+ 套件标着 SPEC-VERIFY |
| [`spake2`](https://www.npmjs.com/package/spake2) / [`@niomon/spake2`](https://www.npmjs.com/package/@niomon/spake2) | SPAKE2 / SPAKE2+ draft-08 | 1.0.2（2019-09）/ 1.0.4（2022-07） | `elliptic`、`bn.js`、`scrypt-js`、`futoin-hkdf` | 没测 | README："have not go through a formal cryptographic audit" | 早已停止更新，不基于 noble |
| [`@bittery/srp6a`](https://www.npmjs.com/package/@bittery/srp6a) | SRP-6a | 1.0.1（2026-01） | `@noble/hashes` ^1.7、`jsbn` | README 声称支持 React Native（要先装 `react-native-get-random-values`） | README 未提及 | `js-srp6a` 的分支，新包 |
| [`@scirexs/srp6a`](https://www.npmjs.com/package/@scirexs/srp6a) | SRP-6a | 1.0.3（2026-08） | 无 | **需要 `crypto.subtle`**（`esm/shared/crypto.js` L6、L89） | README："never received an independent third-party security audit" | |
| [`js-srp6a`](https://www.npmjs.com/package/js-srp6a)、[`tssrp6a`](https://www.npmjs.com/package/tssrp6a) | SRP-6a | 1.0.3（2026-02）、3.0.0（2021-06） | `jsbn` / 无 | 都依赖 WebCrypto `subtle` 或 Node `crypto` | README 未提及 | |
| `@dotrino/opaque`、`@vexahub/opaque*` | RFC 9807 | 0.1.0（2026-09） | — | WASM | — | 只发过一个版本，没有细看 |

结论：**没有找到同时满足"纯 JS、三端可用、经过审计、实现 RFC 9807 或 CPace"的现成库。** 唯一经过审计的 OPAQUE 实现是 Rust 的 opaque-ke，在 Hermes 上只能走原生模块。

### 3.3 能不能在 `@noble/*` 上自己搭

逐项看 noble 提供了什么（版本 2.4.0，即项目现在锁定的版本）：

| 需要的部件 | noble 2.4.0 | 出处 |
| --- | --- | --- |
| OPRF（RFC 9497），ristretto255 / P-256 / decaf448 | 有：`ristretto255_oprf`、`p256_oprf` 等 | [src/abstract/oprf.ts](https://unpkg.com/@noble/curves@2.4.0/src/abstract/oprf.ts)、[src/ed25519.ts L682](https://unpkg.com/@noble/curves@2.4.0/src/ed25519.ts) |
| ristretto255 群运算和 hash-to-group | 有：`ristretto255`、`ristretto255_hasher` | 同上，L594、L616 |
| Elligator2 映射到 Curve25519（CPace X25519 套件要用） | 有，但名字带下划线，标为实验：`_map_to_curve_elligator2_curve25519`，"Experimental name: may be renamed later" | 同上，L304-L308 |
| X25519、Ed25519 点运算（SPAKE2 的 M/N 点运算、3DH） | 有 | 同上 |
| SHA-512、HKDF、HMAC | 有，在 `@noble/hashes` | [@noble/hashes@2.4.0 README](https://unpkg.com/@noble/hashes@2.4.0/README.md) |
| KSF：scrypt、Argon2id | 有。但 README 警告 "Argon2 can't be fast in JS … It is suggested to use Scrypt instead"；Argon2 不在 2022 年 Cure53 审计范围内 | 同上 |
| SRP 用的大数模幂 | 没有（noble 不做有限域 DH）；只能用 JS BigInt 或 jsbn 自己写 | — |

审计范围：

- `@noble/curves` README 列出四次审计：2026-08 Trail of Bits 审计 2.3.0（"Scope: everything"）、2024-09 Cure53 审计 1.6.0、2023-09 Kudelski、2023-01 Trail of Bits。
- OPRF 模块是 2.0.0（2025-08）才加入的（"oprf: implement RFC 9497"，[release 2.0.0](https://github.com/paulmillr/noble-curves/releases/tag/2.0.0)），所以**不在 2024 年 Cure53 的审计范围内**。
- 仓库 `audit/` 目录里只有 2023、2024 年的报告；2026 年 Trail of Bits 那次的报告没有放进仓库，公开链接**未找到**，只有 2.3.0 release notes 里提到 "Fixes from the Trail of Bits review"。[audit 目录](https://github.com/paulmillr/noble-curves/tree/main/audit)、[release 2.3.0](https://github.com/paulmillr/noble-curves/releases/tag/2.3.0)

**推论**：OPAQUE（ristretto255 OPRF + 3DH + HKDF/HMAC + scrypt）、CPace（X25519 或 ristretto255 套件）和 SPAKE2 需要的原语，noble 2.4.0 都有，协议层要自己写，再用 RFC 9807 附录 C、CPace draft 附录 B、RFC 9382 的测试向量校验。这和 ADR-0008 §5 对 Noise 的做法（"原语不自己写，协议不自己发明"，按规范实现、用测试向量校验）是同一个模式。`cpace-ts` 和 `@cipherman/pake-js` 就是在 noble 上写成的现成例子，只是一个依赖 `subtle`，另一个绑定 noble v1。

### 3.4 怎么和现有 Noise IK 接上

以下都是**推论**，没有实现过。

- **PAKE 的输出可以当 Noise 的 PSK**：PAKE 结束后得到高熵会话密钥，满足 Noise 对 PSK"32 字节"的要求（§15.1），可以喂给一个带 psk 修饰的握手。也可以只用 PAKE 通道来传宿主公钥、登记设备公钥，之后照常走现在的 IK。
- **新设备需要认证宿主公钥**：PAKE 的密钥确认要绑定宿主的 X25519 公钥。这样中继提供的未认证 `hostId` 和公钥，由 PAKE 结果来确认。
- **OPAQUE 的 3DH 需要服务器静态密钥**：如果复用宿主的 Noise X25519 静态密钥，就碰上 ADR-0015 §2 已经讨论过的跨协议复用问题；另起一把密钥则多一份要保管的密钥。
- **限制在线猜测次数只能由宿主做**：中继只转发密文，无法限速，而且它本身就可能是攻击者。
- **增强型 vs 平衡型**：宿主被攻破时攻击者已经拿到全部数据，增强型"服务器不存口令"的保护主要剩下一个作用：口令在别处复用时不至于泄露。

## 4. 取舍（不做推荐）

| 维度 | A1 手机出示邀请 | A2 新设备出示二维码 | A3 批准 + 短码 | A4 / 设备间短码 PAKE | (b) 口令 PAKE 直连宿主 |
| --- | --- | --- | --- | --- | --- |
| 要不要另一台在线的已配对设备 | 要 | 要 | 要 | 要 | 不要 |
| 全部设备丢失时能不能用 | 不能 | 不能 | 不能 | 不能 | 能（前提是记得口令） |
| 要不要摄像头或旁路 | 新设备要能拿到链接（扫码或旁路） | 已有设备要能扫码 | 不要 | 不要 | 不要 |
| 中继要不要新功能 | 不要 | 要（会合/信箱） | 要（待批准状态的转发） | 要（会合） | 不一定（可以复用 `/c/<hostId>` 拼接） |
| 新密码学代码 | 无 | 一次性加密信封（noble 现有原语） | 短码派生 + 承诺轮 | 平衡 PAKE（自己实现或用未审计的库） | PAKE（自己实现或用未审计的库，OPAQUE 只有 WASM 或原生版） |
| 中继作恶时 | 无法 MITM | 无法 MITM | 不比对短码就能 MITM；比对时约 2^-n（要有承诺） | 每次只能猜一次 | 每次只能猜一次；宿主负责限速 |
| 社会工程面 | 链接外泄（5 分钟内有效） | 诱导用户扫恶意二维码（Signal 的先例） | 用户不看短码就点批准 | 诱导用户把码告诉别人 | 口令被钓鱼或复用 |
| 宿主端新增状态 | 无 | 无或很少 | 待批准设备 | 无或很少 | 口令 verifier 或注册记录，加失败计数 |
| 对应产品 | — | Signal、WhatsApp 二维码 | 1Password 的通知批准、Matrix SAS | WhatsApp 8 位码、1Password CPace、magic-wormhole | 1Password SRP、Apple HSM SRP、WhatsApp HSM OPAQUE |

其他产品的事实，也可能影响取舍：

- 所有做法都绕不开"首次信任"。Tailscale 承认启用和加入时都是 ToFU。PiNomad 现在的首次信任来自宿主终端或已配对设备上显示的链接。
- (a) 系列都无法覆盖"全部设备丢失"。各家在这个场景下依靠的都是一份离线高熵秘密（§1.8 第 4 条）；issue 已经说明，这个场景回宿主处理可以接受。
- roadmap 第 80 行的"账号绑定中继"只解决发现和路由。参照 Tailnet Lock 的思路，信任仍然落在设备密钥上，而不是落在账号或中继上；这与 Lody 现在的模型不同（§1.2）。

## 5. 未核实或待补

- Lody 的账号恢复方式和登录方式。
- Tailscale 签名方如何确认待签的 node key 属于眼前的设备（文档只说 node key 要从管理控制台获取）。
- Signal 用恢复密钥恢复后，账号身份密钥是否沿用（支持站被 Cloudflare 拦截，返回 403）。
- Apple 担保式加入时用户侧的具体交互。
- `@noble/curves` 2026-08 那次 Trail of Bits 审计的公开报告。
- `react-native-opaque` 0.3.1 和 `@serenity-kit/opaque` 1.1.0 之间的协议兼容性；`@cipherman/pake-js`、`@bittery/srp6a` 在 Hermes 上实际能不能跑（只读了 README 和 dist，没有在 Hermes 上执行）。
