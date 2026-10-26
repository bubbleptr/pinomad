# SwiftMath 的来源与许可证

AgentChatKit 用 [SwiftMath](https://github.com/mgriebling/SwiftMath) 把回复里的 TeX 公式（`$…$`、`$$…$$`、`\(…\)`、`\[…\]`、```` ```math ````）画成图，嵌进 iOS App 的对话正文。

- 来源：SwiftPM 依赖，锁定 1.7.3（`packages/agent-chat-kit/Package.swift`）
- 许可：MIT，原文如下
- 字体：包里的 `mathFonts.bundle` 随 App 分发，其中 Latin Modern Math、TeX Gyre Termes Math 用 GUST Font License，其余数学字体用 SIL Open Font License 1.1；两份许可证原文就在这个 bundle 里（`GUST-FONT-LICENSE.txt`、`OFL.txt`），和字体一起进 App

```text
MIT License

Copyright (c) 2023 Computer Inspirations

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
