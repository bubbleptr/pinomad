# ADR-0030：输入框附加本机文件——宿主持久化上传、按 id 引用、模型看只读原件

- 状态：Accepted
- 日期：2026-10-24
- 回答 issue #321；补充 ADR-0018（协议 5.19）、ADR-0024（客户端推导同步）和 ADR-0027（图片附件是另一条路径）

## 背景

`+` 菜单原来只能加图片。`@./path` 指的是**宿主**那台机器、对话工作目录里的文件，由模型自己用工具读；客户端和宿主经常不在同一台机器上（桌面端在 Mac、宿主在 Linux），客户端本机的 PDF、日志、截图以外的文件没有通路交给 agent。

图片已经有一套做法：客户端压缩后把 base64 内联进 `submit` / `createConversation`，宿主存进 SQLite，再由上游组装成模型消息。那条路不适合任意文件：10 MB 的 base64 帧会堵住同方向唯一 FIFO 发送器里的 submit / abort；文件也不像图片那样能压缩。因此附件单独上传到宿主磁盘，发送时只传宿主生成的 id。

## 决策

### 1. 两个旁路调用，id 由宿主生成

协议 5.19 新增：

```ts
beginAttachment: { args: { name: string; size: number }; result: { attachmentId: string } };
appendAttachment: {
  args: { attachmentId: string; offset: number; data: string /* base64, decoded ≤ 512 KiB */ };
  result: { received: number; complete: boolean };
};
```

- 两个调用都不进命令队列（同 `listFiles`、`image`），也不绑定对话：新对话发第一条消息之前就能上传。
- `attachmentId` 是宿主生成的 128 bit 随机数，固定为 22 字符 base64url；客户端给的值永远不进路径。
- 客户端把文件切成 512 KiB 的块，逐块 `await`；这样上传不会用一个 13 MB 的帧堵住同方向的 submit / abort，也不需要绕过 ADR-0024 的唯一 FIFO 发送器去交错发送。
- `appendAttachment` 按 id 串行（宿主对每个 id 一条 promise 链，实际由同一把存储锁串行）。完成 / 已用的附件不看 offset、直接回答 `{ received: size, complete: true }`；offset 和宿主当前长度不一致时不写，返回 `received` 让客户端续传；重复块、完成回包丢失、宿主重启都靠这一条收敛。
- `received` 以磁盘文件长度为准，所以宿主重启后状态可恢复。

### 2. 数据目录布局与持久格式 v1

```
<dataDir>/attachments/<attachmentId>/meta.json
<dataDir>/attachments/<attachmentId>/file/<磁盘文件名>
```

数据文件单独放在 `file/` 下，宿主自己的 `meta.json`（以及写 meta 用的临时文件）留在 `<id>/` 下；这样用户上传一个叫 `meta.json` 的文件也不会和宿主的 meta 冲突，不需要保留名特例。

`meta.json` 是 v1：

```json
{
  "v": 1,
  "name": "原始显示名",
  "fileName": "磁盘名",
  "size": 5,
  "state": "uploading",
  "createdAt": 0,
  "expiresAt": 86400000
}
```

- `state` 只有 `uploading` / `complete` / `used`。`used` 是**永久保留**标记：撤回的排队消息、失败的 submit、编辑后再发引用过的附件都一直保留。这是有意的保守取舍：宿主现在没有删除对话的功能，宁可多留文件，也不冒险删掉仍在对话里的引用。
- meta 原子写（同目录临时文件再 rename）。完成的数据文件 chmod 0444；这只防误写，不是安全边界（同一 UID 的 bash 能改回来）。
- 磁盘名取 basename，`/ \\` 和控制字符换成 `_`，去首尾空白和开头的 `.`，按 UTF-8 截到 200 字节且不切断码点、尽量保留扩展名，空了叫 `file`。原始显示名只截长度，原样存在 meta 里。
- 一个数据目录只有一个宿主进程（目录锁），所以进程内的一把锁就够：所有 meta 读写、预算检查、`used` 标记、清理都在锁里；submit 在锁内把 meta 改成 `used` 之后才写对话，清理在锁内重新读 meta 再删，因此并发清理不会删掉刚被引用的文件。
- 启动时和之后每 6 小时扫一次：`uploading` / `complete` 且 `expiresAt`（创建后 24 小时）已过的整个目录删除；`used` 永不自动删除；meta 缺失或损坏、且目录超过 24 小时的也删除。有效 meta 只看自己的 `expiresAt`，不看目录 mtime；只有 meta 不可信时才退回目录创建时间。
- 宿主级预算：处于 `uploading` / `complete`（尚未引用）的附件合计最多 20 个、200 MiB；超出时 `beginAttachment` 拒绝并给出明确错误。单条消息最多 10 个附件，每个解码后最多 10 MiB；base64 先按长度检查再解码。磁盘写满时上传调用报错并清掉半截目录。

### 3. 发送、引用权限与版本门控

`submit` / `createConversation` 新增可选参数 `attachments?: readonly string[]`（`FEATURE_SINCE.attachments = 19`）。

- 宿主检查数量 ≤ 10；每个 id 格式合法、meta 存在、状态是 `complete` 或 `used`；数据文件用 **lstat** 检查是普通文件（拒绝符号链接）、长度等于 `size`。任何一条不通过整条调用失败，错误会写清楚原因（过期 / 仍在上传 / 不可用），客户端据此提示重新添加。
- 校验和 `used` 标记在同一把锁里完成。`used` 附件可再次引用：重试（同 requestId）、编辑排队消息（撤回再发）、重试失败运行都直接重传同样的 id，不用重新上传。
- **全宿主的引用权限**：所有已配对设备同等可信，任何设备都能引用宿主上任何附件 id。这是有意的；它不同于 ADR-0027 图片 ref 只在本连接、当前视图内担保。
- 版本门控落在实际发送入口，覆盖重试和编辑排队消息：宿主 < 5.19 时不发 `attachments`，也不显示入口；拖放 / 粘贴非图片文件给出提示。

### 4. 模型看到的格式

有附件时用户内容一定是块列表：`[用户文本块(空文本时省略), 附件块, ...图片块]`。附件块是独立的一个 text 块：

```
<attachments v="1">
The user attached these files. They are read-only originals on this machine: read them with your tools when relevant, and copy one into the working directory before changing it.
<file id="<attachmentId>" name="<原始显示名>" path="<宿主上的绝对路径>" size="<字节数>"/>
</attachments>
```

- 所有属性值统一做 XML 属性转义（`& < > "` 和控制字符），数据目录路径本身也可能含这些字符。
- 不放进系统提示词：附件属于这条消息，fork / 重放时跟着走。
- 压缩后**不保证保留全部附件**：pi-durable 的 compaction 把文本拼起来交给模型摘要，对话记录里的完整附件块仍在。
- 历史消息里的 `path` 是绝对路径：**数据目录不能搬家**；备份必须包含 `attachments/`。搬了之后旧消息里的路径会失效，第一期不做重新解析。

### 5. 客户端推导

- **不改通用的 `textOf`**：它同时用于工具结果，工具读到一个恰好含附件块的文件时不能从界面消失。
- 只在用户条目（`pi.user`）和排队输入（inbox item）的推导里识别附件块，和 skill 块解析放在同一处（`stripUserBlocks`）、一次解析同时得到文本、skills、附件。附件只认**独立的 content text 块**：整个块恰好是 v1 形状才解析，字符串内容或夹着其他文字的 text 块一律当普通文本。身份只从 `id` 取，不从 path 反推；解析出 `{ id, name, size }[]`。
- 用户条目和 `QueuedInput` 都带 `attachments`；排队预览带 `attachmentCount`；编辑排队消息时把附件 id 还原回输入框，重试失败运行时原样重发。
- 识别出来的附件只用于显示，不当作引用授权或文件存在的证明。
- 宿主侧读用户文本的地方（自动起名、摘要首条消息回退）同样跳过附件块。
- `packages/client` 与 `crates/pinomad-core` 逐步镜像，重新生成对照向量；旧客户端连新宿主时气泡里会看到原始 `<attachments>` 文本，可以接受（同 ADR-0028）。

### 6. 界面

- 入口 `+` → Attach files…（Web / 桌面端 `<input type=file multiple>`；拖放、粘贴非图片文件走同一条路）。
- 选中的文件是图片 MIME 时走现有图片附件（ADR-0027，4 张 / 5 MB），其余走附件上传。
- 选中后立即上传，输入框上方和图片同一行显示文件 chip：文件名、大小、进度、失败可重试、可移除。
- 有附件还在上传时，发送按钮禁用并显示 Uploading files…，Enter 也不发送；传完后用户再点发送，不带未完成的附件发出。发送路径上不再有 await，切换对话或输入新内容不会改变这次发送的目标或清掉新草稿。
- 发出去的气泡里显示文件 chip（名字 + 大小），不预览。

## 考虑过的方案

- **把任意文件也 base64 内联进 submit**：不用新调用和磁盘存储；但 10 MB 文件约 13 MB 的帧会堵住同一方向唯一 FIFO 发送器的 submit / abort，正是分块要避免的；宿主也要把大块内容写进 SQLite 和每次快照。
- **客户端给附件 id / 路径**：实现更直接；但客户端可控的路径会变成目录穿越和覆盖的入口，id 必须由宿主生成。
- **按内容哈希去重**：同一文件传两次只存一份；但删除引用计数、撤回和失败引用的语义会复杂很多，第一期明确不做内容去重。
- **完成后即可删除未引用文件**：省磁盘；但撤回、失败、编辑和重试都可能在任意迟的时候再次引用，`used` 永久保留更稳。
- **清理用目录 mtime 判断过期**：不用读 meta；但写文件内容不更新目录 mtime，和“创建后 24 小时”不一致，而且损坏 meta 时更不可信。有效 meta 一律用 `expiresAt`。
- **附件 ref 按连接、当前视图担保（照 ADR-0027）**：更安全；但编辑排队消息要先取字节再撤回，重试和跨设备会很别扭。这里选择全宿主引用权限，代价是任何配对设备都能引用任何 id。

## 后果

- 数据目录多了 `attachments/`，备份必须包含它；目录不能搬家，旧消息里的绝对路径不重解析。
- `used` 永不自动删除，长期使用会积累文件；第一期没有删除对话，也就没有释放引用的入口。
- 旧客户端能连 5.19 宿主，但看不到附件块；气泡里会显示原始 `<attachments>` 文本。
- 压缩后的模型上下文可能不保留全部附件；对话记录里的块仍完整，客户端仍显示 chip。
- 照片仍走原来的图片路径，所以一条消息里图片和文件可以并存：文本、附件块、图片块。
- 新增 upload 状态机（进度、失败重试、上传中禁用发送）和两套解析器（TS / Rust），都要随协议和推导的对照向量维护。
