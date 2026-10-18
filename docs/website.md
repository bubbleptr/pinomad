# 官网和托管实例

两个域名，两套独立部署：

| 域名 | 内容 | 部署 |
|---|---|---|
| `pinomad.si`（`www` 跳到根域名） | 落地页，`apps/site` 的静态构建，中英两份（`/`、`/zh/`） | Cloudflare Pages，接 GitHub，合进 `main` 自动发布 |
| `app.pinomad.si` | 托管的服务端：账号 API、中继、它自带的 Web 客户端 | Zeabur，`deploy/server/Dockerfile`，见[远程访问](remote-access.md)的"容器平台" |

落地页只是静态文件，不跟服务端共享代码和部署，也不跟 npm 版本走；服务端照旧托管和它同版本的 Web 客户端（ADR-0015 §4）。

## 开发

```sh
bun run site          # Vite 开发服务器，http://127.0.0.1:5299
cd apps/site && bun run build && bun run preview
```

页面是纯 HTML + CSS，加一点原生 JS 驱动示意动画，不用框架。图标直接引用 `apps/web/public/` 里的文件，构建时打上哈希，改图标时不用另外更新这里。截图放在 `apps/site/shots/`（中英各一份，`og-image.jpg` 是英文首屏图缩到 1920×1200），都是深色模式。每张有 2x 原图（`hero.webp` 2400×1500，功能截图 1120×840）和同名加 `-<宽>` 的 1x 版本，页面用 `srcset` 二选一。iPhone 那格还用 `partials/skeleton-phone.html` 占位，比例和最终截图一致，等原生 iOS 版替换验收（#133）后补。改文案时中英两页一起改，功能描述以两份 README 为准。`public/_headers` 是 Cloudflare Pages 的响应头（CSP 等），页面新加外部资源时要同步放行。

插画、示意图和图标只存一份，放在 `partials/`，页面里写 `<!-- include 文件名.svg -->`，由 `vite.config.js` 的 `partials` 插件在开发和构建时内联。片段里中英文各一份（`.zh` / `.en`），按页面的 `lang` 显示其中一种；所以 SVG 本身 `aria-hidden`，读屏用的描述写在各页面里。CSP 是 `style-src 'self'`，动画只能用样式表里的类、SVG 属性、SMIL 和 JS 的 CSSOM（`el.style.x = …`），不能写 `style=""` 或 `setAttribute("style", …)`；构建后可以 `grep -c 'style="' dist/index.html dist/zh/index.html` 确认是 0。

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

`--filter` 只装落地页需要的依赖（约 56 个包），不会拉 Electron、Expo 这些整个 workspace 的包。PR 会自动得到预览地址。先建好 Pages 项目再合并改动，合进 `main` 时生产环境才会跟着发布。

## app.pinomad.si

`app` 子域名的 DNS 记录在同一个 Cloudflare 区域里：A 记录指向 Zeabur 服务器 IP，**灰云**（和[远程访问](remote-access.md)里说的一样，证书由 Zeabur 签，橙云会让国内访问多绕一圈）。从旧域名迁过来的步骤见[远程访问](remote-access.md)的"更换服务端域名"。

托管实例现在不开放注册（ADR-0022），落地页上的 "Open the web app" 对访客来说只能看到登录页；开放注册前它主要给作者自己和已配对的设备用。
