# LobeHub Icons 的来源与许可证

Web 客户端设置里 Providers 一节的服务商图标、模型选择器里的模型厂商图标（都在 `apps/web/src/entities/provider/logos/`）取自 [LobeHub Icons](https://github.com/lobehub/lobe-icons) 的静态 SVG，未作修改；单色图标用 `currentColor` 填充，随明暗主题变色。服务商 id 到图标文件的对应在 `apps/web/src/entities/provider/provider-logo.tsx`，模型 id 到厂商图标的对应在 `apps/web/src/entities/model/model-logo.tsx`。

官网首页「用你已经付费的订阅」一节也引用同一批文件中的几个（`apps/site/src/landing/page.css` 里的 `.sub-logo`），只当作 CSS mask 用，统一成单色显示，文件本身不复制、不修改。

iOS 客户端用同一批文件：`apps/ios/scripts/provider-logos.sh` 把它们复制进 `apps/ios/Pinomad/Assets.xcassets/ProviderLogos/`，只改了 Xcode 导入需要的部分（去掉 `<title>` 和 `style`，尺寸写成 24，`currentColor` 换成固定颜色：纯单色的标成模板图随文字变色，和品牌色混用的另存一份深色模式用的白色版本）。对应表在 `apps/ios/PinomadCore/Sources/PinomadChat/Providers.swift`。

- 来源：npm 包 `@lobehub/icons-static-svg`，固定版本 1.98.0
- 许可：MIT，原文如下。许可只覆盖这些 SVG 文件本身；图标里的名称和标志是各公司的商标，归其所有者，这里仅用来指明对应的服务商或模型厂商

```text
MIT License

Copyright (c) 2023 LobeHub

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
