# 官网和托管实例

两个域名，两套独立部署：

| 域名 | 内容 | 部署 |
|---|---|---|
| `pinomad.si`（`www` 跳到根域名） | 落地页、文档和博客，`apps/site` 的静态构建，中英两份（英文在根路径，中文在 `/zh/`） | Cloudflare Pages，接 GitHub，合进 `main` 自动发布 |
| `app.pinomad.si` | 托管的服务端：账号 API、中继、它自带的 Web 客户端 | Zeabur，`deploy/server/Dockerfile`，见[远程访问](remote-access.md)的"容器平台" |

官网只是静态文件，不跟服务端共享代码和部署，也不跟 npm 版本走；服务端照旧托管和它同版本的 Web 客户端（ADR-0015 §4）。

## 开发

```sh
bun run site          # 开发服务器，http://127.0.0.1:5299
cd apps/site && bun run build && bun run preview
```

官网是 TanStack Start 应用，构建时把所有页面预渲染成静态文件（`dist/client/`），线上不跑服务端。英文在根路径，中文在 `/zh/` 下；网址一律以 `/` 结尾（页面输出成 `<路径>/index.html`，Pages 会把不带斜杠的地址 308 过去）。

- **落地页**：`src/landing/en.html`、`zh.html` 是手写的 HTML 片段，原样渲染；交互在 `interactions.js`，样式在 `landing.css`，页头元信息在 `meta.ts`。改文案时中英两份一起改，功能描述以两份 README 为准。截图放在 `apps/site/shots/`（中英各一份，都是深色模式），每张有 2x 原图（`hero.webp` 2400×1500，功能截图 1120×840）和同名加 `-<宽>` 的 1x 版本，页面用 `srcset` 二选一；`public/og-image.jpg` 是英文首屏图缩到 1920×1200。图标直接引用 `apps/web/public/` 里的文件，构建时打上哈希。iPhone 那格还用 `partials/skeleton-phone.html` 占位，等原生 iOS 版替换验收（#133）后补。
- **插画和示意图**只存一份，放在 `partials/`，页面里写 `<!-- include 文件名.svg -->`，由 `landing.tsx` 内联。片段里中英文各一份（`.zh` / `.en`），按页面的 `lang` 显示其中一种；所以 SVG 本身 `aria-hidden`，读屏用的描述写在各页面里。
- **文档和博客**用 Fumadocs：内容在 `content/docs/`、`content/blog/`，中文版是同名加 `.zh` 的文件（`index.zh.mdx`），没有中文版的页面在中文站显示英文版。侧栏顺序在 `content/docs/meta.json`。搜索索引在构建时生成为 `/api/search.json`，在浏览器里搜。
- **登录入口**：页头的"登录"指向 `app.pinomad.si`。Web 端给用过它的浏览器在 `pinomad.si` 上写 `pinomad_app=1`，`public/app-hint.js` 读到后把它改成"打开 Web 端"，首页（`/`、`/zh/`）直接跳到 Web 端；带 `?home` 时不跳。

**CSP**：页面里有框架写的内联脚本（水合用的路由状态、文档的主题切换），内容每次构建都变。`public/_headers` 因此给 `script-src` 和 `style-src` 留了 `'unsafe-inline'`，构建最后一步 `scripts/csp.ts` 给每个页面在 `<head>` 最前面写一条 `<meta>` CSP，只放行这一页内联脚本的哈希；浏览器两条策略都要满足，所以实际只有哈希对得上的内联脚本能跑。落地页没有 `style=""`，样式也只认哈希，动画只能用样式表里的类、SVG 属性、SMIL 和 JS 的 CSSOM（`el.style.x = …`）；文档和博客页的代码高亮和组件带 `style=""`，这些页面放开内联样式。页面新加外部资源时要同步改 `_headers`。

## Cloudflare Pages

一次性设置（Cloudflare 控制台）：

1. 把 `pinomad.si` 加成 Cloudflare 的站点，到注册商那里把 NS 改成 Cloudflare 给的两个。Pages 绑根域名要求区域在 Cloudflare 上。
2. Workers & Pages → Create → Pages → Connect to Git，选 `bubbleptr/pinomad`：
   - Production branch：`main`
   - Root directory：留空（仓库根，要用根目录的 `bun.lock`）
   - Build command：`bun install --frozen-lockfile --filter @pinomad/site && bun run --cwd apps/site build`
   - Build output directory：`apps/site/dist/client`（`dist/server` 只在预渲染时用，不发布）
   - 环境变量：`BUN_VERSION` = 本机 `bun --version` 的版本；`SKIP_DEPENDENCY_INSTALL` = `1`（Pages 看到 `bun.lock` 会先在根目录装整个 workspace，Electron 的 postinstall 又慢又可能失败；跳过它，由构建命令按需安装）
   - Build watch paths 只包含 `apps/site/*`、`apps/web/public/*`、`docs/assets/*`、`bun.lock`，别的改动不触发重建
3. 项目的 Custom domains 里加 `pinomad.si`（经 API 加时 DNS 不会自动建，要自己加一条代理的 CNAME：`pinomad.si` → `pinomad.pages.dev`）。`www` 不用加进 Pages，只要一条代理的 CNAME 指向根域名，由下一步的规则跳转。
4. Rules → Redirect Rules 加一条：主机名等于 `www.pinomad.si` 时 301 到 `https://pinomad.si${path}`，保留查询串。

`--filter` 只装官网需要的依赖（约 340 个包，主要是 TanStack Start、Fumadocs 和代码高亮），不会拉 Electron 这种 workspace 里的重包。PR 会自动得到预览地址。先建好 Pages 项目再合并改动，合进 `main` 时生产环境才会跟着发布。

## app.pinomad.si

`app` 子域名的 DNS 记录在同一个 Cloudflare 区域里：A 记录指向 Zeabur 服务器 IP，**灰云**（和[远程访问](remote-access.md)里说的一样，证书由 Zeabur 签，橙云会让国内访问多绕一圈）。从旧域名迁过来的步骤见[远程访问](remote-access.md)的"更换服务端域名"。

托管实例现在不开放注册（ADR-0022），落地页上的 "Open the web app" 对访客来说只能看到登录页；开放注册前它主要给作者自己和已配对的设备用。
