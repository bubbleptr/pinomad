# 消息里带图片：上游与现有代码的支持程度

核查日期：2026-10-13。对应 issue [bubbleptr/pinomad#67](https://github.com/bubbleptr/pinomad/issues/67)。本文只记录现状，不给要做什么的建议。

## 版本与证据

- 上游包锁在 `1.0.4`（ADR-0002），见 [apps/host/package.json 11–16 行](../../apps/host/package.json#L11-L16)。npm 元数据里 `pi-durable`、`pi-ai`、`pi-agent-core`、`pi-mcp` 1.0.4 的 `gitHead` 都是 `7c10bd4337495ee613f2224843ecdf349b80d1df`（2026-10-05），仓库是 `package.json` `repository` 字段给的 [earendil-works/pi](https://github.com/earendil-works/pi)。下文 1.0.4 的源码链接都锁定这个提交，记作 `@7c10bd4`。另外抽查了本地安装的 `dist/`，与源码一致：`read.js` 里有 `unsupported_image`，`transform-messages.js` 里有不支持图片时的占位文本，Durable 的 `dist/` 里没有出现 `inputLimits`。
- 上游 main 取的是 `7bd01fb92485c06f92ecfff7ccf3197148bc16af`（2026-10-12），记作 `@main`。npm 上 `pi-durable` 最新版是 `1.1.0`（2026-10-07）。
- PiNomad 代码取自分支 `research/message-images` 的 `53380b1`，链接用仓库内的相对路径。
- 结论来自源码阅读和官方文档，**没有实际给 provider 发过图片，也没有跑端到端测试**。凡是推断出来、没有执行验证的地方都标了「推断」或「未核实」。

## 结论先行

- **类型层面，上游从头到尾都能带图。** Durable 的 `UserInput` 就是 pi-ai `UserMessage["content"]`，可以是 `string | (TextContent | ImageContent)[]`。`submit` 的三种情况（新起一轮、steer、follow-up）走的是同一个字段。Anthropic、OpenAI（Responses 和 Completions）、Google 的适配器都会把用户消息和工具结果里的图片块转成各自的格式。
- **PiNomad 现在只传文本。** 协议的 `submit` 和 `createConversation` 只有 `text: string`，宿主调用 Durable 时传的是 `content: text`。客户端推导用户消息时只取文本块，Web 的 Composer 也没有附件入口。
- **工具结果的图片已经进入模型上下文。** MCP 的图片经 `toLlmContent` 变成 pi-ai 的图片块，写进 `pi.tool-result` 条目，模型上下文原样带上。Web 的工具卡片会显示这些图片。**移动端不显示图片，只显示一行「N images」。**
- **在 1.0.4 的 Durable 路径上，没有任何代码按图片限制压缩、校验或拒绝图片。** pi-ai 的模型目录里记了每个模型的 `inputLimits`（默认 2000×2000、base64 后 4.5 MiB），但 pi-ai 和 Durable 1.0.4 都不读它，只有 Pi CLI（pi-coding-agent）读。
- **read 读图片，上游 main 已经做了，但还没发版。** 2026-10-09 的 [42a3497d](https://github.com/earendil-works/pi/commit/42a3497d03ad17e308a2299fa824727894f2c0ec) 让 `read` 返回图片块，记在 CHANGELOG 的 Unreleased 下，1.1.0 不含。roadmap「等上游」一节写的「截至 2026-10-07 上游 main 没有」已经过时。

## 1. 用户 → agent

### 1.1 上游类型：Durable / pi-ai / pi-agent-core

| 核查点 | 结论 | 证据 |
| --- | --- | --- |
| pi-ai 的图片块 | `ImageContent = { type: "image"; data: string /* base64 */; mimeType: string }`，只能 inline base64，没有 URL 和 file_id 形式。 | [ai/src/types.ts 413–417 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/types.ts#L413-L417) |
| pi-ai 用户消息 | `UserMessage.content: string \| (TextContent \| ImageContent)[]` | [types.ts 542–546 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/types.ts#L542-L546) |
| pi-ai 工具结果 | `ToolResultMessage.content: (TextContent \| ImageContent)[]` | [types.ts 596–610 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/types.ts#L596-L610) |
| Durable 的输入类型 | `UserInput = UserMessage["content"]`。`SubmissionDraft` 的 `type: "input"` 带 `content: UserInput` 和 `whenBusy?: "steer" \| "followUp" \| "reject"`。新起一轮、steer、follow-up 都走这一个结构。 | [durable/src/harness/types.ts 52–70 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/types.ts#L52-L70) |
| 排队 | 忙时的输入写进 `pi.inbox` 文档，条目是 `{ id, mode: "steer" \| "followUp", content }`，`content` 就是 `UserInput` 的 JSON。 | [inbox.ts 9 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/inbox.ts#L9)、[submissions.ts 176–186 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/submissions.ts#L176-L186) |
| 落成条目 | 到边界时变成 `{ role: "user", content, timestamp }`，写成 `pi.user` 条目。 | [inbox.ts 96–101 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/inbox.ts#L96-L101) |
| 入口校验 | `submit` 对 content 只做 `copyJson`，没看到对图片 mimeType、大小、数量或模型是否支持图片的检查。 | [submissions.ts 176–179 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/submissions.ts#L176-L179)（推断：只读了这条路径，没有穷举 Durable 的全部校验点） |
| pi-agent-core | Durable 1.0.4 的依赖只有 `chord`、`pi-ai`、`diff`、`typebox`，不依赖 `pi-agent-core`。agent-core 是 Pi CLI 的 agent 循环，它的 `prompt(input, images?)` 和 `steer` / `followUp` 也能带图，但 PiNomad 的路径不经过它。 | [durable/package.json 102–107 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/package.json#L102-L107)、[agent/src/agent.ts 299–373 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/agent/src/agent.ts#L299-L373) |

### 1.2 pi-ai 1.0.4 的 provider 支持

**模型不支持图片时怎么办：** `transformMessages` 先检查 `model.input` 有没有 `"image"`。没有的话，用户消息里的图片换成 `(image omitted: model does not support images)`，工具结果里的换成 `(tool image omitted: …)`。所有适配器在序列化之前都会先走这一步。见 [api/transform-messages.ts 12–55、74 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/transform-messages.ts#L12-L55)。

**各适配器怎么序列化：**

| 适配器 | 用户消息里的图片 | 工具结果里的图片 |
| --- | --- | --- |
| Anthropic Messages | `{ type: "image", source: { type: "base64", media_type, data } }`，`media_type` 直接强转成 jpeg/png/gif/webp 之一，不做转换。[anthropic-messages.ts 1355–1380 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/anthropic-messages.ts#L1355-L1380) | 放进 `tool_result.content`；只有图片没有文本时补一条 `(see attached image)`；`is_error` 原样带上。[137–183 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/anthropic-messages.ts#L137-L183)、[1294–1301 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/anthropic-messages.ts#L1294-L1301) |
| OpenAI Responses | `input_image`，`image_url` 是 data URL，`detail: "auto"`。[openai-responses-shared.ts 230–247 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/openai-responses-shared.ts#L230-L247) | function output 里放 `input_image`。[83–104 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/openai-responses-shared.ts#L83-L104) |
| OpenAI Chat Completions | `image_url`，内容是 data URL。[openai-completions.ts 1265–1283 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/openai-completions.ts#L1265-L1283) | tool 消息只放文本；图片另起一条 user 消息，开头是 "Attached image(s) from tool result:"。[1405–1465 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/openai-completions.ts#L1405-L1465) |
| Google Generative AI / Vertex | `inlineData: { mimeType, data }`。[google-shared.ts 203–225 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/google-shared.ts#L203-L225) | Gemini 3 及以上把图片放进 functionResponse 的 `parts`；更早的版本另起一条 user 消息。[285–336 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/google-shared.ts#L285-L336) |

Bedrock、Mistral 等其他适配器也处理 `"image"`（从 `grep` 结果看），本文没有逐个读。

**哪些模型能收图片，以 1.0.4 安装包 `dist/providers/data/*.json` 的统计为准：** 各 provider 的 chat 模型里 `input` 含 `"image"` 的数量：anthropic 16/16、openai 42/44、openai-codex 8/9、google 22/22、google-vertex 14/14、github-copilot 33/34、amazon-bedrock 142/185、xai 4/4、mistral 13/32、openrouter 268/398、deepseek 1/2、ant-ling 0/3。目录数据由 [scripts/generate-models.ts](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/scripts/generate-models.ts) 生成。

**pi-ai 记下的限制元数据：** 类型是 `ModelInputLimits { maxRequestBytes?, images?: { resize?: { maxWidth, maxHeight, maxBytes, jpegQuality }, maxPerMessage?, maxPerRequest? } }`，见 [types.ts 1075–1107 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/types.ts#L1075-L1107)。生成脚本给每个能收图片的模型配了默认 `resize`：2000×2000、`maxBytes` 4.5 MiB（base64）、JPEG 质量 80。另外按 provider 叠加：

| provider | 生成脚本写入的值 |
| --- | --- |
| anthropic | `maxRequestBytes` 32 MiB；`maxPerRequest` 为 100（contextWindow 200k 的模型）或 600 |
| openai | `maxRequestBytes` 512 MiB；`maxPerRequest` 1500 |
| google | `maxRequestBytes` 20 MiB；`maxPerRequest` 3600 |
| amazon-bedrock | `maxPerMessage` 20 |
| 其他 | 只有默认的 `resize` |

出处：[generate-models.ts 421–429 行、994–1020 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/scripts/generate-models.ts#L994-L1020)。安装包数据里所有能收图片的模型，`resize` 都是同一组值。

**这些元数据在 PiNomad 的路径上没有生效。** 在 `@7c10bd4` 的 `packages/ai/src`、`packages/durable/src`、`packages/agent/src`、`packages/mcp/src` 里 grep `inputLimits` 和 `resize`，除了类型定义只命中 `faux.ts`。读这些字段的只有 pi-coding-agent，比如 [agent-session.ts 693–694 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/agent-session.ts#L693-L694) 在 Pi CLI 里压缩工具结果图片。**推断：** 经 Durable 1.0.4 发出去的图片是多大就发多大，超限时由 provider 返回错误。

**provider 官方文档的限制（2026-10-13 抓取）：**

| provider | 格式 | 单张 | 单请求 | 来源 |
| --- | --- | --- | --- | --- |
| Anthropic（Claude API） | JPEG、PNG、GIF、WebP；动图只取第一帧 | base64 后 10 MB（Bedrock、Google Cloud 上是 5 MB）；最大 8000×8000 px；一个请求超过 20 张图时每张的尺寸上限更严，建议每边不超过 2000 px。长边超过 1568 px（Claude 4.7 及以后是 2576 px）会被缩小；computer use / browser use 返回的超限 `tool_result` 图片直接报错，不缩小 | 200k 上下文的模型 100 张，其余 600 张；标准端点请求体 32 MB | [Vision 文档：Image limits and costs](https://platform.claude.com/docs/en/build-with-claude/vision#request-limits) |
| OpenAI | PNG、JPEG、WEBP、非动图 GIF | 每张最多 30,000 patches，超过直接拒绝，不会自动缩小；另有按模型和 `detail` 的缩放规则 | 总 payload 512 MB；1,500 张 | [Images and vision：Image input requirements](https://platform.openai.com/docs/guides/images-vision#image-input-requirements) |
| Google Gemini API | PNG、JPEG、WEBP、HEIC、HEIF（没有列 GIF） | 文档没给单张上限 | inline 数据时整个请求 20 MB，更大的走 File API；3,600 张 | [Image understanding](https://ai.google.dev/gemini-api/docs/image-understanding) |

格式上要留意两点。Durable 自己的图片识别只认 JPEG、PNG、GIF、WebP、BMP（[tools/image.ts 46–53 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/tools/image.ts#L46-L53)），但这只用在 `read` 上，用户消息不经过它。Anthropic 和 OpenAI 都不收 HEIC。手机相册里的照片是不是 HEIC，本文未核实。

### 1.3 PiNomad 现在怎么传用户消息

| 环节 | 现状 | 证据 |
| --- | --- | --- |
| 协议调用 | `createConversation` 和 `submit` 的参数都只有 `text: string`，没有内容块字段。协议版本是 `{ major: 5, minor: 2 }`。 | [packages/protocol/src/frames.ts 86、93–118 行](../../packages/protocol/src/frames.ts#L86-L118) |
| 帧校验 | `submit` 要求 `typeof args.text === "string"`，`createConversation` 要求 `nonempty(args.text)`。 | [frames.ts 282–286 行、314–321 行](../../packages/protocol/src/frames.ts#L282-L321) |
| 宿主转交 | gateway 把 `text` 当 `content` 交给 `conversation.submit`；`createConversation` 在 organization.ts 里也一样。 | [apps/host/src/gateway.ts 1070–1077 行](../../apps/host/src/gateway.ts#L1070-L1077)、[organization.ts 114–116、184–185、196–197 行](../../apps/host/src/organization.ts#L184-L185) |
| 标题 | 对话标题只取文本块。 | [gateway.ts 705–709 行](../../apps/host/src/gateway.ts#L705-L709) |
| 客户端推导 | `ChatEntry` 的 user 项只有 `text`，`textOf` 丢掉非文本块；排队项同样只取文本；`transcript()` 也一样。 | [packages/client/src/cot-view.ts 55、124–129、449–451 行](../../packages/client/src/cot-view.ts#L449-L451)、[chat.ts 51–57 行](../../packages/client/src/chat.ts#L51-L57)、[protocol/src/transcript.ts 10–21 行](../../packages/protocol/src/transcript.ts#L10-L21) |
| Web Composer | 移植自 Pace 时明确去掉了 attachments；「+」菜单只有 Compact。 | [apps/web/src/shared/ui/chat/chat-prompt-input.tsx 1–6 行](../../apps/web/src/shared/ui/chat/chat-prompt-input.tsx#L1-L6)、[widgets/composer/conversation-composer.tsx 78–88 行](../../apps/web/src/widgets/composer/conversation-composer.tsx#L78-L88) |
| 模型是否收图 | `ModelSummary` 没有 `input` 字段，客户端不知道当前模型能不能收图片；模型选择器移植时也去掉了 "image badge"。 | [protocol/src/view.ts 18–23 行](../../packages/protocol/src/view.ts#L18-L23)、[apps/web/src/entities/model/model-selector.tsx 1–5 行](../../apps/web/src/entities/model/model-selector.tsx#L1-L5) |
| 移动端 | 依赖里没有选图、剪贴板、图片显示相关的 Expo 包（只有 `expo-camera`，用来扫码配对）。 | [apps/mobile/package.json 10–36 行](../../apps/mobile/package.json#L10-L36) |

按 ADR-0018 的规则推断，协议改动涉及这几处：`submit` / `createConversation` 加一个可选的内容块字段（新增可选字段要加 `minor`）；`validCallArgs` 加校验；gateway 和 organization.ts 改成传 `content`；`packages/client` 的 user 项和排队项要带上图片；`ModelSummary` 加一个是否支持图片的字段。上游这边不用改。

### 1.4 线路：安全通道、中继、回环

| 环节 | 限制 | 证据 |
| --- | --- | --- |
| 安全通道记录层 | 一个文本帧（整条 JSON）被切成若干 Noise 记录，每条明文最多 65,518 字节（65535 − 16 − 1）；接收端在 `#pending` 里拼回完整帧。拼接没有总长上限。 | [packages/protocol/src/secure-channel.ts 84–128 行](../../packages/protocol/src/secure-channel.ts#L84-L128) |
| 宿主发送 | 一帧的所有记录连续发出，等最后一条被 transport 接受后才发下一帧（背压）。 | [gateway.ts 320–335 行](../../apps/host/src/gateway.ts#L320-L335) |
| 中继 | 单条 WebSocket 消息上限 `MAX_PAYLOAD` 128 KiB，大于一条 Noise 记录，所以多 MB 的帧只是多几条记录，不会被拒。拼接后每个方向 1 MiB 高水位暂停读取、256 KiB 恢复；64 KiB 的 `MAX_BUFFERED` 只管 accept 之前的握手消息。 | [apps/relay/src/relay.ts 42–50、103–115、243 行](../../apps/relay/src/relay.ts#L42-L50) |
| 回环 token 连接、LAN 监听 | `new WebSocketServer({ server: http })` 没设 `maxPayload`，ws 8.22.0 默认是 100 MiB。回环 token 连接是明文整帧发送，所以这条连接上单帧最大 100 MiB；安全通道上每条消息只是一条记录。 | [gateway.ts 173、457 行](../../apps/host/src/gateway.ts#L173)；ws 默认值见 `node_modules/.bun/ws@8.22.0/node_modules/ws/lib/websocket-server.js` 74 行 |
| 宿主连中继 | `relay-link.ts` 用 ws 客户端，没设 `maxPayload`，默认也是 100 MiB。 | [apps/host/src/relay-link.ts 116、162 行](../../apps/host/src/relay-link.ts#L162) |

**体积估算（推断，没有实测）：** 图片按 base64 内联在 JSON 里，体积约为原文件的 4/3。比如 pi-ai 默认上限的 4.5 MiB base64，按 65,518 字节一条大约切成 72 条记录。更值得注意的是下行：

- 订阅 `conversation:<id>` 时，gateway 先发一个 snapshot，里面是 Durable `ConversationView` 的全部活动条目（[gateway.ts 980–983 行](../../apps/host/src/gateway.ts#L980-L983)、[durable view.ts 26–32 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/view.ts#L26-L32)）。所以对话里已有的每张图（用户发的和工具结果里的）会在每次订阅、重连时整段重发一次，经过中继时也一样。
- 新条目通过 ops 下发，也带着完整的图片 base64。
- 排队中的图片在 `pi.inbox` 文档里，也随 view 的 `docs` 下发。

### 1.5 Durable 怎么存

| 核查点 | 结论 | 证据 |
| --- | --- | --- |
| 条目存储 | SQLite 的 `entries.record` 是一个 `TEXT` 列，存整条 JSON，图片 base64 直接内联在里面，没有单独的 blob 表或去重。 | [storage/sqlite/migrations.ts 28–34 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/storage/sqlite/migrations.ts#L28-L34) |
| 排队中的输入 | 存在 `pi.inbox` 文档里（`history: "latest"`），每次修改写一条 `document_revisions` 的 base 或 delta；写新 base 时删掉旧 revision。所以带图的 delta 可能保留到下一次写 base（推断，保留多久未核实）。 | [inbox.ts 16–20 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/inbox.ts#L16-L20)、[storage.ts 835–848 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/storage/sqlite/storage.ts#L835-L848) |
| 工具结果 | `appendToolResult` 把 content（含图片）原样写进 `pi.tool-result` 条目。 | [harness/tool.ts 445–469 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/tool.ts#L445-L469) |
| fork | fork 通过 `entryId` 看到父对话的条目，不复制（ADR-0007、GLOSSARY 的 Fork）。所以 fork 不会让图片多存一份（推断）。 | — |
| 压缩 | 摘要的输入只取文本块，图片不进摘要；压缩后图片离开模型上下文，但条目还在库里。 | [harness/compaction.ts 351–385 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/compaction.ts#L351-L385) |
| 单值上限 | SQLite 默认 `SQLITE_MAX_LENGTH` 是 10 亿字节，单张图片碰不到。 | [SQLite Limits](https://www.sqlite.org/limits.html) |

## 2. agent → 用户

### 2.1 MCP 工具结果的图片现在怎么流到 Web

1. pi-mcp 的 `toLlmContent`：MCP 的 `image` 块直接变成 `{ type: "image", data, mimeType }`；`mimeType` 是 `image/*` 的嵌入式 `resource` blob 也变成图片；audio 和其他二进制资源变成文本占位。见 [mcp/src/protocol/content.ts 74–117 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/mcp/src/protocol/content.ts#L74-L117)。
2. 宿主的 `direct` 工具在 `execute` 里返回 `{ content: toLlmContent(result), isError }`，见 [apps/host/src/mcp.ts 198–214 行](../../apps/host/src/mcp.ts#L198-L214)。codemode 脚本调 MCP 拿到的是原始 `CallToolResult`；脚本的 `image()` 输出和截断后的文本一起返回，截断只截文本，图片保留，见 [extensions/codemode.ts 409–419 行、453–470 行](../../apps/host/src/extensions/codemode.ts#L409-L419)。
3. Durable 的 `boundContent` 只限制文本，「other content is kept」，所以图片不受输出上限约束（[harness/tool.ts 477–493 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/tool.ts#L477-L493)）。然后 `appendToolResult` 写进条目（同文件 445–469 行）。
4. 客户端：`packages/client` 的 `imagesOf` 从结果 content 里取出图片块，放进 `ToolItem.images`（[cot-view.ts 131–138、258、288 行](../../packages/client/src/cot-view.ts#L131-L138)、[tool-item.ts 25–26 行](../../packages/client/src/tool-item.ts#L25-L26)）。Web 的 `ChatToolDetail` 用 `<img src="data:…;base64,…" style="max-width:100%">` 显示在工具卡片的展开区里，有图片时这一行可以展开（[apps/web/src/shared/ui/chat/chat-tool.tsx 32–41、85–92 行](../../apps/web/src/shared/ui/chat/chat-tool.tsx#L85-L92)）。这是 ADR-0012 第 38 行定下的。

### 2.2 移动端：不显示图片

`apps/mobile` 的 `ToolRow` 拿到 `tool.images` 后只显示一行文字「N image(s)」，没有 `<Image>`，也不在展开区里显示（[apps/mobile/src/widgets/transcript/transcript.tsx 103–110 行](../../apps/mobile/src/widgets/transcript/transcript.tsx#L103-L110)）。另外 `expandable` 只看 `argsText` 和 `output`（同文件 82 行），所以一个只有图片的结果点不开。用户消息只显示文本（同文件 31 行起的 `UserBubble`）。

### 2.3 工具结果里的图片会不会进模型上下文

**会，而且不用等上游。** Durable 从条目推导模型上下文时，除了被 `omit` / `replace` 的条目和 aborted/error/deferred 的 assistant 消息，`entry.model` 原样带上（[harness/context.ts 72–81 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/harness/context.ts#L72-L81)）。工具结果里的图片块就这样进了请求，再由 1.2 节表里的适配器序列化。如果模型不支持图片，就换成占位文本。所以 Playwright MCP 之类的截图结果，现在已经同时出现在 Web 卡片和模型上下文里。这是从代码推断的，没有用真实 MCP server 和真实模型跑过，**未核实**。

需要注意的上游问题：

- **Anthropic 不接受带图片的错误结果。** 上游 issue [#10794](https://github.com/earendil-works/pi/issues/10794)（open，`prio:p0`）：`isError: true` 的工具结果里有图片时，Anthropic 返回 400 `all content must be type text if is_error is true`，会话卡住。1.0.4 的 `convertToolResult` 照原样发出 `is_error`（[anthropic-messages.ts 1294–1301 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/api/anthropic-messages.ts#L1294-L1301)）。截至 `@main`，这个函数没有相应改动（`git log` 里该文件最近三次提交和它无关）。PiNomad 里两条路会产生这种结果：MCP 的 `isError` 加图片（[mcp.ts 212 行](../../apps/host/src/mcp.ts#L212)），以及 codemode 脚本先 `image()` 再失败（[codemode.ts 343 行](../../apps/host/src/extensions/codemode.ts#L343)）。后者就是 issue 里的复现方式（推断，没有实测）。
- **没有压缩，也没有张数控制。** 1.0.4 的 Durable 路径不读 `inputLimits`（见 1.2 节）。Anthropic 文档说 computer use / browser use 返回的超限 `tool_result` 图片会直接报错，其他图片一般是缩小；一个请求超过 20 张图时尺寸上限更严，历史轮次里的图片也算（[Vision 文档](https://platform.claude.com/docs/en/build-with-claude/vision#request-limits)）。截图多的长对话会不会碰到这些限制，未核实。

### 2.4 上游 read 读图片的进展

- **1.0.4：** `read` 识别出图片后返回 `isError: true` 和一条 `unsupported_image` 诊断（[tools/read.ts 114–131 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/src/tools/read.ts#L114-L131)），README 写的是 "Reading images is not supported yet"（[README.md 149 行](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/README.md?plain=1#L149)）。
- **1.1.0（2026-10-07，npm latest）：** CHANGELOG 里没有和图片有关的条目。
- **`@main`：** 提交 [42a3497d](https://github.com/earendil-works/pi/commit/42a3497d03ad17e308a2299fa824727894f2c0ec)（2026-10-09，"feat(durable): read returns images, optional Photon image processor"）让 `read` 返回一个图片块。限制取会话模型的 `inputLimits.images.resize`，默认 2000×2000、base64 后 4.5 MB。没配处理器时，限制以内的 PNG/JPEG/GIF/WebP 原样发送，超限的和 BMP 返回错误。用 `createCodingTools({ images })` 时，会按 EXIF 转正、把 BMP 转成 PNG、缩小到限制以内；处理器基于 Photon（WebAssembly），从 `@earendil-works/pi-durable/images`、`/images/node` 引入，后者在 worker 线程里运行。模型不收图片时，read 会附一条诊断说模型只看到占位文本。见 [CHANGELOG Unreleased 27 行](https://github.com/earendil-works/pi/blob/7bd01fb92485c06f92ecfff7ccf3197148bc16af/packages/durable/CHANGELOG.md?plain=1#L27)、[README 153–162 行](https://github.com/earendil-works/pi/blob/7bd01fb92485c06f92ecfff7ccf3197148bc16af/packages/durable/README.md?plain=1#L153-L162)。**还没有进任何已发布版本。**
- `@main` 的 harness 里，用户输入和非 read 的工具结果仍然没有压缩或按限制处理的代码：`git grep -i image origin/main -- packages/durable/src/harness` 只命中 `tool.ts` 的类型和 `outputValue`。

## 3. 汇总

| 项 | 状态 | 依据 |
| --- | --- | --- |
| Durable 和 pi-ai 的用户消息带图片块（新起一轮、steer、follow-up） | 现成 | 1.1 节 |
| Anthropic / OpenAI / Google 适配器序列化用户消息和工具结果里的图片 | 现成 | 1.2 节 |
| 模型不支持图片时换成占位文本 | 现成 | transform-messages.ts 12–55 行 |
| 安全通道和中继承载多 MB 的帧（分块、背压） | 现成（没有实测） | 1.4 节 |
| Durable 存储图片（内联在 JSON TEXT 里） | 现成，体积随图片线性增长 | 1.5 节 |
| MCP 图片 → 工具结果 → 模型上下文 | 现成（没有端到端实测） | 2.1、2.3 节 |
| Web 工具卡片显示结果里的图片 | 现成 | chat-tool.tsx 85–92 行 |
| 协议 `submit` / `createConversation` 带内容块 | 要我们做 | frames.ts 93–118、282–321 行 |
| gateway / organization.ts 把内容块交给 Durable | 要我们做 | gateway.ts 1070–1077 行、organization.ts |
| `packages/client` 推导用户消息和排队项里的图片 | 要我们做 | cot-view.ts 449–451 行、chat.ts 51–57 行 |
| Web Composer 的粘贴或附件入口，用户气泡显示图片 | 要我们做 | chat-prompt-input.tsx 1–6 行 |
| 移动端选图或粘贴入口、用户气泡和工具卡片显示图片 | 要我们做（工具卡片现在只显示「N images」） | transcript.tsx 82、103–110 行 |
| 告诉客户端当前模型能不能收图片 | 要我们做（`ModelSummary` 没有这个字段） | view.ts 18–23 行 |
| 用户图片和工具结果图片按 `inputLimits` 压缩或校验 | 1.0.4 和 `@main` 的 Durable 都没有（只有 Pi CLI 和 `@main` 的 read 有）；不做的话超限由 provider 报错 | 1.2、2.3 节 |
| 订阅 snapshot 每次整段重发历史图片 | 现有行为，体积代价是我们这边的 | gateway.ts 980–983 行 |
| read 读图片 | 卡在上游：`@main` 已有（42a3497d），还没发版；1.0.4 和 1.1.0 都没有 | 2.4 节 |
| Anthropic 上带图片的 `isError` 工具结果返回 400 | 卡在上游：#10794 open | 2.3 节 |

## 未核实

- 没有用真实 provider 发过带图片的用户消息或工具结果；1.2 节的「现成」只是从代码推断。
- 没有用 Playwright MCP 和 PiNomad 跑过端到端截图。
- 没有测过多 MB 帧经中继的耗时和内存。
- `pi.inbox` 里带图的 delta 保留多久。
- Bedrock、Mistral、Codex 等适配器的图片处理细节。
- 手机照片的默认格式，以及它和 Anthropic、OpenAI 支持格式的关系。
