# Astryx 组件代码的来源与许可证

Web 的基础组件从 Astryx 迁到 shadcn 时（ADR-0048），有几个组件 shadcn 没有对应物，就把 Astryx 的源码移植进来，样式从 StyleX 改写成 Tailwind。解析器、分词器这类纯逻辑原样保留，只改 import、类型和命名前缀；每个移植文件开头保留 Meta 的版权行，并注明来源路径。

- 来源：npm 包 `@astryxdesign/core` 0.3.0 的 `src/`（仓库 [facebook/astryx](https://github.com/facebook/astryx)，`packages/core`）
- 许可：MIT。`@astryxdesign/core` 的 npm 包里没有 LICENSE 文件（`package.json` 写的是 `"license": "MIT"`），下面的原文取自同一仓库发布的 `@astryxdesign/theme-neutral` 0.3.0 的 LICENSE
- 移植的文件：
  - `apps/web/src/shared/ui/markdown/`：`parser.ts`、`streaming.ts`（原样）、`use-streaming-text.ts`（`src/hooks/useStreamingText.ts`）、`markdown.tsx`（`src/Markdown/Markdown.tsx`），以及对应的测试
  - `apps/web/src/shared/ui/code-block/`：`tokenizer.ts`（原样）、`highlight-ranges.ts`（`src/CodeBlock/highlightRanges.ts`）、`code-block.tsx`（`src/CodeBlock/CodeBlock.tsx`）、`code.tsx`（`src/Code/Code.tsx`）、`code-block.css`（`src/CodeBlock/highlightStyles.ts` 和 neutral 主题的语法配色），以及对应的测试
  - `apps/web/src/shared/ui/chat-kit/`：`src/Chat/` 下的输入框、令牌、触发菜单、粘贴转令牌、发送按钮、抽屉、对话布局和滚动、消息列表、消息、元数据、系统消息、工具调用，以及对应的测试；内部用到的 `src/utils/`（`themeProps`、`mergeRefs`、`sharedResizeObserver`、`groupItems`、`getKey`、`BaseProps`）、`src/hooks/`（`useMediaQuery`、`useFocusTrap`）、`src/Layer/`（`useLayer`、`anchorName`）、`src/Popover/usePopover`，以及 `Button`、`Badge`、`Spinner`、`Divider`、`Icon`、`VisuallyHidden` 的精简版；neutral 主题的取值来自 `@astryxdesign/theme-neutral`。图标路径取自 Lucide（ISC，见 [lucide.md](lucide.md)）
  - `apps/web/src/shared/ui/typeahead/`：`src/Typeahead/types.ts`、`createStaticSource.ts` 和 `groupItems`

```text
MIT License

Copyright (c) 2026 Meta Platforms, Inc.

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
