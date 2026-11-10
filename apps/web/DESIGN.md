# Web 界面设计规则

Web 和桌面端（renderer 就是 `apps/web`）共用这份规则。组件来自 Astryx（`@astryxdesign/core`，主题 `@astryxdesign/theme-neutral`），props 和 token 用 `bunx astryx component <Name>` 查（在 `apps/web` 下跑）。

## 按钮

按钮只用 Astryx 的 `Button`（带文字）和 `IconButton`（只有图标），`variant` 只有四档，没有别的：

| variant | 样子 | 用在哪 |
|---|---|---|
| `primary` | 强调色实底 | 完成当前流程的那一步：Save、Sign in、Pair、Create account。一个对话框或一屏最多一个。 |
| `secondary`（默认） | 表面色底 + 1px 描边 + 1px 投影 | 其余所有带文字的独立动作：设置行里的 Refresh / Remove / Connection / Unpair，对话框页脚的 Cancel / Close，打开危险确认的那个按钮（Delete account、Log out）。 |
| `ghost` | 透明，只有字或图标 | 只有下面四种情况，见流程图。 |
| `destructive` | 浅红底红字 | 不可撤销动作的**最后一步确认**，旁边必须有一个 `secondary` 的 Cancel。 |

`secondary` 的描边和投影在 `src/app/styles.css` 的 “Button tiers” 一段里，写在 `astryx-theme` 层，输入框（`.astryx-chat-composer`）里的按钮除外：停止按钮在输入框底色上，表面色反而像个洞。Astryx 原版的 secondary 只是 6% 灰底，放在输入框旁边像一段文字，深色下几乎看不见，这是改它的原因。不要在调用处用 `className` 给按钮加边框、阴影或背景：一档按钮长什么样只在主题里定一次。

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

- 列表行（`ListItem` 的 `endContent`）、行内表单、卡片里：`size="sm"`。
- 对话框页脚、整屏的表单提交：默认的 `md`。
- 同一行的按钮用同一个尺寸。

### 例子

对的：设置行里的独立动作有边框，危险操作先开确认、确认时才用 `destructive`。

```tsx
<ListItem
  label={device.name}
  endContent={<Button label="Unpair" variant="secondary" size="sm" onClick={onUnpair} />}
/>

<HStack gap={2}>
  <Button label="Delete account" variant="destructive" isLoading={busy} onClick={submit} />
  <Button label="Cancel" variant="secondary" onClick={close} />
</HStack>
```

错的：独立动作用 `ghost`（读成纯文字），打开确认的按钮就用 `destructive`（还没确认就在报警）。

```tsx
<ListItem label={device.name} endContent={<Button label="Unpair" variant="ghost" size="sm" />} />
<Button label="Delete account" variant="destructive" onClick={() => setOpen(true)} />
```

四档并排的样子见 Storybook 的 `Shared/ButtonTiers`（`src/shared/ui/button-tiers.stories.tsx`），明暗两套都要看。

### 不归这里管的

原生 `<button>` 做的可点区域不是动作按钮，不套这四档：设置里的提供方磁贴、侧栏会话行、附件和图片预览、问题卡片的分段指示。它们的样式跟着各自的组件走。

### iOS 对照

iOS（`apps/ios`）不用这份 CSS，但分档一致：`primary` ↔ `.borderedProminent` / `.glassProminent`，`secondary` ↔ `.bordered` / `.glass`，`ghost` ↔ `.plain` / `.borderless`，`destructive` ↔ `role: .destructive`。改 iOS 按钮另开 PR。

## 外框和面板

窗口底色是框架色（`--color-background-body`），侧栏直接放在底色上；工作区是从窗口边缘内缩的圆角卡片（面板，pane）：主区一张，右侧面板（Tasks / Changes / Terminal）打开时是旁边单独的一张，两张之间露出底色间隙。样式只在 `src/app/styles.css` 的 “Inset shell” 一段里定义：

- 面板加 `pigui-pane`，底色 `--surface`，圆角 `--pigui-pane-radius`（12px），边缘是 `--pigui-pane-ring` 的 1px 细边，不加投影。离窗口边缘 `--pigui-pane-inset`（8px），两张面板之间 `--pigui-pane-gap`（4px）。
- 内缩只在宽屏（≥1024px，AppFrame 给外壳加 `pigui-inset`）。窄屏没有侧栏，面板贴满窗口，不要圆角和描边。
- 框架里显示的 `Centered` 屏（连接中、连接失败）自己就是一张面板；框架外的（还没有宿主、配对）铺满窗口，用框架色。
- 深色模式照样“越上层越亮”：框架最暗，面板高一级，卡片（输入框、设置分组）再高一级。
- 调用处不要用 `className` 给面板加圆角、边框或底色。

## 设置页

设置是外框里的一页，不是对话框：宽屏时设置导航（顶上是 “‹ Settings” 返回行和搜索框）占侧栏的位置，打开的分区在主区面板里，内容居中、最宽 46rem；窄屏时主区先列出分区，点进去再看，顶栏有返回和关闭。Esc 关闭设置，除非它属于设置上面打开的对话框、菜单或下拉。

分区内容用 `shared/ui/settings-group.tsx`：

- `SettingsGroup`：可选标题，下面一张带描边的卡片，行间有分隔线。
- `SettingsRow`：一项设置一行，左边是名称（可加一行说明），右边是控件；窄时控件换到下一行。控件自己带无障碍名称（比如 `SegmentedControl` 的 `label`），行的名称只给人看。
- 现成的列表（`List hasDividers`）直接放进 `SettingsGroup`。
