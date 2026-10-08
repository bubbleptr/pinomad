# ADR-0014：Web 客户端采用 Pace 的设计系统和对话界面

- 状态：Accepted
- 日期：2026-10-08
- 来源：Pace（`bubbleptr/PiGUI` @ 15b9084）

## 背景

PiNomad 的 Web 客户端到目前为止只用 Astryx 的现成组件拼界面：工具调用是 `ChatToolCalls` 的一行行卡片，思考是一个折叠块，首页是空状态加输入框。日常使用时信息密度低、运行中看不出在干什么，子代理和 codemode 的卡片也只能塞进通用工具行里。

Pace 在同样的 Astryx 之上已经打磨出一整套对话界面：思维链把一批工具调用收成一行动词总结（"Ran 3 commands +12 −3"），思考收成 "Thought 4s"，运行中有状态行；外框、首页和带模型选择的 Composer 也都做过。ADR-0001 第 4 条允许从 Pace 按需复制代码。

问题是 Pace 的组件不是只依赖 Astryx：它们用 Tailwind v4 的工具类、一层把 Astryx token 拼成语义名的 token 桥（`--foreground`、`--muted`…）、Montserrat 字体和 Hugeicons 图标。只搬组件、样式按 PiNomad 现状重写，每个组件都要改一遍，以后 Pace 再改进也没法跟。

## 决策

1. **Web 客户端的视觉基础整套对齐 Pace**：引入 Tailwind v4（`@tailwindcss/vite`）、Pace 的 token 桥和层级顺序（`styles.css`）、Montserrat 字体、Hugeicons（只从 `shared/ui/icons.tsx` 导入）。依赖版本跟 Pace 锁定的一致。
2. **目录和导入跟 Pace 保持同形**：`apps/web/src/` 下用 `app/`、`shared/ui/`、`entities/`、`widgets/` 这几层，`@/` 指向 `apps/web/src/`。复制来的组件尽量原样保留，便于以后对照 Pace 同步。
3. **只搬界面，不搬数据模型**：Pace 的组件吃的是 Pace 的会话投影；PiNomad 在 `entities/` 里自己写适配层，从 Durable 的 `ConversationView` 推导组件需要的视图数据（例如思维链的 `CotView`）。Pace 的 Electron、终端、浏览器、轨迹、用量页面不在范围内。
4. **窄屏照旧可用**：Pace 只考虑桌面窗口，PiNomad 的 Web 客户端要在手机上用（ADR-0003），外框和首页搬过来时保留窄屏布局。

## 考虑过的方案

- **继续只用 Astryx 现成组件**：没有新依赖，但要自己把 Pace 已经解决过的问题再解决一遍。
- **只搬组件，样式按现状改写**：依赖少，但每个组件都要重写样式，和 Pace 的代码很快分叉，以后改进无法同步。

## 后果

- Web 客户端多了 Tailwind、字体和图标依赖；Astryx 的层级顺序必须排在 Tailwind preflight 之后，`styles.css` 里的 `@layer` 声明不能随便动。
- 复制代码时在提交信息里注明 Pace 的来源 commit（ADR-0001）。
- Pace 的设计纪律（`/design` 注册页、自建组件台账）暂不搬，等自建组件多到需要时再说。
