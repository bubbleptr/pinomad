# Web 界面设计规则

Web 和桌面端（renderer 就是 `apps/web`）共用这份规则。组件都在 `src/shared/ui/`，归我们所有、可以直接改：shadcn（Base UI 版）组件用 `bunx shadcn@latest add <name>` 加进来；对话组件（`chat-kit/`）、`markdown/`、`code-block/`、`typeahead/` 是手写的 Tailwind 组件，来源和许可见 `docs/licenses/`（ADR-0048）。

## 颜色和 token

token 都在 `src/app/tokens.css`，分三层：

- **一级（原始值）**：色板 `--palette-blue` / `green` / `amber` / `orange` / `red` / `pink` / `purple` / `teal` / `cyan`（clean 的 `--aui-*` 同名色），和 `chat.css` 等手写 CSS 用的间距、圆角、字号、动效刻度。色板只作填充，不作文字色：图表和计量条直接用，状态圆点（`--dot-*`）指向它。
- **二级（shadcn 语义名）**：`--background`、`--foreground`、`--primary`、`--muted-foreground`、`--border` 这一套。Tailwind 类直接用（`bg-card`、`text-muted-foreground`、`text-destructive`），不要写死颜色值。
- **应用专有语义**：shadcn 没有名字的那些。表面：`--surface` 和高一级的 `--surface-raised` 在对话框里各抬高一级（`styles.css` 里按 `data-slot` 设置），`--surface-muted` 是凹陷的填充，`--surface-hover` / `--surface-pressed` 是盖在任意底色上的悬停和按下层。还有 `--default`（中性填充）、`--border-strong`、`--disabled-foreground`，状态色（`--success`、`--warning`，以及浅色铺底 `--*-muted` 和铺底上的文字 `--*-strong`），阴影（`--shadow-low` / `--shadow-med` / `--shadow-button`）。

组件里用二级和应用语义，不直接用色板（数据可视化除外）。手写 CSS 里也用同一套名字（`var(--foreground)`），没有另一套别名。每个颜色是一对 `light-dark()`，跟着 `<html>` 的 `color-scheme` 走；`color-scheme` 由 `<html>` 上的 `dark` 类决定（外观设置维护这个类，`styles.css` 据此设 `color-scheme`），所以 `dark:` 类和 token 永远一致。取值来自 affectUI 的 clean 主题：文字、细边和浅色铺底是半透明的黑或白，焦点环是蓝色，基础圆角 7px（`--radius`，Tailwind 的 `rounded-*` 按它缩放）。

`styles.css` 开头的 `@layer` 顺序不能动，也不要跑 `shadcn init`（它会改写 `styles.css`）。

## 按钮

按钮只用 `src/shared/ui/button.tsx` 的 `Button`（带文字）和 `src/shared/ui/icon-button.tsx` 的 `IconButton`（只有图标，`label` 必填，作为无障碍名称），`variant` 只有四档，没有别的：

| variant | 样子 | 用在哪 |
|---|---|---|
| `primary` | 强调色实底 | 完成当前流程的那一步：Save、Sign in、Pair、Create account。一个对话框或一屏最多一个。 |
| `secondary`（默认） | 表面色底 + 0.5px 细环 + 柔和投影，悬停时加深 | 其余所有带文字的独立动作：设置行里的 Refresh / Remove / Connection / Unpair，对话框页脚的 Cancel / Close，打开危险确认的那个按钮（Delete account、Log out）。 |
| `ghost` | 透明，只有字或图标 | 只有下面四种情况，见流程图。 |
| `destructive` | 浅红底红字 | 不可撤销动作的**最后一步确认**，旁边必须有一个 `secondary` 的 Cancel。 |

每档的样子只写在 `button.tsx` 的 `buttonVariants` 里。`secondary` 照 affectUI clean 的按钮：0.5px 的细环加一层柔和投影（`--shadow-button`），悬停时环和投影加深（`--shadow-button-hover`），底色不变；只有浅灰底时放在输入框旁边像一段文字，深色下几乎看不见。设置页里去掉投影和底色，只留 1px 细线，悬停时加一层浅灰。`destructive` 的字用 `--destructive-strong`（浅红底上的文字色，现在和 `--destructive` 同值）。不要在调用处用 `className` 给按钮加边框、阴影或背景。

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

输入框的发送按钮是 `primary`；回合进行中它换成 Stop，仍是 `primary`：同一个位置、当下唯一的主动作，只换图标。

“都不是”是常态：拿不准时用 `secondary`。按钮单独放在内容区里却用 `ghost`，看起来就是一段文字，用户找不到它。

### 文字

按钮和菜单项的文字不加省略号，打开对话框或菜单的也一样（Sign out、Unpair、Add a host）。省略号只用在进行中的状态（Loading…、Thinking…）和输入框的占位文字里。

### 尺寸

- 列表行（`Item` 的 `ItemActions`）、行内表单、卡片里：`size="sm"`（28px）。
- 对话框页脚、整屏的表单提交：默认的 `md`（32px）。
- `IconButton` 也是 `md` / `sm` 两档。
- 同一行的按钮用同一个尺寸。

### 例子

对的：设置行里的独立动作有边框，危险操作先开确认、确认时才用 `destructive`。

```tsx
<Item render={<li />}>
  <ItemContent><ItemTitle>{device.name}</ItemTitle></ItemContent>
  <ItemActions><Button variant="secondary" size="sm" onClick={onUnpair}>Unpair</Button></ItemActions>
</Item>

<div className="flex gap-2">
  <Button variant="destructive" loading={busy} onClick={submit}>Delete account</Button>
  <Button variant="secondary" onClick={close}>Cancel</Button>
</div>
```

错的：独立动作用 `ghost`（读成纯文字），打开确认的按钮就用 `destructive`（还没确认就在报警）。

```tsx
<ItemActions><Button variant="ghost" size="sm">Unpair</Button></ItemActions>
<Button variant="destructive" onClick={() => setOpen(true)}>Delete account</Button>
```

四档并排的样子和加载、禁用状态见 Storybook 的 `Shared/ButtonTiers`（`src/shared/ui/button-tiers.stories.tsx`），明暗两套都要看。

### 表单控件

输入框、选择器等也在 `src/shared/ui/`：`input.tsx`、`textarea.tsx`、`select.tsx`、`combobox.tsx`（带搜索的选择器）、`checkbox.tsx`、`switch.tsx`、`radio-group.tsx`、`segmented-control.tsx`。名称、说明和错误用 `field.tsx` 的 `Field` / `FieldLabel` / `FieldDescription` / `FieldError` 包起来，它们自动关联到控件（`for`、`aria-describedby`）；只给读屏的名称用 `<FieldLabel className="sr-only">`。

### 不归这里管的

原生 `<button>` 做的可点区域不是动作按钮，不套这四档：设置里的提供方磁贴、侧栏会话行、附件和图片预览、问题卡片的分段指示。它们的样式跟着各自的组件走。

### iOS 对照

iOS（`apps/ios`）不用这份 CSS，但分档一致：`primary` ↔ `.borderedProminent` / `.glassProminent`，`secondary` ↔ `.bordered` / `.glass`，`ghost` ↔ `.plain` / `.borderless`，`destructive` ↔ `role: .destructive`。改 iOS 按钮另开 PR。

### 展开/收起

标题下面的内容能折叠时，标题用 `src/shared/ui/disclosure-button.tsx` 的 `DisclosureButton`，箭头用放在它里面的 `DisclosureChevron`，不要手写 `<button aria-expanded>`。`DisclosureButton` 只管 `aria-expanded`（`open` 属性）和焦点环，`DisclosureChevron` 只管箭头的大小（14px）、旋转和减弱动效；布局、悬停底色、文字由调用处写，箭头放前放后都行。被折叠的区域有 id 就传 `aria-controls`。

```tsx
<DisclosureButton open={open} aria-controls={region} className="flex items-center gap-2 rounded-md p-1 hover:bg-surface-hover" onClick={toggle}>
  <DisclosureChevron />
  {title}
</DisclosureButton>
```

整行宽、箭头朝下放在行尾、下面是 Base UI 面板的那种（Add a host 里的说明），用 `collapsible.tsx` 的 `CollapsibleTrigger`。

## 反馈

状态和通知用 `src/shared/ui/` 里这几个组件，样子和颜色都写在组件里，调用处不加 `className` 改底色或字色。各自的样子见 Storybook 的 `Shared/Feedback`（`src/shared/ui/feedback.stories.tsx`），明暗两套都要看。

| 组件 | 用在哪 |
| --- | --- |
| `alert.tsx` 的 `Alert` | 一直留着、直到情况变了才消失的说明：操作失败、连接断了、请求过期。`variant` 是 `info` / `success` / `warning` / `destructive`，图标随 `variant` 自动给。里面依次放 `AlertTitle`、可选的 `AlertDescription` 和 `AlertAction`（行尾的按钮，`size="sm"` 或默认尺寸都行）。`warning` 和 `destructive` 的角色是 `alert`，会打断读屏；`info` 和 `success` 是 `status`。贴着面板顶边、横跨整个面板的（连接状态、版本不匹配）加 `className="rounded-none"`。 |
| `toast.tsx` 的 `useToast()` | 一闪而过、不需要留在页面上的结果：命令失败、对方没应答、新主机加入。`toast({ description, type, timeout, id, action, onClose })` 返回关闭函数。普通的 5 秒后消失（悬停、聚焦或窗口在后台时暂停），`type: "error"` 和 `timeout: 0` 的等用户关；相同 `id` 会替换旧的那条。最多显示 5 条，新的在最上面，F6 跳进去。要求外面有 `Toaster`：`App` 在最外层包了一层（`className="top-12"` 让开顶栏）；`AppFrame` 也包了一层，供单独渲染它的 story 和测试用，嵌在别的 `Toaster` 里时不另起一叠。外面没有时 toast 被丢掉，开发环境会警告。它是 `popover="manual"`，在顶层（top layer），对话框打开时也在最上层、能点。 |
| `badge.tsx` 的 `Badge` | 行名称旁边的短标签，只读：This device、Connected、new、interrupted。`variant` 是 `default` / `success` / `destructive` / `warning`（橙色）/ `muted`（灰色，用于已失效的东西）。 |
| `status-dot.tsx` 的 `StatusDot` | 8px 的状态灯：在线、运行中、等待回答、失败。`label` 必填（读屏念它），`pulsing` 表示进行中，`tooltip` 悬停时也显示文字。 |
| `spinner.tsx` 的 `Spinner` | 等待中的一小块区域，旁边通常有一行说明文字。`size="sm"`（14px）放在文字行里，默认 `md`（20px）放在空的面板中间。读屏念 "Loading"，知道在加载什么时写 `aria-label`。按钮自己的加载状态用 `Button` 的 `loading`，不要另放转圈。 |
| `skeleton.tsx` 的 `Skeleton` | 内容的形状已知、还在路上时的占位块，尺寸和圆角写在 `className` 里。它先等 1 秒再淡入淡出，快的加载不会闪一下；一组用 `index` 错开。 |
| `empty.tsx` 的 `Empty` | 一屏或一个面板没东西可显示，或在等一个状态过去（Connecting）：`EmptyHeader` 里放 `EmptyTitle` 和 `EmptyDescription`，操作放 `EmptyContent`。 |
| `avatar.tsx` 的 `Avatar` | 账号的圆形头像，里面是 `AvatarFallback` 和 `initials(name)` 算出的首字母，根元素写 `aria-label`。尺寸 `xs`（20px，侧栏）和 `lg`（48px，账号页）。 |
| `tooltip.tsx` | 悬停说明。按钮用 `Button` 的 `tooltip` 属性；其余元素用 `Tooltip` / `TooltipTrigger render={…}` / `TooltipContent`。 |

只给读屏看的文字用 `<span className="sr-only">`。

## 对话框、菜单和弹出层

都在 `src/shared/ui/`，基于 Base UI，渲染到 `<body>`，彼此可以嵌套（对话框里开下拉、菜单项打开对话框）。焦点困在打开的那一层里，关闭后回到触发它的元素；Esc 只关最上面一层。

| 组件 | 用在哪 |
| --- | --- |
| `dialog.tsx` | 要用户停下来填写或查看的一屏内容：重命名、添加项目、账号。`<Dialog open onOpenChange>` 里放 `DialogContent`，依次是 `DialogHeader`（`DialogTitle`、可选的 `DialogDescription`）、`DialogBody`（内容，过长时自己滚动）、`DialogFooter`（按钮靠右，Cancel 在主按钮左边）。宽度用 `className`（默认 400px，如 `w-[480px]`，最宽 90vw），右上角自带关闭按钮（`showCloseButton={false}` 去掉）；`variant="fullscreen"` 铺满屏幕（窄屏的右侧面板）。有输入的对话框加 `disablePointerDismissal`，点外面不会丢掉填了一半的内容。打开时焦点落在带 `data-autofocus` 的元素上，没有就落在标题上。 |
| `alert-dialog.tsx` | 不可撤销动作的确认：`AlertDialogContent` 里放 `AlertDialogHeader`（`AlertDialogTitle` 写成问句，`AlertDialogDescription` 说后果）和 `AlertDialogFooter`（`AlertDialogCancel` 是 `secondary`，`AlertDialogAction` 用 `variant="destructive"`）。点外面不关。它是 shadcn 原样的 `alert-dialog`（只把 Cancel 的默认档换成 `secondary` / `md`），所有“确认一个动作”的对话框都用它，带输入框的也一样（账号那几个走 `widgets/account/confirm-dialog.tsx`）；说明只写后果，一两句。 |
| `dropdown-menu.tsx` | 按钮打开的一列动作：行尾的 …（`MoreHorizontal`）、输入框的 +、侧栏底部的主机列表。触发按钮通过 `render` 传入（`<DropdownMenuTrigger render={<IconButton icon={…} label="Conversation actions" size="sm" />} />`），保留它自己的样子和名称。`DropdownMenuItem` 是文字，前面可以放图标；禁用的项仍能聚焦、会被读出来。上下键移动，打字跳到对应项。 |
| `context-menu.tsx` | 右键（触屏长按）打开的菜单，目前只有终端标签。`ContextMenuSeparator` 分组；从键盘（菜单键、Shift+F10）打开时用 `anchor` 让它出现在元素下方而不是左上角。 |
| `popover.tsx` | 触发按钮旁边、不挡住页面的一块面板，里面可以有搜索框和列表：模型选择。`PopoverContent` 写 `aria-label`，宽度用 `className`；放不下时在可用高度里滚动，不会跑到触发按钮侧面。 |
| `combobox.tsx` 的 `ComboboxCheckboxItem` | 带搜索的多选（`<Combobox multiple>`），每项前面一个勾选框：自定义端点的模型列表。 |
| `lightbox.tsx` | 全屏看图：`images` 和 `index`，左右键或两侧按钮切换，点空白处或 Esc 关闭。 |

菜单和弹出层用同一块浮层表面（`floatingSurfaceClassName`：popover 底色、`rounded-xl` 圆角、低投影），对话框是卡片底色加高投影。调用处不要用 `className` 改它们的底色、圆角和投影。

窄屏的导航抽屉是 `sheet.tsx`（Base UI 的 Dialog，从左边滑出，最宽 320px）。抽屉里打开的菜单和对话框叠在它上面，Esc 一次只关最上面一层，抽屉留在下面；toast 在顶层（manual popover），抽屉开着也看得见。

## 列表、卡片和内容

| 组件 | 用在哪 |
| --- | --- |
| `item.tsx` | 一行一项：设置里的设备、宿主、登录方式，侧面板的任务，模型选择。`ItemGroup`（`ul role="list"`，用 `aria-label` 或 `aria-labelledby` 命名）里放 `Item render={<li />}`，依次是可选的 `ItemMedia`（图标、状态灯、logo）、`ItemContent`（`ItemTitle` 一行截断，`ItemDescription` 默认一行截断，两行用 `line-clamp-2 whitespace-normal`，自由换行的富内容用 `overflow-visible whitespace-normal`）、`ItemActions`（行尾的按钮、徽标、时间）。紧凑的行用 `size="sm"`。整行可点时写 `<ItemContent render={<button type="button" onClick={…} />}>`：按钮铺满整行，名称只有标题和说明，`ItemActions` 里就不要再放可点的东西。选中写在 `Item` 上：`aria-current`（底色变深），禁用写 `aria-disabled`。 |
| `card.tsx` | 一块带 1px 描边和 `rounded-xl` 圆角的卡片：Agents、旧版登录这类一张一项的内容，内容放 `CardContent`。成组的设置行用 `SettingsGroup`，不要自己拼 `Card`。 |
| `collapsible.tsx` | 默认收起的细节（错误详情、地址、一次性令牌）：`Collapsible` 里放 `CollapsibleTrigger`（整行宽，右边的箭头自带，文字自己写样式，通常 `text-xs/5 text-muted-foreground`）和 `CollapsibleContent`（收起时不渲染）。 |
| `thumbnail.tsx` | 64px 的图片预览：待发送的附件（`onRemove`）和消息里的图（`onClick` 打开大图），`alt` 同时是整块的名称。 |
| `code-block/` | `CodeBlock` 带高亮和复制按钮的代码块（要复制的命令用 `isWrapped width="100%"`），`Code` 行内代码。 |
| `markdown/` | `Markdown` 渲染模型输出；对话里用 `shared/ui/chat/chat-markdown.tsx` 的 `ChatMarkdown`，它定好了密度、标题层级和文件链接。各块带 `data-slot="markdown-…"`，`chat.css` 按它调样式。 |

## 文字和布局

布局用 Tailwind 的 flex 类（`flex flex-col gap-2`），文字用原生元素加类，没有专门的布局或文字组件。没写类的 `p`、`h1`–`h6`、`small`、`code` 由 `styles.css` 的 `reset` 层给一套默认字号（`p` 是 14px），但组件里照样写类。字号和行高固定这几档：

| 用途 | 类 |
| --- | --- |
| 正文、行名称 | `text-sm/5` |
| 说明、次要信息 | `text-xs/5 text-muted-foreground` |
| 分组标题（`h4`） | `text-sm/5 font-bold` |
| 页内标题（`h3`） | `text-[1.0625rem]/6 font-bold` |
| 屏标题（`h2`） | `text-xl/7 font-semibold` |

文字颜色默认继承，只有需要和周围不同时才写（`text-muted-foreground`、`text-destructive`）。链接用 `shared/ui/link.tsx`，站外链接加 `external`；分隔线用 `shared/ui/separator.tsx`。

## 外框和面板

窗口底色是框架色（`--sidebar`），侧栏直接放在底色上；工作区是从窗口边缘内缩的圆角卡片（面板，pane）：主区一张，右侧面板（Tasks / Changes / Terminal）打开时是旁边单独的一张，两张之间露出底色间隙。样式只在 `src/app/styles.css` 的 “Inset shell” 一段里定义：

- 面板加 `pigui-pane`，底色 `--background`，圆角 `--pigui-pane-radius`（`--radius-container`，10px），边缘是 `--pigui-pane-ring` 的 1px 细边，不加投影。离窗口边缘 `--pigui-pane-inset`（8px），两张面板之间 `--pigui-pane-gap`（4px）。
- 内缩只在宽屏（≥1024px，AppFrame 给外壳加 `pigui-inset`）。窄屏没有侧栏，面板贴满窗口，不要圆角和描边。
- 框架里显示的 `Centered` 屏（连接中、连接失败）自己就是一张面板；框架外的（还没有宿主、配对）铺满窗口，用框架色。
- 深色模式照样“越上层越亮”：框架最暗，面板高一级，卡片（输入框、设置分组）再高一级。
- 调用处不要用 `className` 给面板加圆角、边框或底色。

外框的部件也在 `src/shared/ui/`：

- `side-nav.tsx`：侧栏和设置导航。`SideNav` 是一列（顶部、可滚动的中段、底部），`resizable` 时宽度可拖、可用方向键调（`ResizeHandle`），并存进 localStorage；`SideNavSection` 是带标题的一组行；`SideNavItem` 是 32px 的一行，`onClick` 打开、`isSelected` 标当前（`aria-current="page"`），带 `collapsible` 和子行时折叠子行。行上的悬浮操作和行宽的样式在 `styles.css` 的侧栏一段，按 `data-slot="side-nav-item"` 选。
- `resize-handle.tsx`：`useResizableWidth`（px 宽度、上下限、存盘）和贴在面板边上的 `ResizeHandle`（`separator`，拖动或方向键，Shift 步长更大，Home / End 到上下限）。侧栏、设置导航和右侧面板都用它。
- `tab-list.tsx`：一排导航式的标签（`nav` 里的按钮，当前那个 `aria-current="page"` 加下划线），放不下的进末尾的 `TabMenu`。没有面板，所以标签之间可以夹关闭按钮：终端标签就是这样。

## 设置页

设置是外框里的一页，不是对话框：宽屏时设置导航（顶上是 “‹ Settings” 返回行和搜索框）占侧栏的位置，打开的分区在主区面板里，内容居中、最宽 46rem；窄屏时主区先列出分区，点进去再看，顶栏有返回和关闭。Esc 关闭设置，除非它属于设置上面打开的对话框、菜单或下拉。

分区内容用 `shared/ui/settings-group.tsx`：

- `SettingsGroup`：可选标题，下面一张带描边的卡片，行间有分隔线。
- `SettingsRow`：一项设置一行，左边是名称（可加一行说明），右边是控件；窄时控件换到下一行。控件自己带无障碍名称（比如 `SegmentedControl` 的 `aria-label`），行的名称只给人看。
- 列表直接放进 `SettingsGroup`：`<ItemGroup className={GROUP_ROWS}>`，行间画分隔线、行不带圆角；卡片里的行左右内边距统一成 16px（`styles.css`）。

设置页里的 `secondary` 按钮和 `Select` 是平的：透明底，只留一圈 `--border` 描边，没有投影（写在各自组件里的 `in-[.pigui-settings]:` 类）。深色下表面色比卡片暗一级，按钮放在卡片里会像个洞。`SegmentedControl` 也是平的：凹下去的轨道，选中的那段比下面所有层都亮一级，没有投影。

分区按用户要调整的事分组，不按存在哪里分：This device 下是 General、Hosts；Host settings 下是 Providers、Models、Agents、Chats、Devices、About。合并进来的旧分区名写进 `SECTIONS` 的 keywords，搜索还能找到。选宿主的选择器在每个宿主分区的标题上方，不在导航里。页面上不显示文件路径。
