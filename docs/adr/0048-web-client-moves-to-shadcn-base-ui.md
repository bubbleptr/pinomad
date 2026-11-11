# ADR-0048：Web 客户端的基础组件从 Astryx 换成 shadcn（Base UI 版）

- 状态：Accepted；迁移于 2026-11-11 完成，`@astryxdesign/*` 已删除（#704），§3 的共存期随之结束：仍有人用的 Astryx token 名留在 `tokens.css`，作为手写 CSS 的刻度和对话框抬高一级的表面色阶；§4 的两个开关合成一个，`color-scheme` 也跟 `<html>` 上的 `dark` 类走，不再设 `data-theme`
- 日期：2026-11-11
- 修订：ADR-0014 §1（视觉基础不再建在 Astryx 上，token 以 shadcn 的变量名为准）、§2（不再要求目录和组件与 Pace 同形）

## 背景

ADR-0014 让 Web 客户端建在 Astryx 上，并整套对齐 Pace 的视觉基础，理由是 Pace 已经在 Astryx 上打磨过对话界面，同形才能持续同步。

一个月用下来，情况变了：

- 对话界面（思维链、工具步骤、Composer）已经是自己写的样式，和 Pace 分叉了（ADR-0026）；最近一次从 Pace 复制代码是 2026-10-22。
- Astryx 的组件样式不归我们所有。想改内边距、描边、选中态，只能在 `astryx-theme` 层里用提权选择器（`:not(#\#)` 连写三次）压它的值，`styles.css` 里这类覆盖越积越多。
- 想直接用的第三方组件大多按 shadcn 的约定分发：`components.json`、`@/…/ui/button` 这类路径、`--background` / `--muted-foreground` 这组变量名。在 Astryx 上接它们，每个都要改写。
- Astryx 还在 0.x，和 React 19 一起用已经需要在 `vite.config.ts` 里固定 `react` 的副本。

## 决策

1. **基础组件换成 shadcn 的 Base UI 版**（`style: base-nova`），用 shadcn CLI 把源码生成到 `apps/web/src/shared/ui/`，之后归我们所有、直接改。原语是 `@base-ui/react`，图标继续用 Hugeicons。样式仍是 Tailwind v4，不引入 StyleX。
2. **设计 token 归我们自己，颜色用 shadcn 的变量名。** `apps/web/src/app/tokens.css` 是唯一来源：`--background`、`--foreground`、`--card`、`--popover`、`--primary`、`--muted`、`--muted-foreground`、`--border`、`--sidebar` 等，每个是一组 `light-dark()` 值。浅色取 shadcn 的 neutral，深色保留原来的表面层级（外框最深，主面板、卡片、浮层逐级变亮）。`--muted` 从"次要文字色"变成背景色，文字用 `--muted-foreground`。
3. **迁移期间两套库共存，调色板只有一份。** Astryx 的 token 名（`--color-text-primary`、`--spacing-2` 等）在 `tokens.css` 里指向上面的值，Astryx 组件和我们自己按这些名字写的 CSS 都跟着走。组件按组分批替换，每批一个 PR；调用点直接改成 shadcn 的写法，不做保留 Astryx 属性名的封装层。
4. **深浅色有两个开关，来源相同。** token 跟 `color-scheme` 走（`<html>` 上的 `data-theme`）；Tailwind 的 `dark:` 变体跟 `<html>` 上的 `dark` 类走。两者都由外观设置决定，`theme-boot.js` 在首屏前先设好。
5. **不再与 Pace 同形。** 以后从 Pace 复制组件要先改写成这里的组件和 token。`@/` 别名和 `app/`、`shared/`、`entities/`、`widgets/` 分层不变。
6. **只换 Astryx 提供的组件。** `chat.css` 里自己写的对话组件不在这次范围内；shadcn 自带的 Message、Trace 等对话组件用不用，以后单独决定。iOS 不受影响。

## 考虑过的方案

- **留在 Astryx，只改主题。** 实测过：把圆角和控件高度的 token 调向目标值，按钮确实变了，但整页观感几乎没变，逐组件的覆盖还是要靠提权选择器。
- **裸用 Base UI，样式全部自己写。** 依赖更少，但拿不到 shadcn 生态的兼容性，60 多个组件的样式要从零写。
- **shadcn 加 StyleX。** shadcn 的组件源码是 Tailwind 类，换成 StyleX 等于每个组件手工重写一遍，还要拆掉现有的 Tailwind。
- **先把 Astryx 引用收进 `shared/ui` 的封装层，再换实现。** 封装层要么保留 Astryx 的属性名（留下一层兼容垫片），要么每个调用点改两次。

## 后果

- 迁移是一组堆叠 PR，期间包里同时有 Astryx 和 Base UI。最后一个 PR 删掉 `@astryxdesign/*` 和 `astryx-base`、`astryx-theme` 两个样式层，清掉 `tokens.css` 里已经没人用的 Astryx 名字，并重写 `apps/web/DESIGN.md`。
- 用 shadcn CLI 加组件时在 `apps/web` 下跑；`init` 会改写 CSS 文件，而 `styles.css` 的 `@layer` 顺序不能动，所以新 token 手工合入 `tokens.css`，不让 CLI 改 `styles.css`。
- 纯图标按钮的可访问名称以前由 Astryx 的 `label` 属性提供，迁移后要显式写 `aria-label`；端到端测试按按钮名定位，会拦下漏掉的。
- 次要文字比 Astryx 的 neutral 主题浅一档（浅色 `oklch(0.556 0 0)`，原来约 0.44）。Astryx 组件的错误色（`--color-error`）保留它自己的深色值：它把错误文字画在浅红底上，换成 `--destructive` 对比度只有约 3.4:1。
