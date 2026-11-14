# ADR-0050：插件改由 chord 加载：宿主构建插件、改了文件就重载

- 状态：Accepted
- 日期：2026-11-14
- 修订：ADR-0049 §4（"不直接用 chord 的 API"改为宿主用 chord 加载，插件仍只写 PiNomad 的 API）、§6（目录形状、启动时加载、由作者构建浏览器侧代码）、"没选的方案"里的"宿主构建浏览器侧代码"

## 背景

ADR-0049 第一版的插件由宿主在启动时读一次：`plugin.json` 指向 `host.ts` 和 `web.js`，`host.ts` 靠 Node 的类型剥离直接运行，`web.js` 由插件作者自己构建。改一行插件代码要重启宿主，写界面要自己配一套打包。

当时不用 chord 有两个理由：Chord v2 还在重写，直接暴露给插件会把上游的破坏性变更转给插件作者；宿主构建浏览器侧代码要带打包器。现在情况变了：

- Chord v2 随 1.5.2 发布，自带插件组件（发现、esbuild 构建、文件监听、热重载、失败回滚），而且它的插件模型本身就要求插件只 import 应用自己带版本号的 API，不直接 import chord。第一个理由的担心由 chord 自己的规则解决了。
- 一个手写的加载器加上重载、回滚和文件监听，等于把 chord 插件组件再写一遍。spike（本地分支 `claude/earendil-1-5-2-spike-fc7ae5`）证实 chord 的宿主能嵌在 Durable Harness 旁边，经 `registryReader` 把插件扩展交给 Harness。

## 决策

1. **宿主用 chord 加载插件**：`createHost` + `createPlugins`，chord 的插件组件负责发现 `<dataDir>/plugins/*`、用 esbuild 构建、监听文件和重载。一次修改之后，下一次工具调用跑新代码，进行中的调用在旧代码上跑完；构建、求值或检查失败时保留上一个好版本并记日志。
2. **插件目录换成 chord 的形状**：`package.json`（`name` 是插件名）加固定入口 `server.ts`、`web.tsx`（扩展名也可以是 `.ts`、`.js`、`.mjs`）。不给 `plugin.json` 做兼容层；宿主遇到旧目录记一条说明怎么迁移的日志，跳过它。
3. **插件仍按 PiNomad 的 API v1 写，只 import `@pinomad/plugin`**。服务端的默认导出改为 `definePlugin(fn)`：chord 要求默认导出是一个 facet，`definePlugin` 由宿主在求值时提供，`fn` 收到的 `state` / `tool` / `method` 和以前一样。`packages/plugin` 仍然只有类型（`definePlugin` 只是声明）。浏览器侧的写法不变。
4. **浏览器侧由宿主构建**。chord 产出 CommonJS 包装的脚本，宿主把它包成 ES 模块（JSX 的 `react/jsx-runtime` 由外壳的 React 应答），线路上仍是 `pluginBundle` 送出的一段文本，客户端加载方式不变。暂不支持 CSS 和资源文件的 import。
5. **插件扩展经 chord 注册表组合、镜像进宿主的 Durable 注册表**。宿主自己的 `createRegistry()` 保留（MCP 和 codemode 在运行时往里装），chord 组合出的插件扩展经 `registryReader` 同步进去。插件不能替换内置工具：占用内置工具名的插件在求值时失败，加载时被跳过、重载时保留旧版本；两个插件重名时按名字靠后的整个跳过。MCP 工具都以 `mcp__` 开头，插件不能用这个前缀，所以两者不会撞名。
6. **线路不变**：hello 里的插件列表、`pluginBundle`、`pluginCall` 和协议版本都不改。共享状态仍是 Durable 文档 `plugin.<name>.<state>`，已有数据目录里的插件状态照常可读可写。

## 后果

- 宿主依赖 esbuild（精确版本，跟 chord 的 peer 一致），npm 包按平台装一份约 10 MB 的二进制。esbuild 的 `postinstall` 被 npm 拦下时也能用，只是安装时多一条警告。
- chord 的插件运行时会关掉整个进程的 V8 编译缓存。
- 插件的服务端代码不再由 Node 的类型剥离运行，TypeScript 写法不受限制；浏览器侧也可以写 TypeScript 和 JSX。
- hello 只在连接建立时发一次：重载之后，已经连着的 Web 和桌面端要重连才拿到新界面；已连着的客户端在重连前仍取得到它的 hello 公布过的那份代码。客户端侧的重载通知另做。
- 插件目录在宿主启动时就要存在，chord 才能监听它；宿主会自动创建。
- `package.json` 里的 `dependencies` 按 chord 的规则打包进脚本，但宿主不替插件跑 `npm install`。

## 没选的方案

- **在手写加载器上加重载**：要自己实现文件监听、构建、求值隔离、失败回滚和进行中调用的处理，正是 chord 插件组件已有的东西。
- **插件直接用 chord 的 API（facet、注册表）**：插件作者要面对 chord 的概念和版本；chord 自己的插件模型也要求插件只 import 应用的 API。
- **保留 `plugin.json` 的兼容层**：只有一个示例插件和测试夹具在用，迁移只是改名加一个 `package.json`，兼容层的长期成本不值得。
- **浏览器成为 chord 的客户端**：线路要改，iOS 也要跟；这次只换宿主侧的加载。
