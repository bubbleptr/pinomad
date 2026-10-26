# 官网和托管实例

两个域名，两套独立部署：

| 域名 | 内容 | 部署 |
|---|---|---|
| `pinomad.si`（`www` 跳到根域名） | 落地页、文档和博客，`apps/site` 的静态构建，中英两份（英文在根路径，中文在 `/zh/`） | Cloudflare Pages，接 GitHub，合进 `main` 自动发布 |
| `app.pinomad.si` | 托管的服务端：账号 API、中继、它自带的 Web 客户端 | Zeabur，`deploy/server/Dockerfile`，见[远程访问](https://pinomad.si/zh/docs/remote-access/)的"容器平台" |

官网只是静态文件，不跟服务端共享代码和部署，也不跟 npm 版本走；服务端照旧托管和它同版本的 Web 客户端（ADR-0015 §4）。

## 开发

```sh
bun run site          # 开发服务器，http://127.0.0.1:5299
cd apps/site && bun run build && bun run preview
```

官网是 TanStack Start 应用，构建时把所有页面预渲染成静态文件（`dist/`），线上不跑服务端；预渲染用的服务端产物在 `.output/server/`，不发布。英文在根路径，中文在 `/zh/` 下；网址一律以 `/` 结尾（页面输出成 `<路径>/index.html`，Pages 会把不带斜杠的地址 308 过去）。

- **落地页**：React 组件，在 `src/landing/`。文案在 `copy.tsx`，中英两份共用一个类型，缺了哪条 typecheck 就报错；改文案时两份一起改，功能描述以文档的 `features` 页为准。区块组件在 `sections.tsx`，有交互的单独成文件（`durable.tsx` 是"拔电源"示意图，`quick-start.tsx` 带复制按钮），页头页脚在 `site-header.tsx` / `site-footer.tsx`，页头元信息在 `meta.ts`。样式入口是 `landing.css`：页面自己的规则在 `page.css`，放在 `landing` 层里；Tailwind 的主题变量在它下面一层，utilities 在它上面一层，所以元素上的 utility 能盖过 `page.css` 的元素选择器。没有引 preflight（会改掉页面的默认样式），组件依赖的两条（`[hidden]` 和按钮继承字体）抄在 `landing.css` 末尾；Tailwind 只扫 `src/landing/` 和 `src/components/ui/`。页头的站内链接（文档、博客、更新日志、登录）和文档页的 Fumadocs 页头共用 `src/lib/nav.ts`，不放页内锚点。截图放在 `apps/site/shots/`（中英各一份，都是深色模式），每张有 2x 原图（`hero.webp` 2400×1500，功能截图 1120×840）和同名加 `-<宽>` 的 1x 版本，页面用 `srcset` 二选一（`shots.ts`）；`public/og-image.jpg` 是英文首屏图缩到 1920×1200。图标直接引用 `apps/web/public/` 里的文件，构建时打上哈希。iPhone 那格还是抽象占位图，等原生 iOS 版替换验收（#133）后补。示意图的 SVG 是 `aria-hidden` 的，读屏用的描述写在文案里。
- **组件库**：`apps/site/components.json` 是 shadcn 的配置，选的是 Base UI 风格（`base-vega`，和 Fumadocs 用的同一个 Base UI，版本钉在锁文件里已有的那个）。用 `bunx shadcn add <组件>` 把组件源码复制进 `src/components/ui/`，再按落地页的样子改：shadcn 的主题名（`bg-primary`、`border-input` 等）在 `landing.css` 里映射到页面自己的变量，落地页只有深色。`button.tsx` 就是这样改过来的，链接要按钮样式时用 `buttonVariants()` 套在普通 `<a>` 上。React Bits 也走 shadcn 注册表（`@react-bits/<名字>-TS-TW`），但许可不是普通开源许可：免费版是 MIT 加 Commons Clause（可以作为网站的一部分使用，不能把组件本身再分发），Pro 版的许可明确禁止把组件放进开源仓库。这个仓库是公开的，Pro 组件不能入库；免费组件入库前先定好许可怎么标注（#360）。不要在 `apps/site` 里跑 `shadcn init`，`add` 之后也要看一眼 `landing.css` 的改动：CLI 会往里加 `@import` 和 `body`、`*` 上的基础样式，文档页和落地页都会跟着变。
- **文档和博客**用 Fumadocs：内容在 `content/docs/`、`content/blog/`。用户文档以这里为准，仓库里的 `docs/usage.md` 等只是指向官网的链接，README 只留快速上手；中文版是同名加 `.zh` 的文件（`index.zh.mdx`），没有中文版的页面在中文站显示英文版。侧栏顺序在 `content/docs/meta.json`。搜索索引在构建时生成为 `/api/search.json`，在浏览器里搜。
- **更新日志**：`content/changelog/` 每个版本一个文件（`v0.7.0.mdx`，中文版 `v0.7.0.zh.mdx`），frontmatter 写 `title`、`version`、`date`，正文写给用户看的变化，不照搬 GitHub Release 自动生成的 PR 列表。`/changelog/` 一页按日期倒序列出全部版本，每条链到对应的 GitHub Release。
- **404**：`/404/`、`/zh/404/` 两个路由预渲染后由 `scripts/not-found.ts` 改名成 `404.html`、`zh/404.html`，并去掉全部客户端脚本（Pages 会在任意缺失的地址上返回它们，路由不能拿那个地址去接管）。Pages 用离请求路径最近的 `404.html`，状态码 404，所以 `/zh/` 下缺页显示中文版。页内跳转到不存在的页面时，加载器先查内容索引再取数据，显示同一个 `NotFound` 组件；语言切换对应语言没有这一页时，落到那个语言的文档或博客首页。
- **登录入口**：页头的"登录"指向 `app.pinomad.si`。Web 端给用过它的浏览器在 `pinomad.si` 上写 `pinomad_app=1`，`public/app-hint.js` 读到后把它改成"打开 Web 端"，首页（`/`、`/zh/`）直接跳到 Web 端；带 `?home` 时不跳。

**CSP**：页面里有框架写的内联脚本（水合用的路由状态、文档的主题切换），内容每次构建都变。`public/_headers` 因此给 `script-src` 和 `style-src` 留了 `'unsafe-inline'`，构建最后一步 `scripts/csp.ts` 给每个页面在 `<head>` 最前面写一条 `<meta>` CSP，只放行这一页内联脚本的哈希；浏览器两条策略都要满足，所以实际只有哈希对得上的内联脚本能跑。落地页没有 `style=""`，样式也只认哈希：组件不用 `style` prop（预渲染会把它写成 `style=""`），动画只能用样式表里的类、SVG 属性、SMIL 和在 effect 里写的 CSSOM（`el.style.x = …`）。哪天落地页用了带内联样式的组件，`csp.ts` 会自动把它归到放开内联样式的那类，构建不会报错，所以要看构建最后一行的计数；文档和博客页的代码高亮和组件带 `style=""`，这些页面放开内联样式。页面新加外部资源时要同步改 `_headers`。

## Cloudflare Pages

一次性设置（Cloudflare 控制台）：

1. 把 `pinomad.si` 加成 Cloudflare 的站点，到注册商那里把 NS 改成 Cloudflare 给的两个。Pages 绑根域名要求区域在 Cloudflare 上。
2. Workers & Pages → Create → Pages → Connect to Git，选 `bubbleptr/pinomad`：
   - Production branch：`main`
   - Root directory：留空（仓库根，要用根目录的 `bun.lock`）
   - Build command：`bun install --frozen-lockfile --filter @pinomad/site && bun run --cwd apps/site build`
   - Build output directory：`apps/site/dist`
   - 环境变量：`BUN_VERSION` = 本机 `bun --version` 的版本；`SKIP_DEPENDENCY_INSTALL` = `1`（Pages 看到 `bun.lock` 会先在根目录装整个 workspace，Electron 的 postinstall 又慢又可能失败；跳过它，由构建命令按需安装）
   - Build watch paths 只包含 `apps/site/*`、`apps/web/public/*`、`docs/assets/*`、`bun.lock`，别的改动不触发重建
3. 项目的 Custom domains 里加 `pinomad.si`（经 API 加时 DNS 不会自动建，要自己加一条代理的 CNAME：`pinomad.si` → `pinomad.pages.dev`）。`www` 不用加进 Pages，只要一条代理的 CNAME 指向根域名，由下一步的规则跳转。
4. Rules → Redirect Rules 加一条：主机名等于 `www.pinomad.si` 时 301 到 `https://pinomad.si${path}`，保留查询串。

`--filter` 只装官网需要的依赖（约 340 个包，主要是 TanStack Start、Fumadocs 和代码高亮），不会拉 Electron 这种 workspace 里的重包。PR 会自动得到预览地址。先建好 Pages 项目再合并改动，合进 `main` 时生产环境才会跟着发布。

## app.pinomad.si

`app` 子域名的 DNS 记录在同一个 Cloudflare 区域里：A 记录指向 Zeabur 服务器 IP，**灰云**（和[远程访问](https://pinomad.si/zh/docs/remote-access/)里说的一样，证书由 Zeabur 签，橙云会让国内访问多绕一圈）。从旧域名迁过来的步骤见[远程访问](https://pinomad.si/zh/docs/remote-access/)的"更换服务端域名"。

托管实例现在不开放注册（ADR-0022），落地页上的 "Open the web app" 对访客来说只能看到登录页；开放注册前它主要给作者自己和已配对的设备用。
