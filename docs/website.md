# 官网和托管实例

两个域名，两套独立部署：

| 域名 | 内容 | 部署 |
|---|---|---|
| `pinomad.si`（`www` 跳到根域名） | 落地页、文档和博客，`apps/site` 的静态构建，中英两份（英文在根路径，中文在 `/zh/`） | Cloudflare Pages，接 GitHub，合进 `main` 自动发布 |
| `app.pinomad.si` | 托管的服务端：账号 API、中继、它自带的 Web 客户端 | 洛杉矶一台 VPS，npm 全局包 + systemd + Caddy，见下面的"app.pinomad.si"和[远程访问](https://pinomad.si/zh/docs/remote-access/)的"经自部署中继访问" |

官网只是静态文件，不跟服务端共享代码和部署，也不跟 npm 版本走；服务端照旧托管和它同版本的 Web 客户端（ADR-0015 §4）。

## 开发

```sh
bun run site          # 开发服务器，http://127.0.0.1:5299
cd apps/site && bun run build && bun run preview
```

官网是 TanStack Start 应用，构建时把所有页面预渲染成静态文件（`dist/`），线上不跑服务端；预渲染用的服务端产物在 `.output/server/`，不发布。英文在根路径，中文在 `/zh/` 下；网址一律以 `/` 结尾（页面输出成 `<路径>/index.html`，Pages 会把不带斜杠的地址 308 过去）。

- **落地页**：React 组件，在 `src/landing/`。文案在 `copy.tsx`，中英两份共用一个类型，缺了哪条 typecheck 就报错；改文案时两份一起改，功能描述以文档的 `features` 页为准。区块顺序和卖点见 #364：首屏、工作方式（本机运行、断点续跑、多端接入三格 bento）、具名 Agent、连接、接下来（还没上线的规划，虚线卡片，每项链到 issue）、开始使用。区块组件在 `sections.tsx`，有交互的单独成文件（`durable.tsx` 是"拔电源"示意图，`get-started.tsx` 带复制按钮和最新版本号，版本号由路由 loader 在预渲染时从更新日志取），页脚在 `site-footer.tsx`，页头元信息在 `meta.ts`。样式入口是 `landing.css`：页面自己的规则在 `page.css`，放在 `landing` 层里；Tailwind 的主题变量在它下面一层，utilities 在它上面一层，所以元素上的 utility 能盖过 `page.css` 的元素选择器。没有引 preflight（会改掉页面的默认样式），组件依赖的两条（`[hidden]` 和按钮继承字体）抄在 `landing.css` 末尾；Tailwind 只扫 `src/landing/` 和 `src/components/ui/`。截图放在 `apps/site/shots/`（中英各一份，都是深色模式），有 2x 原图（`subagents.webp` 1120×840）和同名加 `-<宽>` 的 1x 版本，页面用 `srcset` 二选一（`shots.ts`）。首屏不是截图，是 `src/landing/mock/` 里用 HTML 画的产品界面：后面是 Mac App（侧栏两台机器、后台子 Agent 挂在父对话下、对话里是 Agent 工作卡片），前面是同一个对话在浏览器里打开的样子；侧栏里的对话可以点着切换。内容在 `content.ts`（中英各一份，界面文字和真客户端一样保持英文），颜色和尺寸照 `apps/web` 的 Storybook 量的，长度都是 `--u`（1200px 宽窗口里的 1px）的倍数，所以随台面等比缩放；窄于 40rem 时只剩一个竖向的主窗口。全部内容都预渲染，没有 JS 或减弱动效时看到的就是完整画面；入场（卡片逐张出现、浏览器窗口升起、omarchy 掉线又恢复）是 `mock.css` 里的关键帧，脚本只管卡片计时。真客户端改了样子时照着更新这里。「出门在外」那一屏是 iPhone App 的真截图，套在 CSS 画的机身里（`mock/anywhere-phone.tsx`、`phone.css`：灰色细描边、黑边框、灵动岛、扁平侧键，照模拟器面板的样子）。左栏两个按钮换图：派活（`anywhere-start`）、拍板（先是首页列表上弹出的推送 `anywhere-banner`，1.8 秒后换成对话里的提问卡片 `anywhere-ask`）；三张叠在一起，只切透明度，预渲染出来的是第一张。截图是 iPhone 17 Pro 模拟器的整屏（1206×2622，保留状态栏，灵动岛画在状态栏的空当里），导出成 640 宽的 2x 和 `-320` 的 1x。重拍的做法：起两个临时宿主，数据目录的 `settings.json` 分别写 `{"hostName":"omarchy"}` 和 `{"hostName":"macbook-pro"}`，项目是两个小 git 仓库 `splitbill-api`（`src/bills.ts`、`src/db.ts`、`migrations/0041_ledgers.sql`）和 `splitbill`；omarchy 用脚本化的 faux 回复（按已有的 toolResult 条数出下一步：`bash` 跑 `git log … && sleep 45`，`read src/bills.ts`，一段说明加 `ask_user_question` 问回填和汇率两个问题，两次 `write` 改 `src/bills.ts` 并新建迁移，最后一句收尾；首条消息含中文就用中文措辞），macbook-pro 的 faux 先调一个 `sleep 3600` 的 `bash`，在 splitbill 下开两个对话，让首页显示 Running 2。faux 对话不自动起标题，用 `renameConversation` 改成 hero 里的 "Currency in the bills API" / "账单接口加币种"。自建一台模拟器，两台宿主都配对，在设置里打开推送并允许通知；每种语言新开一个对话，从同一个对话里依次截：运行中（Running bash）、回到首页后 `xcrun simctl push` 一条标题为对话名、正文 "Waiting for your answer" 的通知、点进去的提问卡片。同一种语言的三张要出自同一个对话，分支名和时间才对得上。模型图标是从 `apps/web` 复制的四个 LobeHub SVG（`mock/logos/`），去掉了内联 style，否则落地页的 CSP 要放开内联样式。图标直接引用 `apps/web/public/` 里的文件，构建时打上哈希。示意图的 SVG 是 `aria-hidden` 的，读屏用的描述写在文案里。
- **视觉**：三色是 Void Eclipse `#0B0B0B`、Abyss Blue `#2B3B79`、Silver Mist `#E4E4E4`，各有分工：银灰是底色，黑是正文，蓝是主题色（`--accent`：链接、焦点环、主按钮、页头按钮、区块编号）。页面是银灰底，中间一段整幅蓝底（`landing.tsx` 里的 `.zone-abyss`，"任何屏幕"和"连接"两节），前后是 `.zone-light`。蓝段的上下边不是直线，而是一段海岸（`.zone-abyss::before` / `::after`，下边是镜像并错开）：上面是银灰的"陆地"，下面是蓝，同一组等高线跨过两边，靠岸密、往外疏。这张图是 `src/landing/shore.svg`，由 `scripts/shore.ts` 用噪声场和 marching squares 算出来（`bun run --cwd apps/site shore` 重新生成，产物入库；种子固定，重跑结果不变），x 方向是周期的，页面按固定尺寸横向平铺而不是拉伸，所以再宽的屏幕线条也不会变粗变密。等高线是贯穿全页的母题：台面（位图）和蓝段的两条边（矢量）都是它；每段在 `page.css` 里重定义 `--bg`、`--fg`、`--surface`、`--accent` 等变量，组件只读这些变量。蓝段里主题色翻成银白（`--accent: var(--mist)`），所以蓝底上不会出现蓝按钮。首屏是银底上的标题，下面是一块台面托着产品界面。台面是共用的 `.plate`，浅底上的产品都站在它上面：首屏的窗口（`.hero-stage`）和"命名 agent"的截图（`.plate-shot`，和首屏窗口一样圆上角、从底边出画）。"出门在外"的手机不用台面：那一段页面本身就是同一种蓝，再套一块同色的台面只是个空框。台面背景是 Midjourney 生成的银色等高线图（`src/landing/hero-stage*.webp`，1x/2x 两档），按亮度做了渐变映射，底色正好是 Abyss、线条是 Silver Mist；换图时照同样的映射处理，免得台面和主题蓝成了两种蓝。终端卡片无论在哪段都是深底浅字；示意图默认是浅底深字，在 `.zone-abyss` 里换成蓝底那套 `--dg-*` 变量。页头固定是银底黑字。文档页（Fumadocs）的 `--color-fd-primary` 也是这个蓝，暗色主题下换成同色相的亮一档（`app.css`）。标题用 Geist Serif（自托管，`src/styles/fonts/`，`head.ts` 预加载），中文标题回退到宋体，Windows 上回退到雅黑（避免 SimSun）；正文仍是 Montserrat，标签用等宽字体，区块编号由 CSS 计数器生成。颗粒是 `src/landing/` 下的两张 PNG 平铺（256px 按 128px 画，2x 屏上一个点对应一个物理像素；银底用黑点那张，蓝底用白点那张，CSP 不允许 `data:` 图片），作为背景层叠在底色上，没有用固定定位的混合层。首屏从上到下是标题、导语、按钮、台面，规格行在台面下方，这样产品界面在第一屏就露出来。动效（首屏界面随滚动立起、首屏入场）都在 `prefers-reduced-motion: no-preference` 下才开。入场只有首屏有：文字部分的时间照 Linear 首页的入场：标题逐行、导语、按钮从 10px 模糊里上移一点对上焦（各 1s，0.4s 起依次错开 0.1s）；台面连同窗口作为一个整体在 0.7s 起用 1.2s 淡入（浅色页面上深色窗口先于台面出现会像闪了一下），窗口内容 1.5s 起再淡入，是 `page.css` 里的纯 CSS 关键帧（`intro-*`），不等脚本；首屏以下的内容不做滚动淡入。入场在每次整页加载时播一遍；`landing.tsx` 的 `useIntroOnce` 在播完后给 `<html>` 加 `data-intro-seen`，所以从文档或博客在客户端跳回首页时不再重播。首屏 mock 的计时（`hero-app.tsx` 的 `useClock`）要窗口露出一半才开始走。页脚底部是整宽的 PiNomad 字标，从黑渐变到蓝。
- **组件库**：`apps/site/components.json` 是 shadcn 的配置，选的是 Base UI 风格（`base-vega`，和 Fumadocs 用的同一个 Base UI，版本钉在锁文件里已有的那个）。用 `bunx shadcn add <组件>` 把组件源码复制进 `src/components/ui/`，再按落地页的样子改：shadcn 的主题名（`bg-primary`、`border-input` 等）在 `landing.css` 里映射到页面自己的变量（落地页按区块换一套变量值，见下面的"视觉"）。`button.tsx` 就是这样改过来的，链接要按钮样式时用 `buttonVariants()` 套在普通 `<a>` 上。React Bits 也走 shadcn 注册表（`@react-bits/<名字>-TS-TW`），但许可不是普通开源许可：免费版是 MIT 加 Commons Clause（可以作为网站的一部分使用，不能把组件本身再分发），Pro 版的许可明确禁止把组件放进开源仓库。这个仓库是公开的，Pro 组件不能入库；免费组件入库前先定好许可怎么标注（#360）。不要在 `apps/site` 里跑 `shadcn init`，`add` 之后也要看一眼 `landing.css` 的改动：CLI 会往里加 `@import` 和 `body`、`*` 上的基础样式，文档页和落地页都会跟着变。
- **页头**：全站只有一个 `src/components/site-header.tsx`，落地页直接渲染，文档、博客、更新日志和 404 通过 Fumadocs 布局的 `slots.header` 换掉它自带的页头（`shell.tsx`；文档页用 notebook 布局的 `nav.mode: "top"`，侧栏在页头下面）。链接文字在 `src/lib/nav.ts`，不放页内锚点。样式是普通 CSS（`site-header.css`），落地页的 `landing.css` 和文档的 `app.css` 都引入它，各自把颜色映射到 `--header-*` 变量，所以文档页的页头跟着明暗主题走；落地页的页头固定是银底黑字，右侧按钮用主题蓝；字体统一用 Montserrat（`src/styles/montserrat.css`）。搜索、主题切换和文档侧栏按钮只在 Fumadocs 页面上有，作为 `tools` 传进去，排在固定的语言、GitHub、登录前面。窄屏下链接收进菜单，菜单是原生 popover，不需要客户端脚本（404 页面没有脚本）。
- **文档和博客**用 Fumadocs：内容在 `content/docs/`、`content/blog/`。用户文档以这里为准，仓库里的 `docs/usage.md` 等只是指向官网的链接，README 只留快速上手；中文版是同名加 `.zh` 的文件（`index.zh.mdx`），没有中文版的页面在中文站显示英文版。侧栏顺序在 `content/docs/meta.json`。搜索索引在构建时生成为 `/api/search.json`，在浏览器里搜。
- **更新日志**：`content/changelog/` 每个版本一个文件（`v0.7.0.mdx`，中文版 `v0.7.0.zh.mdx`），frontmatter 写 `title`、`version`、`date`，正文写给用户看的变化，不照搬 GitHub Release 自动生成的 PR 列表。`/changelog/` 一页按日期倒序列出全部版本，每条链到对应的 GitHub Release。
- **隐私政策和服务条款**：`content/legal/` 的 `privacy`、`terms`（中文同样加 `.zh`），frontmatter 写 `title`、`description`、`date`（生效日期，改内容时一起改）。路径固定在 `/privacy/`、`/terms/`、`/zh/privacy/`、`/zh/terms/`，iOS 账号页和 App Store Connect 都填这几个地址，不要挪。只覆盖官方实例；内容要和服务端实际存的东西对得上，改了 `apps/server` 的表、保留期或日志时回来核对。落地页页脚有链接；四个路径也写在 `vite.config.ts` 的 `pages` 里，不靠爬取。
- **404**：`/404/`、`/zh/404/` 两个路由预渲染后由 `scripts/not-found.ts` 改名成 `404.html`、`zh/404.html`，并去掉全部客户端脚本（Pages 会在任意缺失的地址上返回它们，路由不能拿那个地址去接管）。Pages 用离请求路径最近的 `404.html`，状态码 404，所以 `/zh/` 下缺页显示中文版。页内跳转到不存在的页面时，加载器先查内容索引再取数据，显示同一个 `NotFound` 组件；语言切换对应语言没有这一页时，落到那个语言的文档或博客首页。
- **SEO**：首页、文档、博客和更新日志页在 `head` 里写自引用的 canonical 和 hreflang（`src/lib/seo.ts`）；中英都有的页面给 en / zh-CN / x-default，只有中文的页面只给 zh-CN。首页在 `meta.ts` 里输出 `SoftwareApplication` 的 JSON-LD，`softwareVersion` 来自更新日志 loader。构建最后 `scripts/sitemap.ts` 扫描 `dist/` 下实际生成的页面写 `dist/sitemap.xml`，同样只给真实存在的语言版本；构建时拿不到可靠的页面修改时间，所以不写 `lastmod`。路由 loader 由 `vite.config.ts` 的 `codeSplittingOptions` 拆成单独 chunk，首页不预加载文档、博客和更新日志的代码。
- **OG 图**：根路由给所有页面写 `og:image`（`public/og.jpg`，1200×630）和 `summary_large_image` 卡片（`src/lib/seo.ts` 的 `socialImageMeta`），页面自己写同名 meta 会覆盖它。图在 `apps/site` 下用 `bun run og`（`scripts/og.ts`）从 `og/` 生成：背景是 Midjourney 出的天空（`bg-b1.png`、`bg-a3.png`，`--ar 40:21 --style raw --stylize 50`），logo 由 ictool 从 `apps/desktop/build/icon.icon` 导出亮色版，产品名用 Geist Serif / Geist Pixel（许可见 `docs/licenses/geist.md`），由 `serif.html`、`pixel.html` 排版后用 Playwright 截图。脚本把四张候选和并排的 `compare.png` 写到 `og/out/`（不入库），网站用 1 号（B1 背景、衬线字、云拖影），复制成 `public/og.jpg`；换图改脚本里的 `siteImage`，换成像素版时它是 PNG，`socialImageMeta` 的地址和 `og:image:type` 要一起改。颗粒用固定种子，同样的输入重跑结果逐字节相同。需要 macOS 加 Xcode、ImageMagick 和 Playwright 的 Chromium。X 等平台会缓存卡片图，换图后旧图可能还要过几天才更新。
- **登录入口**：页头的"登录"指向 `app.pinomad.si`。Web 端给用过它的浏览器在 `pinomad.si` 上写 `pinomad_app=1`，`public/app-hint.js` 读到后把它改成"打开 Web 端"，首页（`/`、`/zh/`）直接跳到 Web 端；带 `?home` 时不跳。

**CSP**：页面里有框架写的内联脚本（水合用的路由状态、文档的主题切换），内容每次构建都变。JSON-LD 是非执行的 `application/ld+json` 数据块，`scripts/csp.ts` 收集内联脚本哈希时会跳过非 JS 类型。`public/_headers` 因此给 `script-src` 和 `style-src` 留了 `'unsafe-inline'`，构建最后一步 `scripts/csp.ts` 给每个页面在 `<head>` 最前面写一条 `<meta>` CSP，只放行这一页内联脚本的哈希；浏览器两条策略都要满足，所以实际只有哈希对得上的内联脚本能跑。落地页没有 `style=""`，样式也只认哈希：组件不用 `style` prop（预渲染会把它写成 `style=""`），动画只能用样式表里的类、SVG 属性、SMIL 和在 effect 里写的 CSSOM（`el.style.x = …`）。哪天落地页用了带内联样式的组件，`csp.ts` 会自动把它归到放开内联样式的那类，构建不会报错，所以要看构建最后一行的计数；文档和博客页的代码高亮和组件带 `style=""`，这些页面放开内联样式。页面新加外部资源时要同步改 `_headers`。

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

跑在洛杉矶的一台 CN2 GIA 线路 VPS 上，国内外用户共用：到美东约 70ms、欧洲约 140ms、东亚约 100–150ms，国内走 CN2 GIA 回国线路。服务端只能单实例（中继的转接状态在内存里，数据目录有锁）。

- `app` 子域名的 DNS 记录在同一个 Cloudflare 区域里：A 记录指向这台 VPS（地址不写进仓库），**灰云**（橙云会让国内访问多绕一圈，Caddy 的证书验证也会被挡在 Cloudflare 那边）。
- 服务端是全局装的 npm 包（版本和宿主一起升，见[远程访问](https://pinomad.si/zh/docs/remote-access/)的"升级"），系统级单元 `pinomad-server.service`，以 `pinomad` 用户运行，数据目录 `/var/lib/pinomad/server`。APNs 变量在 `/etc/pinomad-server.env`（root、600）。
- Caddy 用官方 apt 源，`/etc/caddy/Caddyfile` 反代到 `127.0.0.1:7430`，自动签证书。
- 看日志：`journalctl -u pinomad-server`、`journalctl -u caddy`。

从别的机器搬过来的步骤见[远程访问](https://pinomad.si/zh/docs/remote-access/)的"搬到另一台机器"，换域名见"更换服务端域名"。

托管实例凭邀请码注册（#449）：管理员在账号面板的 Invites 里生成邀请码，没有邀请码的访客点落地页上的 "Open the web app" 只能看到登录页。

### 发版与升级

前几次发版都是照着 git 历史拼出来的，按这个顺序做：

1. 更新日志写成 `apps/site/content/changelog/vX.Y.Z.mdx` 和 `vX.Y.Z.zh.mdx`，走 PR 合入（main 有分支保护，见 AGENTS.md），提交标题为 `chore(release): changelog for vX.Y.Z`。
2. 给 main 打 `vX.Y.Z` 标签并推送。`release.yml` 会跑全量测试、签名打包桌面端、检查安装脚本，最后 `gh release create` 并 `npm publish`。等 `npm view pinomad dist-tags` 里 `latest` 变成新版本，再动服务器。
3. VPS 上先停服务端，备份数据目录和环境变量文件（`/var/lib/pinomad/server`、`/etc/pinomad-server.env`，备份名带版本号），再 `npm i -g pinomad@X.Y.Z`、`systemctl start pinomad-server`。ssh 目标不写进仓库，问用户或查 nmem。
4. 验证：`journalctl -u pinomad-server` 里有 `{"event":"ready",…}`；`curl -s -o /dev/null -w '%{http_code}' https://app.pinomad.si/api/me` 返回 `401`（服务在、要登录）；再用一台真实宿主走一遍 join。
5. 宿主一起升级（`pinomad upgrade`，或 omarchy 上非登录 shell 用 `bash -lc 'pinomad upgrade'`：pinomad 装在 mise 的 Node 下）。
6. 把 `deploy/server/Dockerfile` 的 `ARG PINOMAD_VERSION` 改成新版本，同样走 PR，标题 `chore(deploy): run the server image on pinomad X.Y.Z`。
