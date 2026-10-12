# Pi 派生代码的来源与许可证

PiNomad 的以下文件派生自 [earendil-works/pi](https://github.com/earendil-works/pi)（Earendil Works，MIT 许可）。各文件头部的注释记录了具体出处；本文件存档上游许可原文。

## Pi

- 项目：[earendil-works/pi](https://github.com/earendil-works/pi)
- 许可证：[MIT](https://github.com/earendil-works/pi/blob/main/LICENSE)
- 派生文件：
  - `apps/host/src/http-dispatcher.ts` —— 复制自 1.0.0 发布的 `packages/coding-agent/src/core/http-dispatcher.ts`，删减至宿主实际调用的部分。
  - `apps/host/src/pi-setup.ts` —— 参照 `packages/coding-agent/src/experimental/durable/harness-setup.ts` 的 `createHarnessSettings` / `configureHarnessHttp` / `findInitialAgentModel`。
  - `packages/protocol/src/view.ts` —— 参照 `packages/coding-agent/src/experimental/durable/runtime.ts` 的 `DurableView` / `DurableViewSource` / `DurableController`。
  - `packages/client/src/chat.ts` —— 推导逻辑参照 `packages/coding-agent/src/experimental/durable/tui.ts` 的 durable TUI。

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
