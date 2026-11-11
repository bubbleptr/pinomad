# Web 界面设计规则

Web 和桌面端（renderer 就是 `apps/web`）共用这份规则。按钮、表单控件和反馈组件（提示条、徽标、toast 等）是 `src/shared/ui/` 里的 shadcn（Base UI 版）组件；其余组件还来自 Astryx（`@astryxdesign/core`，迁移中，ADR-0048），它们的 props 用 `bunx astryx component <Name>` 查（在 `apps/web` 下跑）。

## 按钮

按钮只用 `src/shared/ui/button.tsx` 的 `Button`（带文字）和 `src/shared/ui/icon-button.tsx` 的 `IconButton`（只有图标，`label` 必填，作为无障碍名称），`variant` 只有四档，没有别的：

| variant | 样子 | 用在哪 |
|---|---|---|
| `primary` | 强调色实底 | 完成当前流程的那一步：Save、Sign in、Pair、Create account。一个对话框或一屏最多一个。 |
| `secondary`（默认） | 表面色底 + 1px 描边 + 1px 投影 | 其余所有带文字的独立动作：设置行里的 Refresh / Remove / Connection / Unpair，对话框页脚的 Cancel / Close，打开危险确认的那个按钮（Delete account、Log out）。 |
| `ghost` | 透明，只有字或图标 | 只有下面四种情况，见流程图。 |
| `destructive` | 浅红底红字 | 不可撤销动作的**最后一步确认**，旁边必须有一个 `secondary` 的 Cancel。 |

每档的样子只写在 `button.tsx` 的 `buttonVariants` 里。`secondary` 有描边和投影，是因为只有浅灰底时放在输入框旁边像一段文字，深色下几乎看不见。`destructive` 的字用 `--destructive-strong`：`--destructive` 画在浅红底上对比度只有约 3.4:1。不要在调用处用 `className` 给按钮加边框、阴影或背景。

文字写成 children，图标放在文字前面（`<Button><Plus aria-hidden="true" />Add</Button>`）。另有两个属性：`loading` 在文字上盖一个转圈并禁用按钮，宽度和无障碍名称不变；`tooltip` 悬停和聚焦时显示，禁用的按钮带 `tooltip` 时仍能用键盘聚焦。默认 `type="button"`，提交表单要写 `type="submit"`。

### 选哪一档

```
这个按钮完成当前流程（提交、保存、配对）？
├─ 是 → primary（同屏已经有 primary 了？那它就不是主动作 → secondary）
└─ 否 → 它确认一个不可撤销的删除 / 解除配对 / 登出？
   ├─ 是，而且是确认的最后一步 → destructive
   └─ 否 → 它属于下面任一种？
      ├─ 只有图标（IconButton）：侧栏、顶栏、工具栏、行内悬浮操作 → ghost
      ├─ 应用外框里的文字触发器：侧栏底部账号、顶栏面包屑、输入框工具栏（模型选择、Follow-up） → ghost
      ├─ 对话消息上的操作行（Edit、Retry、Withdraw）；行里最该点的那个可以用 secondary → ghost
      ├─ 切到另一条流程的文字链接：“Sign in instead”、“Create an account”、“Use an API key instead”、“Have a pairing link?” → ghost
      └─ 都不是 → secondary
```

“都不是”是常态：拿不准时用 `secondary`。按钮单独放在内容区里却用 `ghost`，看起来就是一段文字，用户找不到它。

### 文字

按钮和菜单项的文字不加省略号，打开对话框或菜单的也一样（Sign out、Unpair、Add a host）。省略号只用在进行中的状态（Loading…、Thinking…）和输入框的占位文字里。

### 尺寸

- 列表行（`ListItem` 的 `endContent`）、行内表单、卡片里：`size="sm"`（28px）。
- 对话框页脚、整屏的表单提交：默认的 `md`（32px）。
- `IconButton` 也是 `md` / `sm` 两档。
- 同一行的按钮用同一个尺寸。

### 例子

对的：设置行里的独立动作有边框，危险操作先开确认、确认时才用 `destructive`。

```tsx
<ListItem
  label={device.name}
  endContent={<Button variant="secondary" size="sm" onClick={onUnpair}>Unpair</Button>}
/>

<div className="flex gap-2">
  <Button variant="destructive" loading={busy} onClick={submit}>Delete account</Button>
  <Button variant="secondary" onClick={close}>Cancel</Button>
</div>
```

错的：独立动作用 `ghost`（读成纯文字），打开确认的按钮就用 `destructive`（还没确认就在报警）。

```tsx
<ListItem label={device.name} endContent={<Button variant="ghost" size="sm">Unpair</Button>} />
<Button variant="destructive" onClick={() => setOpen(true)}>Delete account</Button>
```

四档并排的样子和加载、禁用状态见 Storybook 的 `Shared/ButtonTiers`（`src/shared/ui/button-tiers.stories.tsx`），明暗两套都要看。

### 表单控件

输入框、选择器等也在 `src/shared/ui/`：`input.tsx`、`textarea.tsx`、`select.tsx`、`combobox.tsx`（带搜索的选择器）、`checkbox.tsx`、`switch.tsx`、`radio-group.tsx`、`segmented-control.tsx`。名称、说明和错误用 `field.tsx` 的 `Field` / `FieldLabel` / `FieldDescription` / `FieldError` 包起来，它们自动关联到控件（`for`、`aria-describedby`）；只给读屏的名称用 `<FieldLabel className="sr-only">`。

### 不归这里管的

原生 `<button>` 做的可点区域不是动作按钮，不套这四档：设置里的提供方磁贴、侧栏会话行、附件和图片预览、问题卡片的分段指示。它们的样式跟着各自的组件走。

### iOS 对照

iOS（`apps/ios`）不用这份 CSS，但分档一致：`primary` ↔ `.borderedProminent` / `.glassProminent`，`secondary` ↔ `.bordered` / `.glass`，`ghost` ↔ `.plain` / `.borderless`，`destructive` ↔ `role: .destructive`。改 iOS 按钮另开 PR。

## 反馈

状态和通知用 `src/shared/ui/` 里这几个组件，样子和颜色都写在组件里，调用处不加 `className` 改底色或字色。各自的样子见 Storybook 的 `Shared/Feedback`（`src/shared/ui/feedback.stories.tsx`），明暗两套都要看。

| 组件 | 用在哪 |
| --- | --- |
| `alert.tsx` 的 `Alert` | 一直留着、直到情况变了才消失的说明：操作失败、连接断了、请求过期。`variant` 是 `info` / `success` / `warning` / `destructive`，图标随 `variant` 自动给。里面依次放 `AlertTitle`、可选的 `AlertDescription` 和 `AlertAction`（行尾的按钮，`size="sm"` 或默认尺寸都行）。`warning` 和 `destructive` 的角色是 `alert`，会打断读屏；`info` 和 `success` 是 `status`。贴着面板顶边、横跨整个面板的（连接状态、版本不匹配）加 `className="rounded-none"`。 |
| `toast.tsx` 的 `useToast()` | 一闪而过、不需要留在页面上的结果：命令失败、对方没应答、新主机加入。`toast({ description, type, timeout, id, action, onClose })` 返回关闭函数。普通的 5 秒后消失（悬停、聚焦或窗口在后台时暂停），`type: "error"` 和 `timeout: 0` 的等用户关；相同 `id` 会替换旧的那条。最多显示 5 条，新的在最上面，F6 跳进去。要求外面有 `Toaster`：`App` 在最外层包了一层（`className="top-12"` 让开顶栏）；`AppFrame` 也包了一层，供单独渲染它的 story 和测试用，嵌在别的 `Toaster` 里时不另起一叠。外面没有时 toast 被丢掉，开发环境会警告。它是 `popover="manual"`，Astryx 对话框打开时也在最上层。 |
| `badge.tsx` 的 `Badge` | 行名称旁边的短标签，只读：This device、Connected、new、interrupted。`variant` 是 `default` / `success` / `destructive` / `warning`（橙色）/ `muted`（灰色，用于已失效的东西）。 |
| `status-dot.tsx` 的 `StatusDot` | 8px 的状态灯：在线、运行中、等待回答、失败。`label` 必填（读屏念它），`pulsing` 表示进行中，`tooltip` 悬停时也显示文字。 |
| `spinner.tsx` 的 `Spinner` | 等待中的一小块区域，旁边通常有一行说明文字。`size="sm"`（14px）放在文字行里，默认 `md`（20px）放在空的面板中间。读屏念 "Loading"，知道在加载什么时写 `aria-label`。按钮自己的加载状态用 `Button` 的 `loading`，不要另放转圈。 |
| `skeleton.tsx` 的 `Skeleton` | 内容的形状已知、还在路上时的占位块，尺寸和圆角写在 `className` 里。它先等 1 秒再淡入淡出，快的加载不会闪一下；一组用 `index` 错开。 |
| `empty.tsx` 的 `Empty` | 一屏或一个面板没东西可显示，或在等一个状态过去（Connecting）：`EmptyHeader` 里放 `EmptyTitle` 和 `EmptyDescription`，操作放 `EmptyContent`。 |
| `avatar.tsx` 的 `Avatar` | 账号的圆形头像，里面是 `AvatarFallback` 和 `initials(name)` 算出的首字母，根元素写 `aria-label`。尺寸 `xs`（20px，侧栏）和 `lg`（48px，账号页）。 |
| `tooltip.tsx` | 悬停说明。按钮用 `Button` 的 `tooltip` 属性；其余元素用 `Tooltip` / `TooltipTrigger render={…}` / `TooltipContent`，在 Astryx 对话框里时用 `useDialogPortal` 把它渲染进对话框。 |

只给读屏看的文字用 `<span className="sr-only">`。

## 文字和布局

布局用 Tailwind 的 flex 类（`flex flex-col gap-2`），文字用原生元素加类，不再用 Astryx 的 `VStack` / `HStack` / `Text` / `Heading`（ADR-0048）。字号和行高固定这几档：

| 用途 | 类 |
| --- | --- |
| 正文、行名称 | `text-sm/5` |
| 说明、次要信息 | `text-xs/5 text-muted-foreground` |
| 分组标题（`h4`） | `text-sm/5 font-bold` |
| 页内标题（`h3`） | `text-[1.0625rem]/6 font-bold` |
| 屏标题（`h2`） | `text-xl/7 font-semibold` |

文字颜色默认继承，只有需要和周围不同时才写（`text-muted-foreground`、`text-destructive`）。链接用 `shared/ui/link.tsx`，站外链接加 `external`；分隔线用 `shared/ui/separator.tsx`。

## 外框和面板

窗口底色是框架色（`--color-background-body`），侧栏直接放在底色上；工作区是从窗口边缘内缩的圆角卡片（面板，pane）：主区一张，右侧面板（Tasks / Changes / Terminal）打开时是旁边单独的一张，两张之间露出底色间隙。样式只在 `src/app/styles.css` 的 “Inset shell” 一段里定义：

- 面板加 `pigui-pane`，底色 `--background`，圆角 `--pigui-pane-radius`（12px），边缘是 `--pigui-pane-ring` 的 1px 细边，不加投影。离窗口边缘 `--pigui-pane-inset`（8px），两张面板之间 `--pigui-pane-gap`（4px）。
- 内缩只在宽屏（≥1024px，AppFrame 给外壳加 `pigui-inset`）。窄屏没有侧栏，面板贴满窗口，不要圆角和描边。
- 框架里显示的 `Centered` 屏（连接中、连接失败）自己就是一张面板；框架外的（还没有宿主、配对）铺满窗口，用框架色。
- 深色模式照样“越上层越亮”：框架最暗，面板高一级，卡片（输入框、设置分组）再高一级。
- 调用处不要用 `className` 给面板加圆角、边框或底色。

## 设置页

设置是外框里的一页，不是对话框：宽屏时设置导航（顶上是 “‹ Settings” 返回行和搜索框）占侧栏的位置，打开的分区在主区面板里，内容居中、最宽 46rem；窄屏时主区先列出分区，点进去再看，顶栏有返回和关闭。Esc 关闭设置，除非它属于设置上面打开的对话框、菜单或下拉。

分区内容用 `shared/ui/settings-group.tsx`：

- `SettingsGroup`：可选标题，下面一张带描边的卡片，行间有分隔线。
- `SettingsRow`：一项设置一行，左边是名称（可加一行说明），右边是控件；窄时控件换到下一行。控件自己带无障碍名称（比如 `SegmentedControl` 的 `aria-label`），行的名称只给人看。
- 现成的列表（`List hasDividers`）直接放进 `SettingsGroup`。

设置页里的 `secondary` 按钮和 `Select` 是平的：透明底，只留一圈 `--border` 描边，没有投影（写在各自组件里的 `in-[.pigui-settings]:` 类）。深色下表面色比卡片暗一级，按钮放在卡片里会像个洞。`SegmentedControl` 也是平的：凹下去的轨道，选中的那段比下面所有层都亮一级，没有投影。

分区按用户要调整的事分组，不按存在哪里分：This device 下是 General、Hosts；Host settings 下是 Providers、Models、Agents、Chats、Devices、About。合并进来的旧分区名写进 `SECTIONS` 的 keywords，搜索还能找到。选宿主的选择器在每个宿主分区的标题上方，不在导航里。页面上不显示文件路径。
